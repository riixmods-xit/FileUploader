// api/upload.js — Vercel serverless, Node 18+
// Multipart parser minimal, tanpa dependency eksternal.
// Simpan file ke /tmp (ephemeral), balas metadata + link.
// Catatan: /tmp tidak persist antar invocation. Untuk storage permanen,
// ganti blok "storage" dengan Vercel Blob / S3 / R2 SDK.

export const config = { api: { bodyParser: false } };

const ALLOWED = ['.apk', '.zip', '.7z', '.txt', '.json', '.dll'];
const MAX_BYTES = 4 * 1024 * 1024;

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) { req.destroy(); reject(new Error('BODY_TOO_LARGE')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buf, boundary) {
  const b = Buffer.from('--' + boundary);
  const parts = [];
  let i = buf.indexOf(b);
  while (i !== -1) {
    const start = i + b.length;
    const next = buf.indexOf(b, start);
    if (next === -1) break;
    const chunk = buf.slice(start + 2, next - 2); // skip \r\n ... \r\n
    const headEnd = chunk.indexOf('\r\n\r\n');
    if (headEnd !== -1) {
      const rawHead = chunk.slice(0, headEnd).toString('utf8');
      const body = chunk.slice(headEnd + 4);
      const nameM = /name="([^"]+)"/.exec(rawHead);
      const fileM = /filename="([^"]*)"/.exec(rawHead);
      parts.push({ name: nameM ? nameM[1] : '', filename: fileM ? fileM[1] : null, data: body });
    }
    i = next;
  }
  return parts;
}

function sanitize(s) {
  return String(s || '').replace(/[^\w.\-]+/g, '_').slice(0, 64);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }
  const ct = req.headers['content-type'] || '';
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!m) { res.status(400).json({ ok: false, error: 'Missing multipart boundary' }); return; }
  const boundary = m[1] || m[2];

  let body;
  try {
    body = await readBody(req, MAX_BYTES + 64 * 1024);
  } catch (e) {
    res.status(413).json({ ok: false, error: 'Payload too large (4 MB max)' });
    return;
  }

  let parts;
  try { parts = parseMultipart(body, boundary); }
  catch (e) { res.status(400).json({ ok: false, error: 'Malformed multipart' }); return; }

  const filePart = parts.find((p) => p.filename && p.name === 'file');
  const customPart = parts.find((p) => p.name === 'custom');
  if (!filePart) { res.status(400).json({ ok: false, error: 'No file field' }); return; }

  const name = sanitize(filePart.filename);
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot).toLowerCase();
  if (!ALLOWED.includes(ext)) {
    res.status(415).json({ ok: false, error: 'Unsupported file type: ' + ext });
    return;
  }
  if (filePart.data.length > MAX_BYTES) {
    res.status(413).json({ ok: false, error: 'File too large (4 MB max)' });
    return;
  }

  const custom = sanitize((customPart && customPart.data.toString('utf8')) || '') || name.replace(/\.[^.]+$/, '');
  const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

  // ---- storage (ephemeral /tmp; swap for Blob/S3/R2 for persistence) ----
  const fs = await import('fs/promises');
  const path = '/tmp/' + id + '-' + name;
  try { await fs.writeFile(path, filePart.data); }
  catch (e) { res.status(500).json({ ok: false, error: 'Storage write failed' }); return; }
  // ----------------------------------------------------------------------

  res.status(200).json({
    ok: true,
    id,
    name,
    custom,
    size: filePart.data.length,
    ext,
    url: '/' + custom + '/' + name,
    stored: path,
    note: 'Vercel /tmp is ephemeral — persistent storage requires Blob/S3/R2 wiring.'
  });
  }
