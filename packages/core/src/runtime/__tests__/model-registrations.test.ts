/**
 * Exercises AgentRuntime model-registration observability: the
 * `MODEL_REGISTERED` event payload, `getModelRegistrations()` returning
 * handler-free metadata, plugin `modelMetadata` application, and failover
 * surviving alongside the registry API. A real runtime over the in-memory
 * adapter registers noop handlers — no live model.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import {
	type Character,
	EventType,
	type ModelRegisteredEventPayload,
	ModelType,
} from "../../types";

function makeRuntime(): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "ModelRegistrationsAgent",
			bio: "test",
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
}

const noopHandler = async () => "ok";

describe("AgentRuntime model-registration observability", () => {
	it("emits MODEL_REGISTERED with registration metadata (no handler)", async () => {
		const runtime = makeRuntime();
		const seen: ModelRegisteredEventPayload[] = [];
		runtime.registerEvent(EventType.MODEL_REGISTERED, async (payload) => {
			seen.push(payload);
		});

		runtime.registerModel(ModelType.TEXT_LARGE, noopHandler, "provider-a", 50, {
			displayModelSetting: "PROVIDER_A_MODEL",
		});

		// registerModel emits fire-and-forget; give the microtask queue a turn.
		await Promise.resolve();

		expect(seen).toHaveLength(1);
		const payload = seen[0];
		expect(payload?.modelType).toBe(ModelType.TEXT_LARGE);
		expect(payload?.metadata).toEqual({
			displayModelSetting: "PROVIDER_A_MODEL",
		});
		expect(payload?.provider).toBe("provider-a");
		expect(payload?.priority).toBe(50);
		// Metadata only — never leaks the handler function.
		expect(payload).not.toHaveProperty("handler");
	});

	it("defaults the emitted priority to 0 when none is supplied", async () => {
		const runtime = makeRuntime();
		const seen: ModelRegisteredEventPayload[] = [];
		runtime.registerEvent(EventType.MODEL_REGISTERED, async (payload) => {
			seen.push(payload);
		});

		runtime.registerModel(ModelType.TEXT_SMALL, noopHandler, "provider-b");
		await Promise.resolve();

		expect(seen).toHaveLength(1);
		expect(seen[0]?.priority).toBe(0);
	});

	it("getModelRegistrations() reflects every registration as handler-free metadata", () => {
		const runtime = makeRuntime();
		runtime.registerModel(ModelType.TEXT_LARGE, noopHandler, "provider-a", 50, {
			displayModel: "model-a",
		});
		runtime.registerModel(ModelType.TEXT_LARGE, noopHandler, "provider-b", 10);
		runtime.registerModel(ModelType.TEXT_EMBEDDING, noopHandler, "provider-a");

		const regs = runtime.getModelRegistrations();

		expect(regs).toHaveLength(3);
		for (const reg of regs) {
			expect(reg).not.toHaveProperty("handler");
			expect(typeof reg.registrationOrder).toBe("number");
		}

		const large = regs.filter((r) => r.modelType === ModelType.TEXT_LARGE);
		expect(large.map((r) => r.provider).sort()).toEqual([
			"provider-a",
			"provider-b",
		]);
		expect(
			regs.find((r) => r.modelType === ModelType.TEXT_EMBEDDING)?.priority,
		).toBe(0);
		expect(large.find((r) => r.provider === "provider-a")?.metadata).toEqual({
			displayModel: "model-a",
		});
	});

	it("applies plugin modelMetadata when registering Plugin.models", async () => {
		const runtime = makeRuntime();

		await runtime.registerPlugin({
			name: "metadata-model-plugin",
			description: "Model metadata registration test",
			models: {
				[ModelType.TEXT_SMALL]: noopHandler,
			},
			modelMetadata: {
				[ModelType.TEXT_SMALL]: {
					displayModelSetting: "PLUGIN_MODEL",
				},
			},
		});

		const registration = runtime
			.getModelRegistrations()
			.find(
				(reg) =>
					reg.modelType === ModelType.TEXT_SMALL &&
					reg.provider === "metadata-model-plugin",
			);
		expect(registration?.metadata).toEqual({
			displayModelSetting: "PLUGIN_MODEL",
		});
	});

	it("keeps useModel provider failover intact alongside the new registry API", async () => {
		const runtime = makeRuntime();
		const exhausted = vi.fn(async () => {
			throw new Error("You've hit your session limit for now.");
		});
		const backup = vi.fn(async () => "backup response");

		runtime.registerModel(ModelType.TEXT_LARGE, exhausted, "primary", 100);
		runtime.registerModel(ModelType.TEXT_LARGE, backup, "backup", 10);

		// The registry lists both providers in priority order …
		const providers = runtime
			.getModelRegistrations()
			.filter((r) => r.modelType === ModelType.TEXT_LARGE)
			.sort((a, b) => b.priority - a.priority)
			.map((r) => r.provider);
		expect(providers).toEqual(["primary", "backup"]);

		// … and core still fails over past the exhausted primary to the backup.
		await expect(
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hi" }),
		).resolves.toBe("backup response");
		expect(exhausted).toHaveBeenCalledTimes(1);
		expect(backup).toHaveBeenCalledTimes(1);
	});
});
