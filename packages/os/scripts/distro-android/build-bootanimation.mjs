#!/usr/bin/env node
// Pack PNG frame directories + desc.txt into bootanimation.zip in the
// uncompressed-store format AOSP's bootanimation daemon requires.
//
// Brand-agnostic: every path comes from --frames / --out CLI flags.
//
// Usage:
//   node scripts/distro-android/build-bootanimation.mjs \
//     --frames android/vendor/<brand>/bootanimation \
//     --out android/vendor/<brand>/bootanimation/bootanimation.zip
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

const DEFAULT_USAGE =
  "Usage: node scripts/distro-android/build-bootanimation.mjs --frames <DIR> [--out <ZIP>] [--check]";

export function parseArgs(
  argv,
  { defaultFrames = null, usage = DEFAULT_USAGE } = {},
) {
  const args = { framesDir: defaultFrames, outPath: null, check: false };
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
      console.log(usage);
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
  const descState = fs.lstatSync(descPath);
  if (!descState.isFile() || descState.isSymbolicLink())
    throw new Error("desc.txt must be a regular file, not a symlink");
  const lines = fs
    .readFileSync(descPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const partLines = lines.filter((line) => /^[pcf]\s/.test(line));
  if (partLines.length === 0)
    throw new Error("desc.txt declares no p, c, or f animation parts");
  // PATH is field four; optional fade, background, and clock fields follow it.
  const parts = [...new Set(partLines.map((line) => line.split(/\s+/)[3]))];
  const files = ["desc.txt"];
  const issues = [];
  for (const part of parts) {
    if (
      !part ||
      part.includes("\\") ||
      part
        .split("/")
        .some((segment) => !segment || segment === "." || segment === "..")
    ) {
      issues.push(`invalid part path: ${part}`);
      continue;
    }
    let directory = framesDir;
    let valid = true;
    for (const segment of part.split("/")) {
      directory = path.join(directory, segment);
      const state = fs.lstatSync(directory, { throwIfNoEntry: false });
      if (!state?.isDirectory() || state.isSymbolicLink()) {
        issues.push(`part path must contain only real directories: ${part}`);
        valid = false;
        break;
      }
    }
    if (!valid) continue;
    const entries = fs.readdirSync(directory).sort();
    let frameCount = 0;
    for (const name of entries) {
      const state = fs.lstatSync(path.join(directory, name));
      if (!state.isFile() || state.isSymbolicLink()) {
        issues.push(`part entry must be a regular file: ${part}/${name}`);
        continue;
      }
      if (name.toLowerCase().endsWith(".png")) frameCount += 1;
      else if (name !== "trim.txt" && name !== "audio.wav") {
        issues.push(`unsupported part entry: ${part}/${name}`);
        continue;
      }
      files.push(`${part}/${name}`);
    }
    if (frameCount === 0) issues.push(`part ${part}/ has zero PNG frames`);
  }
  for (const font of ["clock_font.png", "progress_font.png"]) {
    const state = fs.lstatSync(path.join(framesDir, font), {
      throwIfNoEntry: false,
    });
    if (!state) continue;
    if (!state.isFile() || state.isSymbolicLink())
      issues.push(`${font} must be a regular file`);
    else files.push(font);
  }
  return { descPath, parts, files, issues };
}

export function buildBootAnimationZip({ framesDir, outPath }) {
  const { descPath, parts, files, issues } = inspectBootAnimationDir(framesDir);
  if (issues.length > 0) {
    throw new Error(
      `Cannot build bootanimation.zip — frame layout issues:\n - ${issues.join("\n - ")}`,
    );
  }
  const output = path.join(
    fs.realpathSync(path.dirname(outPath)),
    path.basename(outPath),
  );
  const source = fs.realpathSync(framesDir);
  if (
    files.some((file) => path.join(source, file) === output) ||
    parts.some((part) =>
      output.startsWith(`${path.join(source, part)}${path.sep}`),
    )
  ) {
    throw new Error(
      "Output archive must not overwrite or reside inside animation inputs",
    );
  }

  // bootanimation.zip MUST be stored with no compression so the daemon
  // can mmap frames directly. `zip -0` enforces store mode.
  const staging = fs.mkdtempSync(
    path.join(path.dirname(outPath), ".bootanimation-"),
  );
  try {
    const archive = path.join(staging, "bootanimation.zip");
    const result = spawnSync("zip", ["-0", "-nw", archive, "--", ...files], {
      cwd: framesDir,
      stdio: "inherit",
    });
    if (result.error)
      throw new Error("Could not start zip", { cause: result.error });
    if (result.signal) throw new Error(`zip terminated by ${result.signal}`);
    if (result.status !== 0)
      throw new Error(`zip exited with code ${result.status}`);
    fs.renameSync(archive, outPath);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  console.log(
    `[bootanimation] Wrote ${outPath} from ${descPath} (parts: ${parts.join(", ")}).`,
  );
}

export function main(argv = process.argv.slice(2), options) {
  const args = parseArgs(argv, options);
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

if (import.meta.main) {
  await main();
}
