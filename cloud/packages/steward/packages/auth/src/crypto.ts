import { createHash } from "node:crypto";

export function hashSha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
