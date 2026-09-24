/**
 * Implementation hash gate for native sources copied into the llama.cpp fork.
 * Repository-relative documentation can differ; adapted code needs provenance.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

interface OwnershipFamily {
	name: string;
	ownerRoot: string;
	mirrorRoot: string;
	exact: string[];
	adapted: Array<{ file: string; reason: string }>;
	standalone?: Array<{ file: string; owner: string; reason: string }>;
}

interface OwnershipManifest {
	version: number;
	families: OwnershipFamily[];
}

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const manifestPath = resolve(
	repositoryRoot,
	"plugins/plugin-local-inference/native/copied-source-ownership.json",
);
const manifest = JSON.parse(
	readFileSync(manifestPath, "utf8"),
) as OwnershipManifest;

function implementationHash(source: string): string {
	// Protect quoted literals before removing C comments. Replace comments with
	// whitespace so a comment separating identifiers cannot concatenate them.
	const implementation = source.replace(
		/("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
		(_match, literal: string | undefined) => literal ?? " ",
	);
	return createHash("sha256").update(implementation).digest("hex");
}

function sha256(path: string): string {
	return implementationHash(readFileSync(path, "utf8"));
}

const nativeSourceExtensions = new Set([
	".c",
	".cc",
	".cpp",
	".cu",
	".cuh",
	".h",
	".hpp",
	".m",
	".metal",
	".mm",
]);

function listNativeSources(root: string, current = root): string[] {
	const sources: string[] = [];
	for (const entry of readdirSync(current, { withFileTypes: true })) {
		const path = resolve(current, entry.name);
		if (entry.isDirectory()) {
			sources.push(...listNativeSources(root, path));
		} else if (
			entry.isFile() &&
			nativeSourceExtensions.has(extname(entry.name))
		) {
			sources.push(relative(root, path));
		}
	}
	return sources.sort();
}

function ownedPath(root: string, file: string): string {
	expect(isAbsolute(file), `${file} must be relative`).toBe(false);
	const resolvedRoot = resolve(repositoryRoot, root);
	const resolvedFile = resolve(resolvedRoot, file);
	expect(
		resolvedFile.startsWith(`${resolvedRoot}${sep}`),
		`${file} must stay inside ${root}`,
	).toBe(true);
	return resolvedFile;
}

function expectFile(path: string, label: string): void {
	expect(existsSync(path), `${label} does not exist`).toBe(true);
	if (existsSync(path)) expect(statSync(path).isFile(), label).toBe(true);
}

describe("native copied-source ownership", () => {
	it("ignores documentation changes but preserves code and literal bytes", () => {
		expect(implementationHash("/* old path */ int value = 1;")).toBe(
			implementationHash("/* relocated path */ int value = 1;"),
		);
		expect(
			implementationHash('const char *value = "/* original */";'),
		).not.toBe(implementationHash('const char *value = "/* changed */";'));
		expect(implementationHash("int value = 1;")).not.toBe(
			implementationHash("int value = 2;"),
		);
		expect(implementationHash("int/**/value;")).not.toBe(
			implementationHash("intvalue;"),
		);
	});
	it("uses a complete, non-overlapping classification schema", () => {
		expect(manifest.version).toBe(1);
		const familyNames = new Set<string>();
		for (const family of manifest.families) {
			expect(familyNames.has(family.name), family.name).toBe(false);
			familyNames.add(family.name);
			const classified = [
				...family.exact,
				...family.adapted.map(({ file }) => file),
				...(family.standalone ?? []).map(({ file }) => file),
			];
			expect(new Set(classified).size, family.name).toBe(classified.length);
			for (const entry of family.adapted) {
				expect(entry.reason.trim(), `${family.name}/${entry.file} reason`).toBe(
					entry.reason,
				);
				expect(
					entry.reason.length,
					`${family.name}/${entry.file} reason`,
				).toBeGreaterThan(10);
			}
			for (const entry of family.standalone ?? []) {
				expect(entry.owner.trim(), `${family.name}/${entry.file} owner`).toBe(
					entry.owner,
				);
				expect(
					entry.owner.length,
					`${family.name}/${entry.file} owner`,
				).toBeGreaterThan(0);
				const ownerPackage = ownedPath(".", entry.owner);
				expect(
					existsSync(ownerPackage) && statSync(ownerPackage).isDirectory(),
					`${family.name}/${entry.file} owner package does not exist`,
				).toBe(true);
				expect(
					ownedPath(family.ownerRoot, entry.file).startsWith(
						`${ownerPackage}${sep}`,
					),
					`${family.name}/${entry.file} is outside its declared owner`,
				).toBe(true);
				expect(entry.reason.trim(), `${family.name}/${entry.file} reason`).toBe(
					entry.reason,
				);
				expect(
					entry.reason.length,
					`${family.name}/${entry.file} reason`,
				).toBeGreaterThan(10);
			}
		}
	});

	for (const family of manifest.families) {
		it(`${family.name} exact implementations match their canonical owner`, () => {
			for (const file of family.exact) {
				const mirrorPath = ownedPath(family.mirrorRoot, file);
				const ownerPath = ownedPath(family.ownerRoot, file);
				expectFile(mirrorPath, `${family.name}/${file} mirror`);
				expectFile(ownerPath, `${family.name}/${file} owner`);
				expect(sha256(mirrorPath), `${family.name}/${file}`).toBe(
					sha256(ownerPath),
				);
			}
		});

		it(`${family.name} adapted mirrors and standalone sources have explicit provenance`, () => {
			for (const entry of family.adapted) {
				expectFile(
					ownedPath(family.ownerRoot, entry.file),
					`${family.name}/${entry.file} owner`,
				);
				expectFile(
					ownedPath(family.mirrorRoot, entry.file),
					`${family.name}/${entry.file} mirror`,
				);
			}
			for (const entry of family.standalone ?? []) {
				expectFile(
					ownedPath(family.ownerRoot, entry.file),
					`${family.name}/${entry.file} standalone owner`,
				);
				expect(
					existsSync(ownedPath(family.mirrorRoot, entry.file)),
					`${family.name}/${entry.file} is classified standalone but has a mirror`,
				).toBe(false);
			}
		});

		it(`${family.name} inventories every native source copied between its roots`, () => {
			const ownerRoot = resolve(repositoryRoot, family.ownerRoot);
			const mirrorRoot = resolve(repositoryRoot, family.mirrorRoot);
			const ownerSources = new Set(listNativeSources(ownerRoot));
			const copiedSources = listNativeSources(mirrorRoot).filter((file) =>
				ownerSources.has(file),
			);
			const declaredCopies = [
				...family.exact,
				...family.adapted.map(({ file }) => file),
			].sort();
			expect(declaredCopies, family.name).toEqual(copiedSources);
		});
	}
});
