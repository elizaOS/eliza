/**
 * Hash gate for native sources copied from canonical standalone packages into
 * the integrated llama.cpp fork. Adapted fork files require recorded reasons.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface OwnershipFamily {
	name: string;
	ownerRoot: string;
	mirrorRoot: string;
	exact: string[];
	adapted: Array<{ file: string; reason: string }>;
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

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("native copied-source ownership", () => {
	for (const family of manifest.families) {
		it(`${family.name} exact mirrors match their canonical owner byte-for-byte`, () => {
			for (const file of family.exact) {
				expect(
					sha256(resolve(repositoryRoot, family.mirrorRoot, file)),
					`${family.name}/${file}`,
				).toBe(sha256(resolve(repositoryRoot, family.ownerRoot, file)));
			}
		});
	}
});
