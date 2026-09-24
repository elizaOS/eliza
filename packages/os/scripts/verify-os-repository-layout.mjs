#!/usr/bin/env node
/**
 * Enforces the standalone OS repository's side of the ownership boundary.
 * Distribution sources live at this repository's root, while application and native
 * runtime source trees are consumed from elizaOS/eliza rather than copied here.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
})
  .split("\0")
  .filter((entry) => entry && fs.existsSync(path.join(repositoryRoot, entry)));

const forbiddenPrefixes = [
  "packages/",
  "shared-system/",
  "packages/app-core/",
  "packages/native/",
  "plugins/",
  ".github/actions/setup-bun-workspace/",
  "scripts/aosp/seccomp-shim/",
];
const forbidden = tracked.filter((entry) =>
  forbiddenPrefixes.some((prefix) => entry.startsWith(prefix)),
);
if (forbidden.length > 0) {
  throw new Error(
    `Application-owned source is tracked in elizaOS/os:\n${forbidden.map((entry) => `- ${entry}`).join("\n")}`,
  );
}

const requiredPrefixes = [
  "android/",
  "linux/",
  "toolchains/bun-riscv64/",
  ".github/workflows/elizaos-cuttlefish.yml",
  ".github/workflows/build-debian-package.yml",
];
for (const prefix of requiredPrefixes) {
  if (!tracked.some((entry) => entry.startsWith(prefix))) {
    throw new Error(`Required OS ownership path is missing: ${prefix}`);
  }
}

const requiredWorktreePaths = [".github/workflows/build-linux-mkosi.yml"];
for (const entry of requiredWorktreePaths) {
  const absolute = path.join(repositoryRoot, entry);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`Required OS ownership path is missing: ${entry}`);
  }
}

if (!fs.existsSync(path.join(repositoryRoot, "AGENTS.md"))) {
  throw new Error("The canonical AGENTS.md repository guide is missing.");
}

const staleOwnershipReferences = [
  [".gitignore", /packages\/app-core\/scripts\/bun-riscv64/],
  ["AGENTS.md", /packages\/app-core\/packaging\/debian/],
];
const stale = staleOwnershipReferences.flatMap(([entry, pattern]) => {
  const contents = fs.readFileSync(path.join(repositoryRoot, entry), "utf8");
  return pattern.test(contents) ? [`${entry}: ${pattern}`] : [];
});
if (stale.length > 0) {
  throw new Error(
    `Pre-migration ownership paths remain in elizaOS/os metadata:\n${stale.map((entry) => `- ${entry}`).join("\n")}`,
  );
}

console.log(`OS repository layout passed: ${tracked.length} worktree paths.`);
