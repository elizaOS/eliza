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

/**
 * The padded comparison itself, injectable so tests can prove it runs for
 * every input instead of only where a fast path lets it.
 */
export type TimingSafeBufferCompare = (a: Buffer, b: Buffer) => boolean;

export function browserSignTokenMatches(
  expected: string,
  provided: string,
  compare: TimingSafeBufferCompare = timingSafeEqual,
): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  const length = Math.max(a.length, b.length);
  const paddedA = Buffer.alloc(length);
  const paddedB = Buffer.alloc(length);
  a.copy(paddedA);
  b.copy(paddedB);
  // The safe comparison runs before the length decision. Gating it on
  // `a.length === b.length` would let mismatched-length probes skip the work
  // entirely and measure the expected token's length through timing.
  const equal = compare(paddedA, paddedB);
  return a.length === b.length && equal;
}
