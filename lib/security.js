import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const uid = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const now = () => Date.now();

export function passwordMatches(password, encoded) {
  const m = /^scrypt:([0-9a-f]{32}):([0-9a-f]{128})$/.exec(encoded || '');
  if (!m || typeof password !== 'string' || password.length > 1000) return false;
  const result = scryptSync(password, Buffer.from(m[1], 'hex'), 64);
  return timingSafeEqual(result, Buffer.from(m[2], 'hex'));
}

export function mintAdminCookie(secret, expireAt = now() + 8 * 3600000) {
  if (!secret || secret.length < 40) throw new Error('SESSION_SECRET is not configured');
  const payload = `${expireAt}.${uid()}`;
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function checkAdminCookie(cookie, secret) {
  if (!secret || secret.length < 40 || typeof cookie !== 'string') return false;
  const m = /^(\d{13})\.([a-zA-Z0-9_-]{43})\.([a-zA-Z0-9_-]{43})$/.exec(cookie);
  if (!m || Number(m[1]) <= now()) return false;
  const payload = `${m[1]}.${m[2]}`;
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return timingSafeEqual(Buffer.from(m[3]), Buffer.from(mac));
}

export function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.includes('=')).map(s => {
    const n = s.indexOf('='); return [s.slice(0, n), s.slice(n + 1)];
  }));
}

export function publicCustomer(c) {
  return {
    id:c.id, name:c.name, active:c.active, activatedAt:c.activatedAt,
    createdAt:c.createdAt, expiresAt:c.expiresAt,
    status: !c.active ? 'revoked' : c.expiresAt <= now() ? 'expired' : c.activatedAt ? 'activated' : 'pending',
  };
}

export function validHours(hours) { return Number.isInteger(hours) && hours >= 1 && hours <= 720; }
export const CUSTOMER_ID = /^CUS-[A-F0-9]{8}$/;
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export function splitCustomerToken(value) {
  if (typeof value !== 'string') return null;
  const m = /^(CUS-[A-F0-9]{8})\.([A-Za-z0-9_-]{43})$/.exec(value);
  return m ? { id:m[1], token:m[2] } : null;
}
