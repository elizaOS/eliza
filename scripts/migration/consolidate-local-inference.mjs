#!/usr/bin/env node
/**
 * consolidate-local-inference.mjs
 *
 * Moves every local-inference / llama.cpp related file into
 * plugins/plugin-local-inference. See LOCAL_INFERENCE_CONSOLIDATION_PLAN.md
 * at the repo root for the complete plan.
 *
 * Usage:
 *   node scripts/migration/consolidate-local-inference.mjs            # dry-run (default)
 *   node scripts/migration/consolidate-local-inference.mjs --execute  # perform moves with `git mv`
 *   node scripts/migration/consolidate-local-inference.mjs --verbose  # list every file, not just roots
 *
 * Phase boundaries:
 *   1. Dry-run validates: sources exist, destinations are empty/non-colliding,
 *      sources are tracked by git, working tree is clean, submodule is initialized.
 *   2. --execute uses `git mv` for whole directories (history preserved),
 *      rewrites .gitmodules for the submodule relocation, and prints next-step
 *      instructions for running the companion import-rewrite codemod.
 *
 * This script ONLY moves files. It does NOT rewrite imports. Run
 * scripts/migration/rewrite-local-inference-imports.mjs afterwards.
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");

const argv = new Set(process.argv.slice(2));
const EXECUTE = argv.has("--execute");
const VERBOSE = argv.has("--verbose");
const DRY = !EXECUTE;

// ── Move table ───────────────────────────────────────────────────────────────
// Each entry: { src, dst, type: 'dir' | 'file', notes? }
// Paths are relative to REPO_ROOT.

const MOVES = [
	// 1. Whole plugins
	{
		src: "plugins/plugin-local-ai",
		dst: "plugins/plugin-local-inference/src/adapters/node-llama-cpp",
		type: "dir",
		notes:
			"node-llama-cpp implementation moves under adapters/. package.json/build.ts/.turbo/dist will need cleanup after the move.",
	},
	// Note: plugins/plugin-local-embedding is intentionally NOT in this table.
	// It's a 27-line re-export shim of plugin-local-inference. We leave it in
	// place during the file moves so unconverted `@elizaos/plugin-local-embedding`
	// imports keep resolving, then the import codemod replaces all references,
	// then we `git rm -r plugins/plugin-local-embedding/` as the very last step.

	// 2. app-core services/local-inference tree (212 files)
	{
		src: "packages/app-core/src/services/local-inference",
		dst: "plugins/plugin-local-inference/src/services",
		type: "dir",
		notes:
			"The bulk of the migration — engine, backend, voice, catalog, manifest, DFlash, MLX, tests, stress tests.",
	},

	// 3. app-core runtime integration files
	{
		src: "packages/app-core/src/runtime/ensure-local-inference-handler.ts",
		dst: "plugins/plugin-local-inference/src/runtime/ensure-local-inference-handler.ts",
		type: "file",
	},
	{
		src: "packages/app-core/src/runtime/ensure-local-inference-handler.test.ts",
		dst: "plugins/plugin-local-inference/src/runtime/ensure-local-inference-handler.test.ts",
		type: "file",
	},
	{
		src: "packages/app-core/src/runtime/mobile-local-inference-gate.ts",
		dst: "plugins/plugin-local-inference/src/runtime/mobile-local-inference-gate.ts",
		type: "file",
	},
	{
		src: "packages/app-core/src/runtime/embedding-manager-support.ts",
		dst: "plugins/plugin-local-inference/src/runtime/embedding-manager-support.ts",
		type: "file",
	},
	{
		src: "packages/app-core/src/runtime/embedding-presets.ts",
		dst: "plugins/plugin-local-inference/src/runtime/embedding-presets.ts",
		type: "file",
	},
	{
		src: "packages/app-core/src/runtime/embedding-warmup-policy.ts",
		dst: "plugins/plugin-local-inference/src/runtime/embedding-warmup-policy.ts",
		type: "file",
	},
	{
		src: "packages/app-core/src/runtime/capacitor-llama.d.ts",
		dst: "plugins/plugin-local-inference/src/runtime/capacitor-llama.d.ts",
		type: "file",
	},

	// 4. app-core api compat routes
	{
		src: "packages/app-core/src/api/local-inference-compat-routes.ts",
		dst: "plugins/plugin-local-inference/src/routes/local-inference-compat-routes.ts",
		type: "file",
	},
	{
		src: "packages/app-core/src/api/local-inference-compat-routes.test.ts",
		dst: "plugins/plugin-local-inference/src/routes/local-inference-compat-routes.test.ts",
		type: "file",
	},

	// 5. Native inference package (incl. llama.cpp submodule gitlink)
	{
		src: "packages/inference",
		dst: "plugins/plugin-local-inference/native",
		type: "dir",
		notes:
			"Whole @elizaos/inference package: llama.cpp submodule, omnivoice.cpp, metal/vulkan/cuda/reference backends, verify harness, voice-bench, dflash. .gitmodules patch happens automatically in --execute.",
		gitmodules: {
			old: "packages/inference/llama.cpp",
			new: "plugins/plugin-local-inference/native/llama.cpp",
		},
	},

	// 6. Scripts
	{
		src: "scripts/ensure-llama-cpp-submodule.mjs",
		dst: "plugins/plugin-local-inference/scripts/ensure-llama-cpp-submodule.mjs",
		type: "file",
		notes:
			"Postinstall script that initializes the llama.cpp submodule. Its submoduleRel constant must be updated after the move (manual or via the codemod).",
	},
	{
		src: "scripts/local-inference-smoke.mjs",
		dst: "plugins/plugin-local-inference/scripts/local-inference-smoke.mjs",
		type: "file",
	},
	{
		src: "scripts/local-inference-ablation.mjs",
		dst: "plugins/plugin-local-inference/scripts/local-inference-ablation.mjs",
		type: "file",
	},
	{
		src: "scripts/local-inference-ablation.config.json",
		dst: "plugins/plugin-local-inference/scripts/local-inference-ablation.config.json",
		type: "file",
	},
	{
		src: "scripts/local-inference-thresholds.json",
		dst: "plugins/plugin-local-inference/scripts/local-inference-thresholds.json",
		type: "file",
	},
	{
		src: "scripts/distro-android/compile-libllama.mjs",
		dst: "plugins/plugin-local-inference/scripts/distro-android/compile-libllama.mjs",
		type: "file",
	},
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function abs(p) {
	return join(REPO_ROOT, p);
}

function git(args, opts = {}) {
	const res = spawnSync("git", args, {
		cwd: REPO_ROOT,
		encoding: "utf8",
		...opts,
	});
	if (res.status !== 0 && !opts.allowFail) {
		throw new Error(
			`git ${args.join(" ")} failed (status ${res.status}):\n${res.stderr}`,
		);
	}
	return res;
}

function countFilesRecursive(p) {
	if (!existsSync(p)) return 0;
	const st = statSync(p);
	if (st.isFile()) return 1;
	let n = 0;
	for (const entry of readdirSync(p, { withFileTypes: true })) {
		const child = join(p, entry.name);
		if (entry.isDirectory()) n += countFilesRecursive(child);
		else if (entry.isFile()) n += 1;
	}
	return n;
}

function listFilesRecursive(p, base = p, out = []) {
	if (!existsSync(p)) return out;
	const st = statSync(p);
	if (st.isFile()) {
		out.push(relative(base, p) || ".");
		return out;
	}
	for (const entry of readdirSync(p, { withFileTypes: true })) {
		const child = join(p, entry.name);
		if (entry.isDirectory()) listFilesRecursive(child, base, out);
		else if (entry.isFile()) out.push(relative(base, child));
	}
	return out;
}

function isPathTrackedByGit(relPath) {
	const res = git(["ls-files", "--error-unmatch", "--", relPath], {
		allowFail: true,
	});
	return res.status === 0;
}

function isPathTrackedDir(relPath) {
	const res = git(["ls-files", "--", relPath], { allowFail: true });
	return res.status === 0 && res.stdout.trim().length > 0;
}

/** Count files tracked by git under a path (more honest than fs walk: skips
 * node_modules / dist / .turbo). */
