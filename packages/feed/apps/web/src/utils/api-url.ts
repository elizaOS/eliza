/**
 * Resolves relative API paths to absolute URLs when NEXT_PUBLIC_API_URL is set.
 *
 * - Web (same-origin): NEXT_PUBLIC_API_URL unset → returns path as-is
 * - Mobile (cross-origin): NEXT_PUBLIC_API_URL set → returns full URL
 *
 * The env var is inlined at build time by Next.js (NEXT_PUBLIC_ prefix).
 */

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(
  /\/+$/,
  ''
);

export function apiUrl(path: string): string {
  if (!API_BASE_URL) return path;
  if (!path) return API_BASE_URL;
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}
