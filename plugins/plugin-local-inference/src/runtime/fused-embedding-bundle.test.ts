/**
 * Exercises fused embedding bundle staging against real temporary files so
 * artifact replacement and inode ownership are proven without filesystem mocks.
 */

import {
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveFusedEmbeddingBundleRoot } from "./fused-embedding-bundle";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(path.join(os.tmpdir(), "eliza-embed-bundle-"));
	temporaryRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("resolveFusedEmbeddingBundleRoot", () => {
	it("stages the configured model as the bundle's sole text artifact", () => {
		const modelsDir = temporaryRoot();
		const model = "gte-small.gguf";
		const source = path.join(modelsDir, model);
		writeFileSync(source, "current-model");

		const root = resolveFusedEmbeddingBundleRoot({ modelsDir, model });
		const staged = path.join(root ?? "", "text", model);

		expect(root).toBe(path.join(modelsDir, ".eliza-embed-bundle"));
		expect(readFileSync(staged, "utf8")).toBe("current-model");
		expect(statSync(staged).ino).toBe(statSync(source).ino);
	});

	it("replaces a staged hardlink after the downloader replaces its source inode", () => {
		const modelsDir = temporaryRoot();
		const model = "gte-small.gguf";
		const source = path.join(modelsDir, model);
		writeFileSync(source, "truncated");
		const root = path.join(modelsDir, ".eliza-embed-bundle");
		const staged = path.join(root, "text", model);
		mkdirSync(path.dirname(staged), { recursive: true });
		linkSync(source, staged);
		const obsoleteInode = statSync(staged).ino;

		unlinkSync(source);
		writeFileSync(source, "complete-model-artifact");
		expect(statSync(source).ino).not.toBe(obsoleteInode);

		expect(resolveFusedEmbeddingBundleRoot({ modelsDir, model })).toBe(root);
		expect(readFileSync(staged, "utf8")).toBe("complete-model-artifact");
		expect(statSync(staged).ino).toBe(statSync(source).ino);
	});

	it("honors an explicit native bundle root without staging another model", () => {
		const modelsDir = temporaryRoot();
		const override = path.join(modelsDir, "operator-bundle");
		mkdirSync(path.join(override, "text"), { recursive: true });

		expect(
			resolveFusedEmbeddingBundleRoot({
				modelsDir,
				model: "missing.gguf",
				override,
			}),
		).toBe(override);
	});

	it("returns null when neither a bundle nor the configured model exists", () => {
		const modelsDir = temporaryRoot();
		expect(
			resolveFusedEmbeddingBundleRoot({
				modelsDir,
				model: "missing.gguf",
			}),
		).toBeNull();
	});
});
