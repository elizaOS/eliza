import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	AssignmentNotServableError,
	canServeRuntimeClassOnHost,
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

async function registerGenericModel(): Promise<InstalledModel> {
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
		runtimeClass: "generic-gguf",
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

describe("canServeRuntimeClassOnHost", () => {
	it("serves fused Eliza-1 everywhere", async () => {
		expect(await canServeRuntimeClassOnHost("fused-eliza1")).toBe(true);
	});

	it("refuses generic GGUF on desktop (no explicit-modelPath binding)", async () => {
		delete process.env.ELIZA_PLATFORM;
		expect(await canServeRuntimeClassOnHost("generic-gguf")).toBe(false);
	});

	it("serves generic GGUF on mobile (capacitor explicit-path binding)", async () => {
		process.env.ELIZA_PLATFORM = "android";
		expect(await canServeRuntimeClassOnHost("generic-gguf")).toBe(true);
	});
});

describe("setAssignment boundary validation", () => {
	it("rejects a generic GGUF on desktop with a typed reason", async () => {
		const model = await registerGenericModel();
		await expect(setAssignment("TEXT_LARGE", model.id)).rejects.toBeInstanceOf(
			AssignmentNotServableError,
		);
		// Nothing was written.
		expect(await readAssignments()).toEqual({});
	});

	it("accepts a generic GGUF on mobile", async () => {
		process.env.ELIZA_PLATFORM = "ios";
		const model = await registerGenericModel();
		const next = await setAssignment("TEXT_LARGE", model.id);
		expect(next.TEXT_LARGE).toBe(model.id);
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
		process.env.ELIZA_PLATFORM = "ios";
		const model = await registerGenericModel();
		await setAssignment("TEXT_LARGE", model.id);
		delete process.env.ELIZA_PLATFORM; // back to desktop
		const next = await setAssignment("TEXT_LARGE", null);
		expect(next.TEXT_LARGE).toBeUndefined();
	});
});
