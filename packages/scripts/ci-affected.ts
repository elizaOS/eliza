#!/usr/bin/env node
/** Select retained CI lanes from the complete diff and reverse workspace graph. */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listPackages } from "./lib/workspaces.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const lanes = {
  auth: /^packages\/auth(?:\/|$)/,
  runtime:
    /^(?:packages\/(?:agent|testing)|plugins\/plugin-(?:assistant|personal-assistant))(?:\/|$)/,
  scenarios: /^packages\/testing(?:\/|$)/,
  providers: /^plugins\/plugin-(?:anthropic|discord|openai|embeddings)(?:\/|$)/,
  app: /^packages\/(?:app|ui)(?:\/|$)/,
  os: /^packages\/os(?:\/|$)/,
  cloud: /^(?:packages\/cloud|plugins\/plugin-elizacloud)(?:\/|$)/,
};

function git(args: string[]) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

const base = process.argv[2] ?? "";
const head = process.env.GITHUB_SHA || "HEAD";
const output = process.env.GITHUB_OUTPUT;
const packages = listPackages({ repoRoot });
const ordered = [...packages].sort((a, b) => b.dir.length - a.dir.length);
const affected = new Set<string>();
let full = !/^[0-9a-f]{40}$/.test(base) || /^0{40}$/.test(base);
let reason = full ? "missing or initial base" : "changed workspace closure";
let paths: string[] = [];
if (!full) {
  const ancestry = git(["merge-base", "--is-ancestor", base, head]);
  const diff = git(["diff", "--no-renames", "--name-only", "-z", base, head]);
  if (ancestry.status !== 0 || diff.status !== 0) {
    full = true;
    reason = "base unavailable or not an ancestor";
  } else {
    paths = diff.stdout.split("\0").filter(Boolean);
  }
}
for (const file of paths) {
  // Shared tooling/configuration can change any package's build or execution.
  if (
    /^(?:\.github\/|packages\/scripts\/|patches\/)/.test(file) ||
    (!file.includes("/") && !/\.(?:md|txt)$/.test(file))
  ) {
    full = true;
    reason = "shared CI, tooling, or root configuration changed";
    break;
  }
  if (/(?:^|\/)(?:README|AGENTS)\.md$/.test(file)) continue;
  const owner = ordered.find(
    ({ dir }) => file === dir || file.startsWith(`${dir}/`),
  );
  if (!owner?.name) {
    full = true;
    reason = `unowned input: ${file}`;
    break;
  }
  affected.add(owner.name);
}
let expanded = true;
while (expanded && !full) {
  expanded = false;
  for (const workspace of packages) {
    if (!workspace.name || affected.has(workspace.name)) continue;
    const dependencies = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ].flatMap((key) => Object.keys(workspace.packageJson[key] ?? {}));
    if (dependencies.some((name) => affected.has(name))) {
      affected.add(workspace.name);
      expanded = true;
    }
  }
}
const directories = packages
  .filter(({ name }) => name && affected.has(name))
  .map(({ dir }) => dir);
const results: Record<string, string> = {
  full: String(full),
  base: full ? "" : base,
  source: String(full || directories.length > 0),
};
for (const [lane, pattern] of Object.entries(lanes)) {
  results[lane] = String(full || directories.some((dir) => pattern.test(dir)));
}
results.provider_matrix = JSON.stringify(
  ["anthropic", "discord", "openai", "embeddings"].filter(
    (provider) => full || directories.includes(`plugins/plugin-${provider}`),
  ),
);
if (output) {
  appendFileSync(
    output,
    Object.entries(results)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}
console.log(
  JSON.stringify(
    { reason, changedPaths: paths, affected: directories, outputs: results },
    null,
    2,
  ),
);
