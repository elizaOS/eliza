#!/usr/bin/env node
/**
 * Root `bun run dev`: link git submodule plugins for editing, install deps, build plugin
 * dist/ if missing, then start the agent harness in watch mode.
 *
 * For registry-only plugins (no submodules), use `bun run plugin-submodules:restore` and commit.
 */

import { existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const INSTALL_STAMP = join(ROOT, ".eliza", "plugin-dev-needs-install");

const PLUGIN_TYPESCRIPT = [
	"plugins/plugin-sql/typescript",
	"plugins/plugin-ollama/typescript",
	"plugins/plugin-local-ai/typescript",
];

function run(cmd, args, opts = {}) {
	execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
}

console.log("[dev] plugin submodules + workspace deps…\n");
run("bun", ["scripts/plugin-submodules-dev.mjs"]);

const nodeModules = join(ROOT, "node_modules");
const needsInstall = !existsSync(nodeModules) || existsSync(INSTALL_STAMP);
if (needsInstall) {
	console.log("\n[dev] bun install…\n");
	run("bun", ["install"]);
	if (existsSync(INSTALL_STAMP)) {
		try {
			unlinkSync(INSTALL_STAMP);
		} catch {
			/* ignore */
		}
	}
} else {
	console.log("\n[dev] bun install skipped (deps unchanged)\n");
}

const coreDist = join(ROOT, "packages", "typescript", "dist");
if (!existsSync(coreDist)) {
	console.log("\n[dev] building `@elizaos/core` (no dist/)…\n");
	run("bun", ["run", "build:core"]);
}

for (const rel of PLUGIN_TYPESCRIPT) {
	const dir = join(ROOT, rel);
	if (!existsSync(join(dir, "package.json"))) {
		continue;
	}
	if (!existsSync(join(dir, "dist"))) {
		console.log(`\n[dev] building ${rel} (no dist/)…\n`);
		run("bun", ["run", "build"], { cwd: dir });
	}
}

console.log("\n[dev] agent harness (watch)…\n");
run("bun", ["run", "--cwd", "packages/agent", "dev"]);
