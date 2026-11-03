import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/** A token made only of v, a, l, and h that is not the product name. */
function isMisspelled(word: string): boolean {
  const text = word.toLowerCase();
  if (text === "valhalla") return false;
  if (text.length < 6 || text.length > 12) return false;
  if (!text.startsWith("va")) return false;
  if (!/^v[ahl]+$/.test(text)) return false;
  return text.includes("h") && text.includes("l");
}

function words(buf: Buffer): string[] {
  return buf.toString("utf8").match(/[A-Za-z]+/g) ?? [];
}

function main(): void {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const listed = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = listed
    .toString("utf8")
    .split("\0")
    .filter((name) => name.length > 0 && !name.endsWith("scripts/spell-valhalla.ts"));
  const hits: string[] = [];
  for (const file of files) {
    let buf: Buffer;
    try {
      buf = readFileSync(path.join(root, file));
    } catch {
      continue;
    }
    const found = new Set(words(buf).filter(isMisspelled));
    for (const word of found) hits.push(`${file}: ${word}`);
  }
  if (hits.length > 0) {
    process.stderr.write(`Valhalla spelling check failed\n${hits.join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`Valhalla spelling check passed (${files.length} files)\n`);
}

main();
