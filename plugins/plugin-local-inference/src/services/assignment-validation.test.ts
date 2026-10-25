/** Exercises `setAssignment` validation — rejecting unfit/unservable model assignments — against a real temp state dir. No model. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	AssignmentRejectedError,
	readAssignments,
	setAssignment,
} from "./assignments";
import { elizaModelsDir } from "./paths";
import { upsertElizaModel } from "./registry";
import type { InstalledModel } from "./types";

const originalEnv = { ...process.env };

beforeEach(() => {
	process.env.ELIZA_STATE_DIR = fs.mkdtempSync(
		path.join(os.tmpdir(), "eliza-assignment-validate-"),
	);
	// Default to a desktop host (no explicit-modelPath generic binding).
	delete process.env.ELIZA_PLATFORM;
});

afterEach(() => {
	const dir = process.env.ELIZA_STATE_DIR;
	process.env = { ...originalEnv };
	if (dir?.includes("eliza-assignment-validate-")) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

async function registerForeignModel(): Promise<InstalledModel> {
	// A model whose id is NOT a curated Eliza-1 tier. The setAssignment boundary
	// must reject it — the local stack is Eliza-1 only (#8808).
	const dir = elizaModelsDir();
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, "llama-3.2-3b-q4.gguf");
	fs.writeFileSync(filePath, "gguf");
	const model: InstalledModel = {
		id: "hf:meta-llama/Llama-3.2-3B-Instruct-GGUF::Llama-3.2-3B-Instruct-Q4_K_M.gguf",
		displayName: "Llama-3.2-3B-Instruct",
		path: filePath,
		sizeBytes: 4,
		installedAt: new Date().toISOString(),
		lastUsedAt: null,
		source: "eliza-download",
	};
	await upsertElizaModel(model);
	return model;
}

async function registerFusedModel(): Promise<InstalledModel> {
	const bundleRoot = path.join(elizaModelsDir(), "eliza-1-4b");
	const textDir = path.join(bundleRoot, "text");
	fs.mkdirSync(textDir, { recursive: true });
	const filePath = path.join(textDir, "eliza-1-4b-128k.gguf");
	fs.writeFileSync(filePath, "gguf");
	const model: InstalledModel = {
		id: "eliza-1-4b",
		displayName: "eliza-1-4b",
		path: filePath,
		sizeBytes: 4,
		bundleRoot,
		installedAt: new Date().toISOString(),
		lastUsedAt: null,
		source: "eliza-download",
		runtimeClass: "fused-eliza1",
	};
	await upsertElizaModel(model);
	return model;
}

// (Removed "canServeRuntimeClassOnHost" suite — the generic-gguf runtime
// class + its host-servability helper were retired in the eliza-1-only
// cutover (#8808/#9033). The setAssignment boundary tests below now own the
// "non-eliza-1 models are rejected" contract.)

describe("setAssignment boundary validation", () => {
	it("rejects a non-Eliza-1 model on desktop before assignment writes", async () => {
		const model = await registerForeignModel();
		await expect(setAssignment("TEXT_LARGE", model.id)).rejects.toBeInstanceOf(
			AssignmentRejectedError,
		);
		// Nothing was written.
		expect(await readAssignments()).toEqual({});
	});

	it("rejects a non-Eliza-1 model on mobile too", async () => {
		process.env.ELIZA_PLATFORM = "ios";
		const model = await registerForeignModel();
		await expect(setAssignment("TEXT_LARGE", model.id)).rejects.toThrow(
			/curated Eliza-1/i,
		);
		expect(await readAssignments()).toEqual({});
	});

	it("always accepts a fused Eliza-1 model on desktop", async () => {
		const model = await registerFusedModel();
		const next = await setAssignment("TEXT_LARGE", model.id);
		expect(next.TEXT_LARGE).toBe(model.id);
	});

	it("allows a not-yet-installed catalog id through (policy, not load)", async () => {
		// An id that is not in the registry is a declared policy; the readiness
		// layer surfaces the missing file separately — validation must not block.
		const next = await setAssignment("TEXT_SMALL", "eliza-1-9b");
		expect(next.TEXT_SMALL).toBe("eliza-1-9b");
	});

	it("clearing a slot is never gated", async () => {
		const model = await registerFusedModel();
		await setAssignment("TEXT_LARGE", model.id);
		delete process.env.ELIZA_PLATFORM; // back to desktop
		const next = await setAssignment("TEXT_LARGE", null);
		expect(next.TEXT_LARGE).toBeUndefined();
	});
});
