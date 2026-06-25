#!/usr/bin/env bun

import { rmSync } from "node:fs";
import { build } from "bun";

try {
	rmSync("dist", { recursive: true, force: true });
} catch {
	// ignore
}

const pkg = await Bun.file("./package.json").json();
const external = [
	...Object.keys(pkg.dependencies ?? {}),
	...Object.keys(pkg.peerDependencies ?? {}),
];

console.log("Building TypeScript plugin...");

const result = await build({
	entrypoints: ["index.ts"],
	outdir: "dist",
	target: "node",
	format: "esm",
	sourcemap: "external",
	minify: false,
	external,
});

if (!result.success) {
	console.error("Build failed:");
	for (const log of result.logs) {
		console.error(log);
	}
	process.exit(1);
}

const proc = Bun.spawn(
	["bunx", "tsc", "--noCheck", "-p", "tsconfig.build.json"],
	{
		stdio: ["inherit", "inherit", "inherit"],
	},
);

await proc.exited;

if (proc.exitCode !== 0) {
	process.exit(proc.exitCode ?? 1);
}

// Rewrite bare relative specifiers in the emitted .d.ts files to explicit
// NodeNext-resolvable paths (`./x` -> `./x.js`, `./dir` -> `./dir/index.js`).
// The single-entrypoint bundle emits one dist/index.js but per-file .d.ts
// declarations, whose re-exports otherwise stay bare and fail to resolve for
// NodeNext consumers (e.g. plugin-personal-assistant importing the CDP helpers).
const rewrite = Bun.spawn(
	["node", "../../packages/scripts/rewrite-dist-relative-imports-node-esm.mjs"],
	{ stdio: ["inherit", "inherit", "inherit"] },
);

await rewrite.exited;

if (rewrite.exitCode !== 0) {
	process.exit(rewrite.exitCode ?? 1);
}

console.log("Build complete!");
