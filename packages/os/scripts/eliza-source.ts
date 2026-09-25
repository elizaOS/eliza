#!/usr/bin/env node
/** Resolves the application checkout shared by OS builders and asset generators. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

export function resolveElizaSourceRoot({
  osRoot = packageRoot,
  env = process.env,
} = {}) {
  const explicit = env.ELIZAOS_ELIZA_ROOT;
  if (explicit !== undefined && explicit.trim() === "") {
    throw new Error("ELIZAOS_ELIZA_ROOT must be a non-empty checkout path.");
  }
  const workspaceRoot = path.resolve(osRoot, "../..");
  const candidate =
    explicit !== undefined
      ? path.resolve(explicit)
      : existsSync(path.join(workspaceRoot, "packages/app/package.json"))
        ? workspaceRoot
        : path.join(osRoot, ".eliza-source");
  const manifest = path.join(candidate, "packages/app/package.json");
  if (!existsSync(manifest)) {
    throw new Error(
      `Missing Eliza application at ${manifest}; set ELIZAOS_ELIZA_ROOT to its checkout.`,
    );
  }
  if (JSON.parse(readFileSync(manifest, "utf8")).name !== "@elizaos/app") {
    throw new Error(`Expected @elizaos/app in ${manifest}.`);
  }
  return realpathSync(candidate);
}

if (import.meta.main) {
  process.stdout.write(`${resolveElizaSourceRoot()}\n`);
}
