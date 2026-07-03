#!/usr/bin/env bun

/**
 * Build standalone `elizaos` CLI executables for every release platform.
 *
 * `bun build --compile` embeds the JS module graph into a single native binary,
 * but the CLI still reads its templates/, templates-manifest.json, and
 * package.json from disk at runtime (see src/manifest.ts + src/package-info.ts).
 * Inside a compiled binary those live in the unreadable `/$bunfs` virtual root,
 * so `getPackageRoot()` falls back to the executable's directory
 * (`isStandaloneBinary()`), and we stage those assets next to the binary here.
 *
 * Each target produces `<out>/elizaos-<label>/` containing the binary + assets,
 * archived to `.tar.gz` (unix) or `.zip` (windows). A single runner can cross
 * compile every target, so the whole matrix builds on Linux in one step.
 *
 * Usage:
 *   bun run build-standalone.ts [--out <dir>] [--target <label>[,<label>...]]
 * Labels: linux-x64 linux-arm64 darwin-x64 darwin-arm64 windows-x64
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { copyDir } from "./safe-copy-dir.ts";

const PACKAGE_DIR = import.meta.dir;
const DIST_CLI = path.join(PACKAGE_DIR, "dist", "cli.js");

interface Target {
  /** Human-facing label used in archive names and --target selection. */
  label: string;
  /** `bun build --compile --target=` value. */
  bunTarget: string;
  os: "linux" | "darwin" | "windows";
}

const TARGETS: Target[] = [
  { label: "linux-x64", bunTarget: "bun-linux-x64", os: "linux" },
  { label: "linux-arm64", bunTarget: "bun-linux-arm64", os: "linux" },
  { label: "darwin-x64", bunTarget: "bun-darwin-x64", os: "darwin" },
  { label: "darwin-arm64", bunTarget: "bun-darwin-arm64", os: "darwin" },
  { label: "windows-x64", bunTarget: "bun-windows-x64", os: "windows" },
];

function parseArgs(argv: string[]): { outDir: string; selected: Target[] } {
  let outDir = path.join(PACKAGE_DIR, "dist-standalone");
  let selected = TARGETS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      outDir = path.resolve(argv[++i] ?? outDir);
    } else if (arg === "--target") {
      const labels = new Set((argv[++i] ?? "").split(",").map((s) => s.trim()));
      selected = TARGETS.filter((t) => labels.has(t.label));
      if (selected.length === 0) {
        throw new Error(
          `No matching targets for --target; valid: ${TARGETS.map((t) => t.label).join(", ")}`,
        );
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { outDir, selected };
}

function run(bin: string, args: string[], cwd = PACKAGE_DIR): void {
  const result = spawnSync(bin, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${bin} ${args.join(" ")} exited with code ${result.status}`,
    );
  }
}

function ensureBuilt(): void {
  // The compiled binary embeds dist/cli.js; the archive ships templates/ and
  // templates-manifest.json. `bun run build` produces all three.
  if (
    !fs.existsSync(DIST_CLI) ||
    !fs.existsSync(path.join(PACKAGE_DIR, "templates-manifest.json"))
  ) {
    run("bun", ["run", "build"]);
  }
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function stageAssets(stageDir: string): void {
  // Ship exactly what getPackageRoot() looks for next to the binary.
  copyDir(
    path.join(PACKAGE_DIR, "templates"),
    path.join(stageDir, "templates"),
  );
  fs.copyFileSync(
    path.join(PACKAGE_DIR, "templates-manifest.json"),
    path.join(stageDir, "templates-manifest.json"),
  );
  fs.copyFileSync(
    path.join(PACKAGE_DIR, "package.json"),
    path.join(stageDir, "package.json"),
  );
}

function archive(target: Target, stageDir: string, outDir: string): string {
  const stageName = path.basename(stageDir);
  if (target.os === "windows") {
    const zipPath = path.join(outDir, `${stageName}.zip`);
    fs.rmSync(zipPath, { force: true });
    // -r recurse, -q quiet, -X strip extra file attributes for reproducibility.
    run("zip", ["-r", "-q", "-X", zipPath, stageName], outDir);
    return zipPath;
  }
  const tarPath = path.join(outDir, `${stageName}.tar.gz`);
  fs.rmSync(tarPath, { force: true });
  run("tar", ["-czf", tarPath, "-C", outDir, stageName]);
  return tarPath;
}

function main(): void {
  const { outDir, selected } = parseArgs(process.argv.slice(2));
  ensureBuilt();
  fs.mkdirSync(outDir, { recursive: true });

  const checksums: string[] = [];
  for (const target of selected) {
    const stageName = `elizaos-${target.label}`;
    const stageDir = path.join(outDir, stageName);
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(stageDir, { recursive: true });

    const binName = target.os === "windows" ? "elizaos.exe" : "elizaos";
    console.log(`\n▶ Compiling ${target.label} (${target.bunTarget})...`);
    run("bun", [
      "build",
      DIST_CLI,
      "--compile",
      `--target=${target.bunTarget}`,
      "--outfile",
      path.join(stageDir, binName),
    ]);

    stageAssets(stageDir);
    const archivePath = archive(target, stageDir, outDir);
    fs.rmSync(stageDir, { recursive: true, force: true });

    const digest = sha256(archivePath);
    checksums.push(`${digest}  ${path.basename(archivePath)}`);
    console.log(
      `  ✅ ${path.basename(archivePath)} (${(fs.statSync(archivePath).size / 1e6).toFixed(1)} MB)`,
    );
  }

  fs.writeFileSync(
    path.join(outDir, "SHA256SUMS-cli.txt"),
    `${checksums.join("\n")}\n`,
  );
  console.log(`\n✅ Standalone CLI archives written to ${outDir}`);
}

main();