function countTrackedFiles(relPath) {
	const res = git(["ls-files", "--", relPath], { allowFail: true });
	if (res.status !== 0 || !res.stdout.trim()) return 0;
	return res.stdout.trim().split("\n").length;
}

/** If the source contains (or is) a submodule gitlink, return its path. */
function detectSubmodule(relPath) {
	const res = git(["ls-files", "--stage", "--", relPath], { allowFail: true });
	if (res.status !== 0) return null;
	for (const line of res.stdout.split("\n")) {
		if (line.startsWith("160000 ")) {
			const parts = line.split("\t");
			if (parts.length >= 2) return parts[1];
		}
	}
	return null;
}

function color(s, code) {
	if (!process.stdout.isTTY) return s;
	return `\x1b[${code}m${s}\x1b[0m`;
}
const red = (s) => color(s, "31");
const green = (s) => color(s, "32");
const yellow = (s) => color(s, "33");
const cyan = (s) => color(s, "36");
const bold = (s) => color(s, "1");

// ── Pre-flight checks ────────────────────────────────────────────────────────

function preflight() {
	const issues = [];
	const warnings = [];

	// 1. Repo root has .git and .gitmodules
	if (!existsSync(abs(".git"))) {
		issues.push(`REPO_ROOT does not look like a git repo: ${REPO_ROOT}`);
	}
	if (!existsSync(abs(".gitmodules"))) {
		warnings.push(
			"No .gitmodules at repo root — submodule relocation step will be skipped.",
		);
	}

	// 2. Working tree is clean (allow only the known `D bun.lock`)
	const status = git(["status", "--porcelain=v1"]);
	const dirtyLines = status.stdout
		.split("\n")
		.filter(Boolean)
		.filter((l) => !/\bbun\.lock\b/.test(l));
	if (dirtyLines.length > 0) {
		warnings.push(
			`Working tree has ${dirtyLines.length} uncommitted change(s) beyond bun.lock:\n  ${dirtyLines.slice(0, 10).join("\n  ")}${dirtyLines.length > 10 ? "\n  ..." : ""}`,
		);
	}

	// 3. Branch is not main/master
	const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
	if (branch === "main" || branch === "master") {
		issues.push(`Refusing to run on ${branch} branch — create a feature branch first.`);
	}

	// 4. llama.cpp submodule initialized?
	const submodulePath = abs("packages/inference/llama.cpp");
	if (
		existsSync(abs("packages/inference")) &&
		(!existsSync(join(submodulePath, ".git")) ||
			!existsSync(join(submodulePath, "CMakeLists.txt")))
	) {
		warnings.push(
			"packages/inference/llama.cpp submodule does not appear initialized. `bun run --cwd eliza scripts/ensure-llama-cpp-submodule.mjs` or `git submodule update --init --recursive` may be needed before --execute.",
		);
	}

	return { issues, warnings, branch };
}

