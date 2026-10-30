import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Vercel Functions reject request bodies larger than 4.5 MB. Each original MP4
// chunk is 3 MiB and is stored byte-for-byte in PRIVATE Blob, never in GitHub.
export const SEGMENT_BYTES = 3 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
export const DELIVERY_BYTES = 2 * 1024 * 1024;
const TICKET_TTL_MS = 4 * 60 * 60 * 1000;

export function validVideoSize(size) {
  return Number.isSafeInteger(size) && size >= 128 && size <= MAX_VIDEO_BYTES;
}

export function makeUploadTicket(size, secret, timestamp = Date.now()) {
  if (!validVideoSize(size)) throw new Error('The selected MP4 is outside the supported size range.');
  if (typeof secret !== 'string' || secret.length < 40) throw new Error('Upload signing secret missing.');
  const info = { v: 1, id: randomBytes(16).toString('hex'), size, exp: timestamp + TICKET_TTL_MS };
  const payload = Buffer.from(JSON.stringify(info)).toString('base64url');
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return { ticket: payload + '.' + mac, id: info.id, size, partBytes: SEGMENT_BYTES, partCount: Math.ceil(size / SEGMENT_BYTES) };
}

export function readUploadTicket(ticket, secret, timestamp = Date.now()) {
  if (typeof ticket !== 'string' || ticket.length > 500 || typeof secret !== 'string' || secret.length < 40) return null;
  const m = /^([A-Za-z0-9_-]{30,300})\.([A-Za-z0-9_-]{43})$/.exec(ticket);
  if (!m) return null;
  const expected = createHmac('sha256', secret).update(m[1]).digest();
  const supplied = Buffer.from(m[2], 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const info = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    if (info.v !== 1 || !/^[0-9a-f]{32}$/.test(info.id) || !validVideoSize(info.size) ||
        !Number.isSafeInteger(info.exp) || timestamp > info.exp || timestamp < info.exp - TICKET_TTL_MS - 60_000) return null;
    return { id: info.id, size: info.size, partBytes: SEGMENT_BYTES, partCount: Math.ceil(info.size / SEGMENT_BYTES) };
  } catch { return null; }
}

export function expectedSegmentBytes(session, index) {
  if (!session || !Number.isInteger(index) || index < 0 || index >= session.partCount) return null;
  return Math.min(session.partBytes, session.size - index * session.partBytes);
}

export function partPath(session, index) {
  if (!session || !/^[0-9a-f]{32}$/.test(session.id) || expectedSegmentBytes(session, index) === null) {
    throw new Error('Invalid segment identifier');
  }
  return 'video-segments/' + session.id + '/part-' + String(index).padStart(4, '0') + '.bin';
}

export function parseVideoRange(raw, size, maxBytes = DELIVERY_BYTES) {
  if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return null;
  if (raw === undefined || raw === null || raw === '') return { start: 0, end: Math.min(size, maxBytes) - 1 };
  if (typeof raw !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!m || (!m[1] && !m[2])) return null;
  let start, end;
  if (!m[1]) {
    const tail = Number(m[2]);
    if (!Number.isSafeInteger(tail) || tail < 1) return null;
    start = Math.max(0, size - tail);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Number(m[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || start >= size) return null;
  }
  return { start, end: Math.min(end, size - 1, start + maxBytes - 1) };
}

export function videoSegmentSlices(start, end, segmentBytes = SEGMENT_BYTES) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || start < 0 ||
      !Number.isSafeInteger(segmentBytes) || segmentBytes < 1) throw new Error('Invalid byte range');
  const slices = [];
  for (let offset = start; offset <= end;) {
    const index = Math.floor(offset / segmentBytes);
    const inPart = offset - index * segmentBytes;
    const last = Math.min(segmentBytes - 1, inPart + (end - offset));
    slices.push({ index, start: inPart, end: last, length: last - inPart + 1 });
    offset += last - inPart + 1;
  }
  return slices;
}
