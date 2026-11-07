/**
 * The Embeddings row of the routing settings offers "Cloud only" and a manual
 * provider pin. The router keeps only the on-device embedder for
 * TEXT_EMBEDDING unless the operator sets ELIZAOS_CLOUD_USE_EMBEDDINGS, so it
 * must still honour the user's own explicit choice of another provider, while
 * the default policy keeps embeddings on-device.
 *
 * Runs the real router on a real AgentRuntime, with the policy written to a
 * real routing.json under a temporary state dir.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AgentRuntime, ModelType } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installRouterHandler } from "./router-handler";
import { setPolicy, setPreferredProvider } from "./routing-preferences";

const ENV_KEYS = [
	"ELIZA_STATE_DIR",
	"ELIZAOS_CLOUD_USE_EMBEDDINGS",
	"ELIZA_LOCAL_ONLY",
] as const;
const priorEnv = new Map<string, string | undefined>();
let stateDir: string;

beforeEach(() => {
	stateDir = mkdtempSync(path.join(tmpdir(), "router-embedding-policy-"));
	for (const key of ENV_KEYS) priorEnv.set(key, process.env[key]);
	process.env.ELIZA_STATE_DIR = stateDir;
	delete process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS;
	delete process.env.ELIZA_LOCAL_ONLY;
});

afterEach(() => {
	for (const [key, value] of priorEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(stateDir, { recursive: true, force: true });
});

const VECTOR = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));

function makeRuntime(options: { cloudThrows?: boolean } = {}): {
	runtime: AgentRuntime;
	calls: string[];
} {
	const runtime = createSQLiteTestRuntime({
		character: {
			name: "EmbeddingPolicyTest",
			bio: "embedding routing policy test",
			settings: {},
		} as never,
		logLevel: "fatal",
	});
	const calls: string[] = [];
	runtime.registerModel(
		ModelType.TEXT_EMBEDDING,
		async () => {
			calls.push("eliza-local-inference");
			return VECTOR;
		},
		"eliza-local-inference",
		0,
	);
	runtime.registerModel(
		ModelType.TEXT_EMBEDDING,
		async () => {
			calls.push("openai");
			if (options.cloudThrows) throw new Error("openai embeddings failed");
			return VECTOR;
		},
		"openai",
		0,
	);
	installRouterHandler(runtime);
	return { runtime, calls };
}

describe("router TEXT_EMBEDDING routing policy", () => {
	it("keeps embeddings on the local embedder under the default policy", async () => {
		const { runtime, calls } = makeRuntime();

		await runtime.useModel(ModelType.TEXT_EMBEDDING, { text: "hello" });

		expect(calls).toEqual(["eliza-local-inference"]);
	});

	it("sends embeddings to the cloud embedder under Cloud only", async () => {
		await setPolicy("TEXT_EMBEDDING", "cloud-only");
		const { runtime, calls } = makeRuntime();

		const vector = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
			text: "hello",
		});

		expect(vector).toEqual(VECTOR);
		expect(calls).toEqual(["openai"]);
	});

	it("never falls back to the local embedder under Cloud only", async () => {
		await setPolicy("TEXT_EMBEDDING", "cloud-only");
		const { runtime, calls } = makeRuntime({ cloudThrows: true });

		await expect(
			runtime.useModel(ModelType.TEXT_EMBEDDING, { text: "hello" }),
		).rejects.toThrow(/openai embeddings failed/);
		expect(calls).toEqual(["openai"]);
	});

	it("sends embeddings to the provider a manual pin names", async () => {
		await setPolicy("TEXT_EMBEDDING", "manual");
		await setPreferredProvider("TEXT_EMBEDDING", "openai");
		const { runtime, calls } = makeRuntime();

		await runtime.useModel(ModelType.TEXT_EMBEDDING, { text: "hello" });

		expect(calls).toEqual(["openai"]);
	});

	it("keeps the local embedder when a manual pin names an unregistered provider", async () => {
		await setPolicy("TEXT_EMBEDDING", "manual");
		await setPreferredProvider("TEXT_EMBEDDING", "voyage");
		const { runtime, calls } = makeRuntime();

		await runtime.useModel(ModelType.TEXT_EMBEDDING, { text: "hello" });

		expect(calls).toEqual(["eliza-local-inference"]);
	});
});
