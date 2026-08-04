#!/usr/bin/env node
/**
 * Keeps generated JavaScript and declaration output out of the core source
 * tree. Cleanup mode removes stray compiler artifacts; `--check` fails when
 * any remain so package builds cannot silently repopulate `src/`.
 */

import { readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const srcRoot = path.join(pkgRoot, "src");
const preserveRoot = path.join(srcRoot, "types", "generated");

const EXTS = new Set([".js", ".js.map", ".d.ts", ".d.ts.map"]);

function endsWithAny(name) {
	for (const ext of EXTS) if (name.endsWith(ext)) return true;
	return false;
}

function findArtifacts(dir, artifacts = []) {
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			// Protobuf declarations are source inputs, not package build output.
			if (full === preserveRoot) continue;
			findArtifacts(full, artifacts);
			continue;
		}
		if (!entry.isFile()) continue;
		if (!endsWithAny(entry.name)) continue;
		artifacts.push(full);
	}
	return artifacts;
}

const artifacts = findArtifacts(srcRoot);
if (process.argv.includes("--check")) {
	if (artifacts.length > 0) {
		throw new Error(
			`Generated compiler artifacts found under src/:\n${artifacts.join("\n")}`,
		);
	}
} else {
	for (const artifact of artifacts) unlinkSync(artifact);
}
