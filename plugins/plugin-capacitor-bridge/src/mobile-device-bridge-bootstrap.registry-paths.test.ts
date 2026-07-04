/**
 * Regression coverage for registry-backed local model path resolution.
 *
 * The bootstrap must survive iOS app-container migration: relative rows resolve
 * against the current local-inference root, while legacy absolute rows are
 * re-anchored by their stored suffix only when the artifact exists.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const savedStateDir = process.env.ELIZA_STATE_DIR;
const tempDirs: string[] = [];

afterEach(() => {
	if (savedStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
	else process.env.ELIZA_STATE_DIR = savedStateDir;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function useTempStateDir(): string {
	const stateDir = mkdtempSync(
		path.join(os.tmpdir(), "capacitor-bridge-registry-"),
	);
	tempDirs.push(stateDir);
	process.env.ELIZA_STATE_DIR = stateDir;
	return stateDir;
}

function writeLocalInferenceState(
	stateDir: string,
	storedModelPath: string,
): void {
	const root = path.join(stateDir, "local-inference");
	mkdirSync(root, { recursive: true });
	writeFileSync(
		path.join(root, "assignments.json"),
		JSON.stringify({
			version: 1,
			assignments: { TEXT_LARGE: "eliza-1-2b" },
		}),
	);
	writeFileSync(
		path.join(root, "registry.json"),
		JSON.stringify({
			version: 1,
			models: [
				{
					id: "eliza-1-2b",
					path: storedModelPath,
					source: "eliza-download",
				},
			],
		}),
	);
}

function createModelArtifact(stateDir: string): string {
	const modelPath = path.join(
		stateDir,
		"local-inference",
		"models",
		"eliza-1-2b.bundle",
		"text",
		"eliza-1-2b-128k.gguf",
	);
	mkdirSync(path.dirname(modelPath), { recursive: true });
	writeFileSync(modelPath, "fake-gguf");
	return modelPath;
}

describe("mobile device bridge registry model resolution (#11669)", () => {
	it("resolves a container-relative registry row against the current state dir", async () => {
		const stateDir = useTempStateDir();
		const modelPath = createModelArtifact(stateDir);
		writeLocalInferenceState(
			stateDir,
			"models/eliza-1-2b.bundle/text/eliza-1-2b-128k.gguf",
		);

		const { mobileDeviceBridge } = await import(
			"./mobile-device-bridge-bootstrap"
		);
		expect(mobileDeviceBridge.status().modelPath).toBe(modelPath);
	});

	it("re-anchors a legacy dead-container absolute row onto the current state dir", async () => {
		const stateDir = useTempStateDir();
		const modelPath = createModelArtifact(stateDir);
		writeLocalInferenceState(
			stateDir,
			"/var/mobile/Containers/Data/Application/5ED497DF-9A29-487F-A422-333997764963/Library/Application Support/Eliza/local-inference/models/eliza-1-2b.bundle/text/eliza-1-2b-128k.gguf",
		);

		const { mobileDeviceBridge } = await import(
			"./mobile-device-bridge-bootstrap"
		);
		expect(mobileDeviceBridge.status().modelPath).toBe(modelPath);
	});

	it("reports no model when the artifact is genuinely absent", async () => {
		const stateDir = useTempStateDir();
		// Registry row exists but no artifact anywhere under the current root.
		writeLocalInferenceState(
			stateDir,
			"models/eliza-1-2b.bundle/text/eliza-1-2b-128k.gguf",
		);

		const { mobileDeviceBridge } = await import(
			"./mobile-device-bridge-bootstrap"
		);
		expect(mobileDeviceBridge.status().modelPath).toBeNull();
	});
});
