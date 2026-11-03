import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * SHA-256 of known personal and bot wallet addresses.
 * The plaintext addresses are not stored in this file.
 */
const FORBIDDEN = new Set([
  "fa0ce3967c91482aff511285e1d487ecdbe03f66cdd6a38cec4847f15852715a",
  "33941bb78a47eba0ff6ea1402ebdf076aecc00edd0bff5883f472c6d486a95e3",
  "ad42f9a6f4190e0ef95114adef1ae039f518ce415600935c2a83cafed40c90c1",
]);

const BASE58 = /[1-9A-HJ-NP-Za-km-z]/;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isBase58Char(code: number): boolean {
  return BASE58.test(String.fromCharCode(code));
}

function consider(token: string, hits: Set<string>): void {
  if (token.length >= 32 && token.length <= 44 && FORBIDDEN.has(digest(token))) {
    hits.add(digest(token));
    return;
  }
  if (token.length <= 44) return;
  for (let index = 0; index + 44 <= token.length; index += 1) {
    const window = token.slice(index, index + 44);
    if (FORBIDDEN.has(digest(window))) hits.add(digest(window));
  }
}

function runsFromLatin1(buf: Buffer): string[] {
  const text = buf.toString("latin1");
  return text.match(/[1-9A-HJ-NP-Za-km-z]{32,}/g) ?? [];
}

function runsFromUtf16(buf: Buffer, bigEndian: boolean): string[] {
  const runs: string[] = [];
  let current = "";
  for (let index = 0; index < buf.length; ) {
    const first = buf[index];
    const second = buf[index + 1];
    const hi = bigEndian ? first : second;
    const lo = bigEndian ? second : first;
    if (hi === 0 && lo !== undefined && isBase58Char(lo)) {
      current += String.fromCharCode(lo);
      index += 2;
      continue;
    }
    if (current.length >= 32) runs.push(current);
    current = "";
    index += 1;
  }
  if (current.length >= 32) runs.push(current);
  return runs;
}

function scan(buf: Buffer): string[] {
  const hits = new Set<string>();
  for (const token of runsFromLatin1(buf)) consider(token, hits);
  for (const token of runsFromUtf16(buf, false)) consider(token, hits);
  for (const token of runsFromUtf16(buf, true)) consider(token, hits);
  return [...hits];
}

function trackedFiles(root: string): string[] {
  const listed = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return listed
    .toString("utf8")
    .split("\0")
    .filter((name) => name.length > 0);
}

function main(): void {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const extra = process.argv.slice(2);
  const files = [...trackedFiles(root), ...extra];
  const failures: string[] = [];
  for (const file of files) {
    const full = path.isAbsolute(file) ? file : path.join(root, file);
    let buf: Buffer;
    try {
      const info = statSync(full);
      if (!info.isFile()) continue;
      buf = readFileSync(full);
    } catch (err) {
      const code = typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
      if (code === "ENOENT" || code === "ELOOP") continue;
      failures.push(`${file}: unreadable`);
      continue;
    }
    const hits = scan(buf);
    for (const hit of hits) failures.push(`${file}: forbidden wallet ${hit}`);
  }
  if (failures.length > 0) {
    process.stderr.write(
      `Forbidden wallet check failed (${failures.length})\n${failures.join("\n")}\n`
    );
    process.exit(1);
  }
  process.stdout.write(`Forbidden wallet check passed (${files.length} files)\n`);
}

main();
