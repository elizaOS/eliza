#!/usr/bin/env node
// onnx-dep-audit.mjs
//
// Walks every package.json in the repo (skipping node_modules, .claude
// worktrees, .venv, dist, build, .git, training caches) and asserts that
// each package.json that declares one of the tracked ONNX-family deps
// (`onnxruntime-node`, `onnxruntime-web`, `@tensorflow/tfjs-node`,
// `@tensorflow-models/coco-ssd`, `@tensorflow-models/mobilenet`,
// `@tensorflow-models/pose-detection`, `face-api.js`,
// `@huggingface/transformers`) has at least one consumer in the
// ONNX→ggml tracker JSON with status='still-needed' AND with that
// package.json listed in its `declares_in` array.
//
// Exit codes:
//   0  — all declared ONNX deps are still justified by the tracker.
//   1  — a package.json declares an ONNX dep that the tracker says is
//        no longer needed (or no consumer claims that dep). The dep
//        must be removed, or the tracker must be updated.
//   2  — usage / IO error (missing tracker, malformed JSON, etc.).
//
// Output:
//   - Per-package summary table on stdout.
//   - On failure, a "REMOVAL REQUIRED" section listing the offending
//     dep + which package.json + why.
//
// Wiring:
//   - Standalone: `node scripts/onnx-dep-audit.mjs`
//   - CI: append to `.github/workflows/ci.yaml#lint-and-format` after
//     the existing `Run lint` step, e.g.:
//
//       - name: ONNX dep audit
//         run: node scripts/onnx-dep-audit.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const trackerPath = path.join(
  repoRoot,
  "packages/training/reports/onnx-to-ggml-tracker.json",
);

const TRACKED_DEPS = new Set([
  "onnxruntime-node",
  "onnxruntime-web",
  "@tensorflow/tfjs-node",
  "@tensorflow-models/coco-ssd",
  "@tensorflow-models/mobilenet",
  "@tensorflow-models/pose-detection",
  "face-api.js",
  "@huggingface/transformers",
]);

const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".claude",
  ".venv",
  "dist",
  "build",
  ".git",
  ".turbo",
  ".next",
  "coverage",
  "dist-mobile",
]);

function loadTracker() {
  if (!fs.existsSync(trackerPath)) {
    console.error(
      `[onnx-dep-audit] tracker not found at ${path.relative(repoRoot, trackerPath)}`,
    );
    process.exit(2);
  }
  try {
    return JSON.parse(fs.readFileSync(trackerPath, "utf8"));
  } catch (err) {
    console.error(`[onnx-dep-audit] tracker JSON parse failed: ${err.message}`);
    process.exit(2);
  }
}

function findAllPackageJsons(rootDir) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name === "package.json") {
        out.push(path.join(dir, entry.name));
      }
    }
  }
  walk(rootDir);
  return out;
}

function readPackageJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function declaredOnnxDeps(pkgJson) {
  const found = [];
  for (const section of DEP_SECTIONS) {
    const block = pkgJson?.[section];
    if (!block || typeof block !== "object") continue;
    for (const name of Object.keys(block)) {
      if (TRACKED_DEPS.has(name)) {
        found.push({ name, section, version: block[name] });
      }
    }
  }
  return found;
}

function buildJustificationIndex(tracker) {
  // Build: { relPathOfPackageJson -> Set<depName> } from tracker consumers
  // where status === 'still-needed' AND declares_in cites that file#section.dep.
  const index = new Map();
  const addJustification = (relPath, depName) => {
    if (!index.has(relPath)) index.set(relPath, new Set());
    index.get(relPath).add(depName);
  };
  for (const consumer of tracker.consumers ?? []) {
    if (consumer.status !== "still-needed") continue;
    for (const decl of consumer.declares_in ?? []) {
      // Format: "<relpath>#<section>.<depName>"
      const hashIdx = decl.indexOf("#");
      if (hashIdx === -1) continue;
      const relPath = decl.slice(0, hashIdx);
      const tail = decl.slice(hashIdx + 1);
      const dotIdx = tail.indexOf(".");
      const depName = dotIdx === -1 ? tail : tail.slice(dotIdx + 1);
      addJustification(relPath, depName);
    }
  }
  return index;
}

function main() {
  const tracker = loadTracker();
  const justifications = buildJustificationIndex(tracker);

  const pkgFiles = findAllPackageJsons(repoRoot);
  const violations = [];
  const perPackageReport = [];

  for (const absFile of pkgFiles) {
    const relFile = path.relative(repoRoot, absFile);
    const pkgJson = readPackageJson(absFile);
    if (!pkgJson) continue;

    const onnxDeps = declaredOnnxDeps(pkgJson);
    if (onnxDeps.length === 0) continue;

    const justifiedDeps = justifications.get(relFile) ?? new Set();
    const perDep = onnxDeps.map(({ name, section, version }) => {
      const justified = justifiedDeps.has(name);
      if (!justified) {
        violations.push({
          packageJson: relFile,
          dep: name,
          section,
          version,
          reason:
            "no consumer in tracker has status='still-needed' AND lists this package.json#section.dep in declares_in",
        });
      }
      return { name, section, version, justified };
    });

    perPackageReport.push({
      packageJson: relFile,
      packageName: pkgJson.name ?? "(unnamed)",
      deps: perDep,
    });
  }

  // Render report
  console.log(
    "\n=== ONNX dep audit (vs packages/training/reports/onnx-to-ggml-tracker.json) ===\n",
  );
  if (perPackageReport.length === 0) {
    console.log(
      "No package.json declares any tracked ONNX-family dep. Nothing to verify.\n",
    );
  } else {
    for (const report of perPackageReport) {
      console.log(`- ${report.packageJson} (${report.packageName})`);
      for (const dep of report.deps) {
        const tag = dep.justified ? "OK    " : "REMOVE";
        console.log(
          `    [${tag}] ${dep.section}.${dep.name}@${dep.version}`,
        );
      }
    }
    console.log("");
  }

  if (violations.length > 0) {
    console.log("=== REMOVAL REQUIRED ===\n");
    for (const v of violations) {
      console.log(
        `- ${v.packageJson}: remove ${v.section}.${v.dep}@${v.version}`,
      );
      console.log(`    reason: ${v.reason}`);
    }
    console.log(
      "\nFix: either (a) delete the dep from the package.json, or (b) update onnx-to-ggml-tracker.json to mark the consumer 'still-needed' with this declares_in entry.\n",
    );
    process.exit(1);
  }

  console.log("All declared ONNX-family deps are justified by the tracker.\n");
  process.exit(0);
}

main();