// ── Validation pass ──────────────────────────────────────────────────────────

function validateMoves() {
	const issues = [];
	const validated = [];

	for (const move of MOVES) {
		const srcAbs = abs(move.src);
		const dstAbs = abs(move.dst);

		const srcExists = existsSync(srcAbs);
		if (!srcExists) {
			issues.push(`MISSING SOURCE: ${move.src}`);
			validated.push({ ...move, ok: false, fileCount: 0, srcExists });
			continue;
		}

		const srcStat = statSync(srcAbs);
		const actualType = srcStat.isDirectory() ? "dir" : "file";
		if (actualType !== move.type) {
			issues.push(
				`TYPE MISMATCH for ${move.src}: declared ${move.type}, actual ${actualType}`,
			);
		}

		// Check git tracking
		const tracked =
			move.type === "file"
				? isPathTrackedByGit(move.src)
				: isPathTrackedDir(move.src);
		if (!tracked) {
			issues.push(
				`NOT TRACKED BY GIT: ${move.src} — git mv will fail. Either git add it first or use a plain fs move.`,
			);
		}

		// Destination collision
		if (existsSync(dstAbs)) {
			issues.push(
				`DESTINATION ALREADY EXISTS: ${move.dst} — would collide with the move`,
			);
		}

		// Destination parent must be creatable
		const parent = dirname(dstAbs);
		if (!existsSync(parent)) {
			// fine — `git mv` and the script will create it
		} else if (!statSync(parent).isDirectory()) {
			issues.push(
				`DESTINATION PARENT IS NOT A DIRECTORY: ${dirname(move.dst)}`,
			);
		}

		const trackedCount = countTrackedFiles(move.src);
		const fsCount = countFilesRecursive(srcAbs);
		const submodulePath =
			move.type === "dir" ? detectSubmodule(move.src) : null;
		validated.push({
			...move,
			ok: true,
			fileCount: trackedCount,
			fsCount,
			submodulePath,
		});
	}

	return { issues, validated };
}

