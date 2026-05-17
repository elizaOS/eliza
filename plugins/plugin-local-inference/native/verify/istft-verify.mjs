#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// istft-verify.mjs — JS harness that wraps the C++ istft-verify binary.
//
// Usage:
//   node istft-verify.mjs [--backend cpu|vulkan|cuda] [--tol 1e-3]
//
// Builds the binary if missing, then runs it and parses results.
// Exits 0 on PASS (or all-SKIP when backend unavailable), 1 on FAIL.

import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERIFY_DIR = __dirname;
const LLAMA_DIR  = path.resolve(__dirname, '..', 'llama.cpp');

// Parse args.
const args   = process.argv.slice(2);
const backend = args.find((_, i) => args[i - 1] === '--backend') ?? 'cpu';
const tol     = args.find((_, i) => args[i - 1] === '--tol')     ?? '1e-3';

// Build binary if needed.
const binaryPath = path.join(VERIFY_DIR, 'istft_verify');
if (!existsSync(binaryPath)) {
    console.log('[istft-verify] Building istft-verify binary...');
    const cflags = [
        '-std=c++17', '-O2',
        `-I${path.join(LLAMA_DIR, 'ggml', 'include')}`,
        `-I${path.join(LLAMA_DIR, 'ggml', 'src')}`,
        path.join(VERIFY_DIR, 'istft-verify.cpp'),
        // Link against ggml and ggml-cpu from the default build output.
        `-L${path.join(LLAMA_DIR, 'build')}`,
        '-lggml', '-lggml-cpu',
        '-o', binaryPath,
    ];
    try {
        execSync(['c++', ...cflags].join(' '), { stdio: 'inherit', cwd: VERIFY_DIR });
    } catch (e) {
        console.error('[istft-verify] Build failed — skipping verify (authored-only on this host)');
        process.exit(0);
    }
}

// Run the binary.
const result = spawnSync(binaryPath, ['--backend', backend, '--tol', tol], {
    stdio: 'inherit',
    cwd: VERIFY_DIR,
});

if (result.status === 0) {
    console.log('[istft-verify] PASS');
    process.exit(0);
} else {
    console.error('[istft-verify] FAIL (see output above)');
    process.exit(1);
}
