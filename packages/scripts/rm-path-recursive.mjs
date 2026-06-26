#!/usr/bin/env node
/**
 * Remove a path recursively. Uses fs.rmSync for reliable deletion on
 * macOS/APFS under parallel builds (shell rm -rf can sporadically fail with
 * "Directory not empty" when the tree is huge or files are busy).
 */
import { rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const rels = process.argv.slice(2);
if (rels.length === 0) {
  console.error(
    "usage: node packages/scripts/rm-path-recursive.mjs <path> [path...]",
  );
  process.exit(1);
}
const retryableCodes = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

const maxAttempts = 10;
const cwd = process.cwd();

function resolveTarget(rel) {
  if (rel.length === 0) {
    throw new Error("Refusing to remove an empty path argument.");
  }

  const target = path.resolve(cwd, rel);
  if (target === cwd) {
    throw new Error(`Refusing to remove the current working directory: ${rel}`);
  }
  if (target === path.parse(target).root) {
    throw new Error(`Refusing to remove a filesystem root: ${rel}`);
  }

  return target;
}

const targets = rels.map(resolveTarget);

async function removePath(target) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      rmSync(target, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
      return;
    } catch (e) {
      const code =
        e && typeof e === "object" && "code" in e ? e.code : undefined;
      if (code === "ENOENT") {
        return;
      }
      if (
        typeof code === "string" &&
        retryableCodes.has(code) &&
        attempt < maxAttempts - 1
      ) {
        await delay(100 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
}

for (const target of targets) {
  await removePath(target);
}