// ── Report ───────────────────────────────────────────────────────────────────

function printReport({ preflight, validation }) {
	console.log(bold(cyan("\n=== consolidate-local-inference: dry-run ===\n")));
	console.log(`Repo root:           ${REPO_ROOT}`);
	console.log(`Mode:                ${EXECUTE ? bold(yellow("EXECUTE")) : bold(green("DRY-RUN"))}`);
	console.log(`Branch:              ${preflight.branch}`);
	console.log(`Verbose:             ${VERBOSE}`);
	console.log("");

	if (preflight.warnings.length) {
		console.log(bold(yellow("Pre-flight warnings:")));
		for (const w of preflight.warnings) console.log(yellow(`  - ${w}`));
		console.log("");
	}
	if (preflight.issues.length) {
		console.log(bold(red("Pre-flight ISSUES:")));
		for (const i of preflight.issues) console.log(red(`  - ${i}`));
		console.log("");
	}

	console.log(bold(cyan("Planned moves:")));
	let totalFiles = 0;
	let okDirs = 0;
	let okFiles = 0;
	for (const m of validation.validated) {
		const status = m.ok ? green("✓") : red("✗");
		const kind = m.type === "dir" ? cyan("dir ") : "file";
		const count = m.type === "dir" ? `(${m.fileCount} files)` : "";
		console.log(
			`  ${status} ${kind} ${m.src.padEnd(64)} → ${m.dst}  ${count}`,
		);
		if (m.notes && VERBOSE) console.log(`         ${yellow(`note: ${m.notes}`)}`);
		if (m.gitmodules) {
			console.log(
				`         ${cyan(`.gitmodules: ${m.gitmodules.old} → ${m.gitmodules.new}`)}`,
			);
		}
		if (m.ok) {
			totalFiles += m.fileCount;
			if (m.type === "dir") okDirs += 1;
			else okFiles += 1;
		}

		if (VERBOSE && m.type === "dir" && m.ok) {
			const files = listFilesRecursive(abs(m.src));
			const preview = files.slice(0, 12);
			for (const f of preview) console.log(`           - ${f}`);
			if (files.length > preview.length) {
				console.log(`           ... and ${files.length - preview.length} more`);
			}
		}
	}
	console.log("");

	console.log(bold(cyan("Validation issues:")));
	if (validation.issues.length === 0) {
		console.log(green("  none"));
	} else {
		for (const i of validation.issues) console.log(red(`  - ${i}`));
	}
	console.log("");

	console.log(bold(cyan("SUMMARY")));
	console.log(`  Move-table entries:      ${MOVES.length}`);
	console.log(`  OK directory moves:      ${okDirs}`);
	console.log(`  OK file moves:           ${okFiles}`);
	console.log(`  Total files to move:     ~${totalFiles}`);
	console.log(`  Pre-flight issues:       ${preflight.issues.length}`);
	console.log(`  Pre-flight warnings:     ${preflight.warnings.length}`);
	console.log(`  Validation issues:       ${validation.issues.length}`);

	const ok =
		preflight.issues.length === 0 && validation.issues.length === 0;
	console.log("");
	if (ok) {
		console.log(
			green(bold(`  RESULT: ${EXECUTE ? "ready to execute" : "dry-run OK"}`)),
		);
		if (!EXECUTE) {
			console.log(
				cyan(
					"\n  Next: re-run with --execute to perform `git mv` for each entry,",
				),
			);
			console.log(
				cyan(
					"  then run scripts/migration/rewrite-local-inference-imports.mjs to fix imports.",
				),
			);
		}
	} else {
		console.log(
			red(bold("  RESULT: NOT SAFE TO RUN — resolve issues above first")),
		);
	}
	console.log("");
	return ok;
}

