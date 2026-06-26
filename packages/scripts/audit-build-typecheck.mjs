#!/usr/bin/env node
/**
 * Audit the build / typecheck compiler model (issue #9626, TL;DR #3 + "two
 * compilers"). The repo's chosen model is: **tsgo checks, tsc only emits.**
 *
 * This script flags drift from that model across every workspace package:
 *   1. A `build` that runs a full `tsc` type-check (declaration emit WITHOUT
 *      `--noCheck`) while a separate `typecheck` already checks the same source
 *      — a redundant second full type-check.
 *   2. A `typecheck` that uses `tsc` instead of the standard `tsgo`.
 *   3. A no-op `typecheck` (`tsc --noEmit --noCheck` checks nothing).
 *
 * Exits non-zero on any un-allowlisted violation so it can gate CI / `verify`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKSPACE_GLOBS = ["packages", "plugins"];

// Deliberate, documented exceptions (keep this list short and justified).
const ALLOW = {
	// @elizaos/core: build uses tsconfig.build.json but typecheck uses
	// tsconfig.json — a possible coverage delta; converting needs a deliberate
	// framework decision, not a blind --noCheck (issue #9626).
	doubleCheck: new Set(["@elizaos/core"]),
	// These packages currently fail `tsgo` (it flags errors `tsc` does not);
	// kept on `tsc` until those are resolved.
	tscTypecheck: new Set([
		"@elizaos/plugin-social-alpha",
		"@elizaos/plugin-companion",
		"@elizaos/plugin-personal-assistant",
	]),
};

function listPackageDirs() {
	const dirs = [];
	for (const glob of WORKSPACE_GLOBS) {
		const base = path.join(repoRoot, glob);
		let entries;
		try {
			entries = readdirSync(base, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const ent of entries) {
			if (!ent.isDirectory()) continue;
			const dir = path.join(base, ent.name);
			try {
				statSync(path.join(dir, "package.json"));
				dirs.push(dir);
			} catch {
				// nested workspace (e.g. packages/feed/packages/*) — descend one level
				try {
					const nestedBase = path.join(dir, "packages");
					for (const nested of readdirSync(nestedBase, { withFileTypes: true })) {
						if (!nested.isDirectory()) continue;
						const ndir = path.join(nestedBase, nested.name);
						try {
							statSync(path.join(ndir, "package.json"));
							dirs.push(ndir);
						} catch {}
					}
				} catch {}
			}
		}
	}
	return dirs;
}

/** A tsc invocation that emits declarations and does NOT skip the type-check. */
function isFullTscEmit(script) {
	if (!/\btsc\b/.test(script)) return false;
	const emits = /--emitDeclarationOnly|--declaration\b|-p\s+tsconfig|--project\s+tsconfig/.test(script);
	if (!emits) return false;
	if (/--noCheck/.test(script)) return false;
	if (/--noEmit/.test(script)) return false; // that's a check, not an emit
	return true;
}

const violations = [];
for (const dir of listPackageDirs()) {
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
	} catch {
		continue;
	}
	const name = pkg.name ?? path.relative(repoRoot, dir);
	const scripts = pkg.scripts ?? {};
	const build = scripts.build ?? "";
	const typecheck = scripts.typecheck ?? "";
	const hasSeparateTypecheck = /\btsgo\b|\btsc\b/.test(typecheck);

	if (isFullTscEmit(build) && hasSeparateTypecheck && !ALLOW.doubleCheck.has(name)) {
		violations.push(`${name}: build double-type-checks (add --noCheck to its tsc emit) — ${build.trim()}`);
	}
	if (/\btsc --noEmit\b/.test(typecheck) && /--noCheck/.test(typecheck)) {
		violations.push(`${name}: typecheck is a no-op (\`tsc --noEmit --noCheck\` checks nothing)`);
	} else if (
		/\btsc\b/.test(typecheck) &&
		/--noEmit/.test(typecheck) &&
		!/\btsgo\b/.test(typecheck) &&
		!ALLOW.tscTypecheck.has(name)
	) {
		// `tsc -b` (project-references build) is a deliberately different mode and
		// is intentionally not flagged here — only the `tsc --noEmit` checker form.
		violations.push(`${name}: typecheck uses tsc --noEmit, not tsgo — ${typecheck.trim()}`);
	}
}

if (violations.length > 0) {
	console.error(`[audit-build-typecheck] ${violations.length} compiler-model violation(s):\n`);
	for (const v of violations) console.error(`  ✗ ${v}`);
	console.error(
		"\nModel: tsgo checks, tsc emits. Add --noCheck to emit-only tsc builds; use tsgo for typecheck.",
	);
	process.exit(1);
}
console.log("[audit-build-typecheck] ✓ build/typecheck compiler model is consistent");
