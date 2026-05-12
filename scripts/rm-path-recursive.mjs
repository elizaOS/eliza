#!/usr/bin/env node
/**
 * Remove a path recursively. Uses fs.rmSync for reliable deletion on
 * macOS/APFS under parallel builds (shell rm -rf can sporadically fail with
 * "Directory not empty" when the tree is huge or files are busy).
 */
import { rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const rel = process.argv[2];
if (!rel) {
  console.error("usage: node scripts/rm-path-recursive.mjs <path>");
  process.exit(1);
}
const target = path.resolve(process.cwd(), rel);
const retryableCodes = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

for (let attempt = 0; attempt < 5; attempt += 1) {
  try {
    rmSync(target, { recursive: true, force: true });
    process.exit(0);
  } catch (e) {
    const code =
      e && typeof e === "object" && "code" in e ? e.code : undefined;
    if (code === "ENOENT") {
      process.exit(0);
    }
    if (
      typeof code === "string" &&
      retryableCodes.has(code) &&
      attempt < 4
    ) {
      await delay(50 * (attempt + 1));
      continue;
    }
    throw e;
  }
}
