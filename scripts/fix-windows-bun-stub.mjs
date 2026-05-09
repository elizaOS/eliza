#!/usr/bin/env node
/**
 * Replace the 450-byte `node_modules/bun/bin/bun.exe` placeholder stub
 * with the actually-installed Bun binary on Windows.
 *
 * Why this exists
 * ---------------
 * The npm `bun` package ships a tiny stub at `bin/bun.exe` and relies on
 * its own postinstall to download the real Bun. Bun's own installer skips
 * that postinstall when it's already running as the package manager
 * ("I'm Bun, why would I download Bun?"), so the stub stays in place.
 *
 * That stub is not a valid PE entry point. When any package script in
 * this monorepo is shaped like `"build": "bun run build.ts"` and a user
 * invokes `bun run build`, Bun spawns `bun.exe` via the local shim chain
 * — `node_modules/.bin/bun.exe` (a real shim) → `node_modules/bun/bin/bun.exe`
 * (the 450-byte stub) — and `CreateProcessW` returns
 * `STATUS_INVALID_IMAGE_FORMAT`. The user-facing message is the
 * confusing "Bun failed to remap this bin to its proper location within
 * node_modules. … Please run 'bun install --force' …" — but no amount
 * of `--force` repairs the stub, because Bun never re-runs that
 * postinstall.
 *
 * Refs:
 *   - oven-sh/bun#17482
 *   - oven-sh/bun#16961
 *   - oven-sh/bun#16832
 *   - oven-sh/bun#11799
 *
 * Fix
 * ---
 * On Windows, copy the running Bun (`process.execPath`) over the stub.
 * Idempotent: skip when the file is already the right size.
 *
 * Cross-platform: no-op on Linux/macOS where the stub problem doesn't
 * exist (the bun npm package's postinstall fetches the binary fine on
 * those platforms when triggered, and our scripts here use direct ELF
 * shims that don't have the Windows CreateProcess fallback path).
 */

import { copyFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

if (process.platform !== "win32") {
	process.exit(0);
}

const target = join(
	process.cwd(),
	"node_modules",
	"bun",
	"bin",
	"bun.exe",
);

if (!existsSync(target)) {
	// No `bun` package installed under this workspace root, nothing to do.
	process.exit(0);
}

const STUB_MAX_SIZE = 100 * 1024; // real Bun is ~110MB; stub is ~450B

let targetSize;
try {
	targetSize = statSync(target).size;
} catch {
	process.exit(0);
}

if (targetSize > STUB_MAX_SIZE) {
	// Already the real binary, nothing to do.
	process.exit(0);
}

const source = process.execPath;

if (!existsSync(source)) {
	console.warn(
		`[fix-windows-bun-stub] running Bun (${source}) not found on disk; cannot replace stub at ${target}.`,
	);
	process.exit(0);
}

let sourceSize;
try {
	sourceSize = statSync(source).size;
} catch {
	process.exit(0);
}

if (sourceSize <= STUB_MAX_SIZE) {
	// Running under the stub itself, somehow — bail rather than copy a stub onto a stub.
	console.warn(
		`[fix-windows-bun-stub] running Bun (${source}, ${sourceSize}B) looks like a stub itself; refusing to copy.`,
	);
	process.exit(0);
}

try {
	copyFileSync(source, target);
	console.log(
		`[fix-windows-bun-stub] replaced ${target} (${targetSize}B stub) with real Bun from ${source} (${sourceSize}B).`,
	);
} catch (err) {
	console.warn(
		`[fix-windows-bun-stub] copy failed: ${err instanceof Error ? err.message : String(err)}`,
	);
}
