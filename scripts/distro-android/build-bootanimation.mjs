#!/usr/bin/env node
// Pack PNG frame directories + desc.txt into bootanimation.zip in the
// uncompressed-store format AOSP's bootanimation daemon requires.
//
// Brand-agnostic: every path comes from --frames / --out CLI flags.
//
// Usage:
//   node scripts/distro-android/build-bootanimation.mjs \
//     --frames packages/os/android/vendor/<brand>/bootanimation \
//     --out packages/os/android/vendor/<brand>/bootanimation/bootanimation.zip
//
// Flags:
//   --frames <dir>   Directory containing desc.txt + part0/ part1/ ...
//   --out <path>     Output zip path. Defaults to <frames>/bootanimation.zip.
//   --check          Don't write — just verify the layout. Exits non-zero
//                    if desc.txt or required part dirs are missing.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function parseArgs(argv) {
  const args = { framesDir: null, outPath: null, check: false };
  const readFlagValue = (flag, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--frames") {
      args.framesDir = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "--out") {
      args.outPath = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "--check") {
      args.check = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/distro-android/build-bootanimation.mjs --frames <DIR> [--out <ZIP>] [--check]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.framesDir) throw new Error("--frames is required");
  args.outPath ??= path.join(args.framesDir, "bootanimation.zip");
  return args;
}

export function inspectBootAnimationDir(framesDir) {
  const descPath = path.join(framesDir, "desc.txt");
  if (!fs.existsSync(descPath)) {
    throw new Error(`Missing desc.txt at ${descPath}`);
  }
  const desc = fs.readFileSync(descPath, "utf8");
  const lines = desc
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const partLines = lines.filter((line) => line.startsWith("p "));
  if (partLines.length === 0) {
    throw new Error(
      "desc.txt declares no parts (`p ...` lines). At least one required.",
    );
  }
  const parts = partLines.map((line) => line.split(/\s+/).at(-1));
  const issues = [];
  for (const part of parts) {
    const partDir = path.join(framesDir, part);
    if (!fs.existsSync(partDir)) {
      issues.push(`missing part directory: ${part}/`);
      continue;
    }
    const frames = fs
      .readdirSync(partDir)
      .filter((name) => name.toLowerCase().endsWith(".png"));
    if (frames.length === 0) {
      issues.push(`part ${part}/ has zero PNG frames`);
    }
  }
  return { descPath, parts, issues };
}

export function buildBootAnimationZip({ framesDir, outPath }) {
  const { descPath, parts, issues } = inspectBootAnimationDir(framesDir);
  if (issues.length > 0) {
    throw new Error(
      `Cannot build bootanimation.zip — frame layout issues:\n - ${issues.join("\n - ")}`,
    );
  }

  // bootanimation.zip MUST be stored with no compression so the daemon
  // can mmap frames directly. `zip -0` enforces store mode.
  fs.rmSync(outPath, { force: true });
  const zipArgs = ["-0", "-r", outPath, "desc.txt", ...parts];
  const result = spawnSync("zip", zipArgs, {
    cwd: framesDir,
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(
      `zip not on PATH (apt install zip / brew install zip): ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`zip exited with code ${result.status}`);
  }
  console.log(
    `[bootanimation] Wrote ${outPath} from ${descPath} (parts: ${parts.join(", ")}).`,
  );
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.check) {
    const { issues } = inspectBootAnimationDir(args.framesDir);
    if (issues.length > 0) {
      console.error(`[bootanimation:check] FAIL\n - ${issues.join("\n - ")}`);
      process.exit(1);
    }
    console.log(`[bootanimation:check] ${args.framesDir} is well-formed.`);
    return;
  }
  buildBootAnimationZip(args);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
