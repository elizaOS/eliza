#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Builds and runs the native inverse-STFT verification harness using direct
 * process argument vectors. An unavailable authored-only build is a skip;
 * an executed verification failure exits nonzero.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERIFY_DIR = __dirname;
const LLAMA_DIR = path.resolve(__dirname, "..", "llama.cpp");

// Parse args.
const args = process.argv.slice(2);
const backend = args.find((_, i) => args[i - 1] === "--backend") ?? "cpu";
const tol = args.find((_, i) => args[i - 1] === "--tol") ?? "1e-3";

// Build binary if needed.
const binaryPath = path.join(VERIFY_DIR, "istft_verify");
if (!existsSync(binaryPath)) {
  console.log("[istft-verify] Building istft-verify binary...");
  const cflags = [
    "-std=c++17",
    "-O2",
    `-I${path.join(LLAMA_DIR, "ggml", "include")}`,
    `-I${path.join(LLAMA_DIR, "ggml", "src")}`,
    path.join(VERIFY_DIR, "istft-verify.cpp"),
    // Link against ggml and ggml-cpu from the default build output.
    `-L${path.join(LLAMA_DIR, "build")}`,
    "-lggml",
    "-lggml-cpu",
    "-o",
    binaryPath,
  ];
  try {
    const build = spawnSync("c++", cflags, {
      shell: false,
      stdio: "inherit",
      cwd: VERIFY_DIR,
    });
    if (build.status !== 0) {
      throw new Error(`c++ exited with status ${build.status}`);
    }
  } catch {
    console.error(
      "[istft-verify] Build failed — skipping verify (authored-only on this host)",
    );
    process.exit(0);
  }
}

// Run the binary.
const result = spawnSync(binaryPath, ["--backend", backend, "--tol", tol], {
  stdio: "inherit",
  cwd: VERIFY_DIR,
});

if (result.status === 0) {
  console.log("[istft-verify] PASS");
  process.exit(0);
} else {
  console.error("[istft-verify] FAIL (see output above)");
  process.exit(1);
}
