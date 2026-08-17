/**
 * Exercises fused embedding bundle staging against real temporary files so
 * artifact replacement and inode ownership are proven without filesystem mocks.
 */

import { createHash } from "node:crypto";
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
import {
	assertEmbeddingArtifactIdentity,
	resolveFusedEmbeddingBundleRoot,
} from "./fused-embedding-bundle";

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
	it("rejects renamed same-width bytes that do not match the reviewed digest", () => {
		const modelsDir = temporaryRoot();
		const model = "bge-small-en-v1.5-q4_k_m.gguf";
		const source = path.join(modelsDir, model);
		writeFileSync(source, "arbitrary renamed bytes");

		expect(() =>
			assertEmbeddingArtifactIdentity(source, 23, "0".repeat(64)),
		).toThrow(/sha256 mismatch/i);
	});

	it("accepts only bytes matching both the pinned size and digest", () => {
		const modelsDir = temporaryRoot();
		const source = path.join(modelsDir, "fixture.gguf");
		const bytes = "reviewed fixture";
		writeFileSync(source, bytes);
		const digest = createHash("sha256").update(bytes).digest("hex");

		expect(() =>
			assertEmbeddingArtifactIdentity(source, Buffer.byteLength(bytes), digest),
		).not.toThrow();
	});

	it("stages the configured model as the bundle's sole text artifact", () => {
		const modelsDir = temporaryRoot();
		const model = "bge-small.gguf";
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
		const model = "bge-small.gguf";
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

	it("honors an exact canonical native bundle root without staging another model", () => {
		const modelsDir = temporaryRoot();
		const override = path.join(modelsDir, "operator-bundle");
		const model = "bge-small-en-v1.5-q4_k_m.gguf";
		mkdirSync(path.join(override, "text"), { recursive: true });
		writeFileSync(path.join(override, "text", model), "canonical-model");

		expect(
			resolveFusedEmbeddingBundleRoot({
				modelsDir,
				model,
				override,
			}),
		).toBe(override);
	});

	it("rejects an arbitrary or ambiguous native bundle override", () => {
		const modelsDir = temporaryRoot();
		const override = path.join(modelsDir, "operator-bundle");
		mkdirSync(path.join(override, "text"), { recursive: true });
		writeFileSync(path.join(override, "text", "gte-small_fp16.gguf"), "legacy");

		expect(() =>
			resolveFusedEmbeddingBundleRoot({
				modelsDir,
				model: "bge-small-en-v1.5-q4_k_m.gguf",
				override,
			}),
		).toThrow(/must contain exactly text\/bge-small-en-v1\.5-q4_k_m\.gguf/);
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
