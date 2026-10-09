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
  const equal = timingSafeEqual(paddedA, paddedB);
  return a.length === b.length && equal;
}
