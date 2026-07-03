#!/usr/bin/env node

/**
 * End-to-end smoke test for the standalone `elizaos` CLI binary.
 *
 * Builds the host-platform standalone archive (build-standalone.ts), extracts
 * it to a temp dir, and drives the real binary through `version`, `info`, and
 * `create` — the paths that read templates-manifest.json and the templates/
 * tree from disk. This is the regression guard for the compiled-binary asset
 * resolution in src/package-info.ts (getPackageRoot -> executable dir).
 *
 * Runs in the release workflow after `build:standalone`. Fails loudly on any
 * non-zero exit or missing generated file.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function hostLabel() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  switch (process.platform) {
    case "darwin":
      return `darwin-${arch}`;
    case "linux":
      return `linux-${arch}`;
    case "win32":
      return `windows-${arch}`;
    default:
      throw new Error(`Unsupported host platform: ${process.platform}`);
  }
}

function run(bin, args, opts = {}) {
  const result = spawnSync(bin, args, { stdio: "inherit", ...opts });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${bin} ${args.join(" ")} exited with code ${result.status}`,
    );
  }
}

function main() {
  const label = hostLabel();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "elizaos-standalone-"));
  console.log(`[standalone-smoke] host target: ${label}`);
  console.log(`[standalone-smoke] out dir: ${outDir}`);

  // 1. Build the host-target archive only (fast; skips cross targets).
  run(
    "bun",
    ["run", "build-standalone.ts", "--out", outDir, "--target", label],
    {
      cwd: PACKAGE_DIR,
    },
  );

  // 2. Extract the archive.
  const extractDir = path.join(outDir, "extracted");
  fs.mkdirSync(extractDir, { recursive: true });
  const stageName = `elizaos-${label}`;
  if (process.platform === "win32") {
    run("tar", [
      "-xf",
      path.join(outDir, `${stageName}.zip`),
      "-C",
      extractDir,
    ]);
  } else {
    run("tar", [
      "-xzf",
      path.join(outDir, `${stageName}.tar.gz`),
      "-C",
      extractDir,
    ]);
  }

  const binName = process.platform === "win32" ? "elizaos.exe" : "elizaos";
  const binPath = path.join(extractDir, stageName, binName);
  if (!fs.existsSync(binPath)) {
    throw new Error(`Compiled binary not found at ${binPath}`);
  }
  if (process.platform !== "win32") fs.chmodSync(binPath, 0o755);

  // 3. Drive the real commands (all read on-disk assets next to the binary).
  console.log("\n[standalone-smoke] elizaos version");
  run(binPath, ["version"]);
  console.log("\n[standalone-smoke] elizaos info");
  run(binPath, ["info"]);

  console.log("\n[standalone-smoke] elizaos create (plugin template)");
  // `create` slugifies its name argument into a `plugin-<slug>/` directory
  // created under the process CWD, so run it inside a dedicated clean dir.
  const createCwd = path.join(outDir, "create-run");
  fs.mkdirSync(createCwd, { recursive: true });
  run(binPath, ["create", "smokeplugin", "--template", "plugin", "--yes"], {
    cwd: createCwd,
  });

  // 4. Assert the template tree actually rendered.
  const generated = fs
    .readdirSync(createCwd, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("plugin-"))
    .map((e) => path.join(createCwd, e.name));
  const found = generated.find((dir) =>
    fs.existsSync(path.join(dir, "package.json")),
  );
  if (!found) {
    throw new Error(
      `create did not produce a project with package.json (checked: ${generated.join(", ") || "none"})`,
    );
  }
  const metadata = path.join(found, ".elizaos", "template.json");
  if (!fs.existsSync(metadata)) {
    throw new Error(`Generated project missing template metadata: ${metadata}`);
  }
  console.log(`\n[standalone-smoke] ✅ generated project at ${found}`);

  fs.rmSync(outDir, { recursive: true, force: true });
  console.log("[standalone-smoke] ✅ all checks passed");
}

main();
