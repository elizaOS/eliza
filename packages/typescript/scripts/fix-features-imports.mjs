#!/usr/bin/env node
/**
 * After moving capability packages under src/features/, fix relative imports:
 * - Imports to src/ (types, logger, …) need one extra ../
 * - Imports to sibling feature packages (autonomy, advanced-capabilities, …) stay as ../pkg
 * - ../features/x → ../x (strip redundant features/ segment)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "glob";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(__dirname, "..", "src");

const MOVED_PREFIXES = [
	"features/advanced-capabilities",
	"features/advanced-memory",
	"features/advanced-planning",
	"features/autonomy",
	"features/basic-capabilities",
];

const SIBLING_FEATURE_ROOTS = new Set([
	"autonomy",
	"advanced-capabilities",
	"advanced-memory",
	"advanced-planning",
	"basic-capabilities",
	"secrets",
	"trust",
	"plugin-manager",
	"knowledge",
	"trajectories",
]);

function fixRelativePath(rel) {
	if (!rel.startsWith(".")) return rel;
	// ./local — unchanged
	if (rel.startsWith("./")) return rel;

	const m = /^((?:\.\.\/)+)(.*)$/.exec(rel);
	if (!m) return rel;
	const chain = m[1];
	let rest = m[2];

	// ../features/foo → ../foo
	if (rest.startsWith("features/")) {
		rest = rest.slice("features/".length);
	}

	const firstSeg = rest.split("/")[0]?.split(".")[0] ?? "";
	if (firstSeg && SIBLING_FEATURE_ROOTS.has(firstSeg)) {
		return chain + rest;
	}
	return `../${chain}${rest}`;
}

const FROM_RE = /(?:from|export\s+\*\s+from)\s+["'](\.[^"']+)["']/g;

function fixFile(filePath) {
	let s = readFileSync(filePath, "utf8");
	const orig = s;
	s = s.replace(FROM_RE, (full, p) => {
		const fixed = fixRelativePath(p);
		if (fixed === p) return full;
		return full.replace(p, fixed);
	});
	if (s !== orig) {
		writeFileSync(filePath, s, "utf8");
		return true;
	}
	return false;
}

let changed = 0;
for (const prefix of MOVED_PREFIXES) {
	const pattern = join(srcRoot, prefix, "**/*.{ts,tsx}");
	for (const f of globSync(pattern, { windowsPathsNoEscape: true })) {
		if (fixFile(f)) {
			changed++;
			console.log("fixed", f.replace(srcRoot + "/", ""));
		}
	}
}
console.log(`Done. ${changed} files updated.`);
