#!/usr/bin/env node
/** Aligns release manifests; Electrobun reads its version from its own manifest. */
import fs from "node:fs";
import path from "node:path";
import { resolveElectrobunDir, resolveMainAppDir } from "./lib/app-dir.ts";

const version = process.env.RELEASE_VERSION?.trim();
if (!version)
  throw new Error("RELEASE_VERSION environment variable is required");
const root = process.cwd();
const appDir = resolveMainAppDir(root, "app");
const electrobunDir = resolveElectrobunDir(root);
const relativePlatform = path.relative(root, electrobunDir);
if (
  relativePlatform === ".." ||
  relativePlatform.startsWith(`..${path.sep}`) ||
  path.isAbsolute(relativePlatform)
) {
  throw new Error(
    `Refusing to change a release manifest outside ${root}: ${electrobunDir}`,
  );
}
// Parse every input before writing anything. A missing or malformed manifest
// must fail the release step instead of silently stamping only some packages.
const updates = [
  path.join(root, "package.json"),
  path.join(appDir, "package.json"),
  path.join(electrobunDir, "package.json"),
].map((file) => {
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg))
    throw new Error(`Invalid package manifest: ${file}`);
  return {
    file,
    contents: `${JSON.stringify({ ...pkg, version }, null, 2)}\n`,
  };
});
for (const { file, contents } of updates) fs.writeFileSync(file, contents);
