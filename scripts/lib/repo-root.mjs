import path from "node:path";
import { fileURLToPath } from "node:url";

export function getModuleDir(importMetaUrl) {
  return path.dirname(fileURLToPath(importMetaUrl));
}

export function resolveRepoRoot(importMetaUrl, depth = 1) {
  return path.resolve(
    getModuleDir(importMetaUrl),
    ...Array.from({ length: depth }, () => ".."),
  );
}
