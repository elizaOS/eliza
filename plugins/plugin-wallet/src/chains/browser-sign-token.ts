/**
 * Constant-time comparison for the shared browser signing bearer token
 * (`WALLET_BROWSER_SIGN_TOKEN`) that gates the Solana and EVM browser-signing
 * routes. The routes deliberately reflect loopback origins (#9948), so a
 * co-resident local page can read responses; a plain string comparison would
 * let it probe the signing credential one character at a time. This mirrors
 * the padded `tokenMatches` contract the agent API applies to every other
 * agent credential, so comparison time reveals neither content nor length.
 */
import { timingSafeEqual } from "node:crypto";

export function browserSignTokenMatches(
  expected: string,
  provided: string,
): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  const length = Math.max(a.length, b.length);
  const paddedA = Buffer.alloc(length);
  const paddedB = Buffer.alloc(length);
  a.copy(paddedA);
  b.copy(paddedB);
  return a.length === b.length && timingSafeEqual(paddedA, paddedB);
}
