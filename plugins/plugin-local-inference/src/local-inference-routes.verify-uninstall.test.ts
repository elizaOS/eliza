/**
 * The agent-mounted local-inference management surface must report and remove
 * installed models with the same semantics as the local-inference service:
 * a hash mismatch is a mismatch, and uninstalling an Eliza-1 bundle removes the
 * whole bundle directory, not only its text weights. Real filesystem, temp
 * ELIZA_STATE_DIR, no mocks.
 */
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyLocalInferenceManagementMutation } from "./local-inference-routes.js";
import { readEffectiveAssignments } from "./services/assignments.js";

const originalStateDir = process.env.ELIZA_STATE_DIR;
let tempStateDir: string;

function localInferenceRoot(): string {
	return path.join(tempStateDir, "local-inference");
}

function writeRegistry(models: Array<Record<string, unknown>>): void {
	writeFileSync(
		path.join(localInferenceRoot(), "registry.json"),
		JSON.stringify({ version: 1, models }),
	);
}

describe("local-inference management verify and uninstall", () => {
	beforeEach(() => {
		tempStateDir = mkdtempSync(path.join(tmpdir(), "eliza-li-verify-"));
		process.env.ELIZA_STATE_DIR = tempStateDir;
		mkdirSync(localInferenceRoot(), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempStateDir, { recursive: true, force: true });
		if (originalStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
		else process.env.ELIZA_STATE_DIR = originalStateDir;
	});

	it("reports a model whose bytes no longer match its recorded hash as a mismatch", async () => {
		const rel = "models/eliza-1-2b.gguf";
		const abs = path.join(localInferenceRoot(), rel);
		mkdirSync(path.dirname(abs), { recursive: true });
		const original = Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(1024)]);
		writeFileSync(abs, original);
		writeRegistry([
			{
				id: "eliza-1-2b",
				displayName: "Eliza-1 2B",
				path: rel,
				sizeBytes: original.length,
				sha256: createHash("sha256").update(original).digest("hex"),
				installedAt: "2026-05-17T06:17:00.000Z",
				lastUsedAt: null,
				source: "eliza-download",
			},
		]);
		const corrupted = Buffer.from(original);
		corrupted[100] = 1;
		writeFileSync(abs, corrupted);

		const result = await applyLocalInferenceManagementMutation({
			op: "verify_model",
			modelId: "eliza-1-2b",
		});

		expect(result).toMatchObject({ op: "verify_model", state: "mismatch" });
	});

	it("removes the whole Eliza-1 bundle directory on uninstall", async () => {
		const bundleRoot = path.join(
			localInferenceRoot(),
			"models",
			"eliza-1-2b.bundle",
		);
		for (const rel of [
			"text/eliza-1-e2b-128k.gguf",
			"tts/voice.gguf",
			"asr/asr.gguf",
			"eliza-1.manifest.json",
		]) {
			mkdirSync(path.dirname(path.join(bundleRoot, rel)), { recursive: true });
			writeFileSync(
				path.join(bundleRoot, rel),
				Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64)]),
			);
		}
		writeRegistry([
			{
				id: "eliza-1-2b",
				displayName: "Eliza-1 2B",
				path: "models/eliza-1-2b.bundle/text/eliza-1-e2b-128k.gguf",
				sizeBytes: 68,
				installedAt: "2026-05-17T06:17:00.000Z",
				lastUsedAt: null,
				source: "eliza-download",
				bundleRoot: "models/eliza-1-2b.bundle",
				manifestPath: "models/eliza-1-2b.bundle/eliza-1.manifest.json",
			},
		]);

		const result = await applyLocalInferenceManagementMutation({
			op: "uninstall_model",
			modelId: "eliza-1-2b",
		});

		expect(result).toMatchObject({ op: "uninstall_model", removed: true });
		expect(existsSync(bundleRoot)).toBe(false);
		const registry = JSON.parse(
			readFileSync(path.join(localInferenceRoot(), "registry.json"), "utf8"),
		);
		expect(registry.models).toEqual([]);
	});

	it("drops the uninstalled model from saved slot assignments", async () => {
		const models = ["eliza-1-2b", "eliza-1-4b"].map((id) => {
			const rel = `models/${id}.gguf`;
			const bytes = Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64)]);
			mkdirSync(path.dirname(path.join(localInferenceRoot(), rel)), {
				recursive: true,
			});
			writeFileSync(path.join(localInferenceRoot(), rel), bytes);
			return {
				id,
				displayName: id,
				path: rel,
				sizeBytes: bytes.length,
				installedAt: "2026-05-17T06:17:00.000Z",
				lastUsedAt: null,
				source: "eliza-download",
				bundleVerifiedAt: "2026-05-17T06:17:00.000Z",
			};
		});
		writeRegistry(models);
		writeFileSync(
			path.join(localInferenceRoot(), "assignments.json"),
			JSON.stringify({
				version: 1,
				assignments: {
					TEXT_SMALL: "eliza-1-2b",
					TEXT_LARGE: "eliza-1-4b",
					TEXT_TO_SPEECH: "eliza-1-2b",
					TRANSCRIPTION: "eliza-1-2b",
				},
			}),
		);

		const result = await applyLocalInferenceManagementMutation({
			op: "uninstall_model",
			modelId: "eliza-1-2b",
		});

		expect(result).toMatchObject({ op: "uninstall_model", removed: true });
		const saved = JSON.parse(
			readFileSync(path.join(localInferenceRoot(), "assignments.json"), "utf8"),
		);
		expect(saved.assignments).toEqual({ TEXT_LARGE: "eliza-1-4b" });
		expect(await readEffectiveAssignments()).toEqual({
			TEXT_SMALL: "eliza-1-4b",
			TEXT_LARGE: "eliza-1-4b",
			TEXT_TO_SPEECH: "eliza-1-4b",
			TRANSCRIPTION: "eliza-1-4b",
		});
	});
});
