/**
 * Regression coverage for persisted local-inference model paths.
 *
 * Registry rows survive iOS app-container migration by storing relative paths;
 * legacy absolute rows are re-anchored by their `/local-inference/` suffix only
 * when the artifact exists under the current state directory.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	normalizeStoredRelativeModelPath,
	resolveStoredModelPath,
	storedModelPathCandidates,
	toStoredModelPath,
} from "./local-inference-stored-path.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeRoot(prefix: string): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return path.join(dir, "local-inference");
}

function writeModel(root: string, relative: string): string {
	const absolute = path.join(root, ...relative.split("/"));
	mkdirSync(path.dirname(absolute), { recursive: true });
	writeFileSync(absolute, "fake-gguf");
	return absolute;
}

describe("normalizeStoredRelativeModelPath", () => {
	it("normalizes relative rows and rejects traversal, absolute, and empty input", () => {
		expect(normalizeStoredRelativeModelPath("models/a/b.gguf")).toBe(
			"models/a/b.gguf",
		);
		expect(normalizeStoredRelativeModelPath("models\\a\\b.gguf")).toBe(
			"models/a/b.gguf",
		);
		expect(normalizeStoredRelativeModelPath("models//a//b.gguf")).toBe(
			"models/a/b.gguf",
		);
		expect(normalizeStoredRelativeModelPath("../escape.gguf")).toBeNull();
		expect(normalizeStoredRelativeModelPath("models/../x.gguf")).toBeNull();
		expect(normalizeStoredRelativeModelPath("/abs/x.gguf")).toBeNull();
		expect(normalizeStoredRelativeModelPath("C:\\abs\\x.gguf")).toBeNull();
		expect(normalizeStoredRelativeModelPath("")).toBeNull();
	});
});

describe("toStoredModelPath", () => {
	it("round-trips an absolute path under the root to relative and back", () => {
		const root = makeRoot("stored-path-roundtrip-");
		const absolute = writeModel(root, "models/eliza-1-2b.bundle/text/m.gguf");
		const stored = toStoredModelPath(absolute, root);
		expect(stored).toBe("models/eliza-1-2b.bundle/text/m.gguf");
		expect(resolveStoredModelPath(stored ?? "", root)).toBe(absolute);
	});

	it("rejects paths outside the root and the root itself", () => {
		const root = makeRoot("stored-path-outside-");
		expect(toStoredModelPath("/somewhere/else/m.gguf", root)).toBeNull();
		expect(toStoredModelPath(root, root)).toBeNull();
	});
});

describe("resolveStoredModelPath", () => {
	it("resolves a relative row against the current root", () => {
		const root = makeRoot("stored-path-relative-");
		const absolute = writeModel(root, "models/eliza-1-2b.bundle/text/m.gguf");
		expect(
			resolveStoredModelPath("models/eliza-1-2b.bundle/text/m.gguf", root),
		).toBe(absolute);
	});

	it("re-anchors a legacy absolute row from a dead container onto the current root", () => {
		const currentRoot = makeRoot("stored-path-current-");
		const absolute = writeModel(
			currentRoot,
			"models/eliza-1-2b.bundle/text/eliza-1-2b-128k.gguf",
		);
		// The dead-container path from the issue: the UUID no longer exists.
		const legacy =
			"/var/mobile/Containers/Data/Application/5ED497DF-9A29-487F-A422-333997764963/Library/Application Support/Eliza/local-inference/models/eliza-1-2b.bundle/text/eliza-1-2b-128k.gguf";
		expect(resolveStoredModelPath(legacy, currentRoot)).toBe(absolute);
	});

	it("returns null when the artifact is genuinely absent (real not-downloaded state)", () => {
		const currentRoot = makeRoot("stored-path-missing-");
		mkdirSync(currentRoot, { recursive: true });
		expect(
			resolveStoredModelPath(
				"models/eliza-1-2b.bundle/text/m.gguf",
				currentRoot,
			),
		).toBeNull();
		expect(
			resolveStoredModelPath(
				"/dead/container/local-inference/models/m.gguf",
				currentRoot,
			),
		).toBeNull();
	});

	it("accepts a live absolute row verbatim", () => {
		const root = makeRoot("stored-path-verbatim-");
		const absolute = writeModel(root, "models/m.gguf");
		expect(resolveStoredModelPath(absolute, root)).toBe(absolute);
	});

	it("probes through an injected exists predicate", () => {
		const probed: string[] = [];
		const resolved = resolveStoredModelPath(
			"models/m.gguf",
			"/current/local-inference",
			(candidate) => {
				probed.push(candidate);
				return true;
			},
		);
		expect(resolved).toBe(
			path.join("/current/local-inference", "models", "m.gguf"),
		);
		expect(probed).toEqual([
			path.join("/current/local-inference", "models", "m.gguf"),
		]);
	});
});

describe("storedModelPathCandidates", () => {
	it("adds the /private/var alias for simulator container paths", () => {
		const candidates = storedModelPathCandidates(
			"/private/var/containers/local-inference/models/m.gguf",
			"/current/local-inference",
		);
		expect(candidates).toContain(
			"/var/containers/local-inference/models/m.gguf",
		);
		expect(candidates).toContain(
			path.join("/current/local-inference", "models", "m.gguf"),
		);
	});

	it("never maps traversal rows into the root", () => {
		expect(
			storedModelPathCandidates("../../etc/passwd", "/current/local-inference"),
		).toEqual([]);
	});
});
