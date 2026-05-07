#!/usr/bin/env node
/**
 * Remove a path recursively. Uses fs.rmSync for reliable deletion on
 * macOS/APFS under parallel builds (shell rm -rf can sporadically fail with
 * "Directory not empty" when the tree is huge or files are busy).
 */
import { rmSync } from "node:fs";
import path from "node:path";

const rel = process.argv[2];
if (!rel) {
  console.error("usage: node scripts/rm-path-recursive.mjs <path>");
  process.exit(1);
}
const target = path.resolve(process.cwd(), rel);
try {
  rmSync(target, { recursive: true, force: true });
} catch (e) {
  const code = e && typeof e === "object" && "code" in e ? e.code : undefined;
  if (code !== "ENOENT") {
    throw e;
  }
}