// ── Execution ────────────────────────────────────────────────────────────────

function ensureDir(p) {
	if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function patchGitmodules() {
	const gmPath = abs(".gitmodules");
	if (!existsSync(gmPath)) {
		console.log(yellow("  .gitmodules not present, skipping"));
		return false;
	}
	let content = readFileSync(gmPath, "utf8");
	let patched = false;
	for (const m of MOVES) {
		if (!m.gitmodules) continue;
		const { old: oldPath, new: newPath } = m.gitmodules;
		// Patch both the [submodule "..."] header AND the `path = ...` line.
		const headerOld = `[submodule "${oldPath}"]`;
		const headerNew = `[submodule "${newPath}"]`;
		const pathOld = `path = ${oldPath}`;
		const pathNew = `path = ${newPath}`;
		if (content.includes(headerOld)) {
			content = content.replaceAll(headerOld, headerNew);
			patched = true;
		}
		if (content.includes(pathOld)) {
			content = content.replaceAll(pathOld, pathNew);
			patched = true;
		}
	}
	if (patched) {
		writeFileSync(gmPath, content);
		console.log(green("  .gitmodules patched"));
	} else {
		console.log(yellow("  no .gitmodules patch needed"));
	}
	return patched;
}

function execute(validation) {
	console.log(bold(cyan("\n=== Executing moves with git mv ===\n")));
	for (const m of validation.validated) {
		if (!m.ok) {
			console.log(red(`  SKIP: ${m.src} (validation failed)`));
			continue;
		}
		ensureDir(abs(dirname(m.dst)));
		console.log(cyan(`  git mv ${m.src} → ${m.dst}`));
		const res = git(["mv", m.src, m.dst], { allowFail: true });
		if (res.status !== 0) {
			console.log(red(`    ERROR: ${res.stderr.trim()}`));
		} else {
			console.log(green("    ok"));
		}
	}

	console.log(bold(cyan("\n=== Patching .gitmodules ===\n")));
	patchGitmodules();

	console.log(bold(cyan("\n=== Next steps ===\n")));
	console.log("  1. Run import-rewrite codemod:");
	console.log(
		cyan(
			"     node scripts/migration/rewrite-local-inference-imports.mjs --dry-run",
		),
	);
	console.log(
		cyan(
			"     node scripts/migration/rewrite-local-inference-imports.mjs --execute",
		),
	);
	console.log("");
	console.log("  2. Update package.json files in app-core, agent, examples (see plan §3)");
	console.log("");
	console.log("  3. Update postinstall scripts that reference old paths:");
	console.log(
		"     - plugins/plugin-local-inference/scripts/ensure-llama-cpp-submodule.mjs (submoduleRel constant)",
	);
	console.log("     - root package.json postinstall references");
	console.log("");
	console.log("  4. bun install (to refresh lockfile)");
	console.log("");
	console.log("  5. bun run verify && bun run test");
	console.log("");
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
	const pre = preflight();
	const validation = validateMoves();
	const ok = printReport({ preflight: pre, validation });

	if (!ok) {
		process.exit(1);
	}

	if (EXECUTE) {
		execute(validation);
	}
}

main();
