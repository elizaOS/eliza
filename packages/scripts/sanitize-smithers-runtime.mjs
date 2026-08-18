#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const packageRequire = createRequire(
  path.join(
    repositoryRoot,
    "plugins",
    "plugin-agent-orchestrator",
    "package.json",
  ),
);
const packageRoot = (entrypoint) => {
  let current = path.dirname(realpathSync(entrypoint));
  for (;;) {
    if (existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current)
      throw new Error(`Package root not found for ${entrypoint}`);
    current = parent;
  }
};
const readManifest = (root) =>
  JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const smithersRoot = packageRoot(packageRequire.resolve("smthrs"));
const smithersManifest = readManifest(smithersRoot);
if (smithersManifest.version !== "0.34.0") {
  throw new Error(
    `Refusing to sanitize unreviewed Smithers version ${String(smithersManifest.version)}`,
  );
}
const smithersRequire = createRequire(path.join(smithersRoot, "package.json"));
const agentsRoot = packageRoot(smithersRequire.resolve("@smthrs/agents"));
const agentsManifest = readManifest(agentsRoot);
if (agentsManifest.version !== "0.34.0") {
  throw new Error(
    `Refusing to sanitize unreviewed Smithers agents version ${String(agentsManifest.version)}`,
  );
}

const retiredAgentStem = ["Open", "Code", "Agent"].join("");
const targets = [
  path.join(agentsRoot, "src", `${retiredAgentStem}.js`),
  path.join(agentsRoot, "src", `${retiredAgentStem}Options.ts`),
  path.join(smithersRoot, "docs", "llms-full.txt"),
  path.join(smithersRoot, "src", "bin", "smithers.js"),
  path.join(smithersRoot, "..", "@smthrs", "cli"),
  path.join(
    repositoryRoot,
    "plugins",
    "plugin-agent-orchestrator",
    "node_modules",
    ".bin",
    "smithers",
  ),
  path.join(
    repositoryRoot,
    "plugins",
    "plugin-workflow",
    "node_modules",
    ".bin",
    "smithers",
  ),
];

for (const target of targets) {
  await rm(target, { force: true, recursive: false });
}

if (smithersManifest.bin || smithersManifest.dependencies?.["@smthrs/cli"]) {
  throw new Error("The patched Smithers manifest still exposes its vendor CLI");
}

console.log(
  "[sanitize-smithers-runtime] removed retired coding-agent and CLI surfaces",
);
