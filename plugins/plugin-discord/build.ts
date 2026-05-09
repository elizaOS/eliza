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

const proc = Bun.spawn(["bunx", "tsc", "--noCheck", "-p", "tsconfig.build.json"], {
	stdio: ["inherit", "inherit", "inherit"],
});

await proc.exited;

if (proc.exitCode !== 0) {
	process.exit(proc.exitCode ?? 1);
}

console.log("Build complete!");
