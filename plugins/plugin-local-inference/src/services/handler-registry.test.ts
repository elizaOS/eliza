import type {
	IAgentRuntime,
	ModelRegisteredEventPayload,
	ModelRegistrationInfo,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handlerRegistry } from "./handler-registry";

/**
 * Minimal runtime double exposing only the public core surface the registry
 * now depends on: `getModelRegistrations()` for the seed snapshot and
 * `registerEvent` to receive `MODEL_REGISTERED`. Crucially it does NOT expose
 * `registerModel` — proving the registry populates via the event/query API and
 * never patches or wraps a `registerModel` method (the old prototype
 * monkey-patch is gone).
 */
function makeFakeRuntime(seed: ModelRegistrationInfo[]) {
	const eventHandlers = new Map<
		string,
		(payload: ModelRegisteredEventPayload) => Promise<void>
	>();
	const registerEvent = vi.fn(
		(
			event: string,
			handler: (p: ModelRegisteredEventPayload) => Promise<void>,
		) => {
			eventHandlers.set(event, handler);
		},
	);
	const runtime = {
		getModelRegistrations: () => seed,
		registerEvent,
	} as unknown as IAgentRuntime;
	return {
		runtime,
		registerEvent,
		async fire(payload: ModelRegisteredEventPayload) {
			const handler = eventHandlers.get("MODEL_REGISTERED");
			if (!handler) throw new Error("MODEL_REGISTERED handler not registered");
			await handler(payload);
		},
	};
}

function payload(
	over: Partial<ModelRegisteredEventPayload>,
): ModelRegisteredEventPayload {
	return {
		modelType: "TEXT_LARGE",
		provider: "provider-x",
		priority: 0,
		runtime: {} as IAgentRuntime,
		...over,
	};
}

describe("local-inference handler-registry mirrors via the core API, not a patch", () => {
	it("subscribes to MODEL_REGISTERED and never touches registerModel", () => {
		const { runtime, registerEvent } = makeFakeRuntime([]);

		handlerRegistry.installOn(runtime);

		expect(registerEvent).toHaveBeenCalledTimes(1);
		expect(registerEvent).toHaveBeenCalledWith(
			"MODEL_REGISTERED",
			expect.any(Function),
		);
		// The runtime double has no registerModel — installOn must not require
		// or wrap one (the old monkey-patch path would have patched it).
		expect(
			(runtime as unknown as { registerModel?: unknown }).registerModel,
		).toBeUndefined();
	});

	it("seeds from getModelRegistrations() on install", () => {
		const { runtime } = makeFakeRuntime([
			{
				modelType: "SEED_ONLY_TYPE",
				provider: "seed-provider",
				priority: 42,
				registrationOrder: 1,
			},
		]);

		handlerRegistry.installOn(runtime);

		const rows = handlerRegistry.getForType("SEED_ONLY_TYPE");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			modelType: "SEED_ONLY_TYPE",
			provider: "seed-provider",
			priority: 42,
		});
	});

	it("records subsequent registrations from the MODEL_REGISTERED event, metadata only", async () => {
		const { runtime, fire } = makeFakeRuntime([]);
		handlerRegistry.installOn(runtime);

		await fire(
			payload({
				modelType: "EVENT_DRIVEN_TYPE",
				provider: "high",
				priority: 100,
			}),
		);
		await fire(
			payload({ modelType: "EVENT_DRIVEN_TYPE", provider: "low", priority: 1 }),
		);

		const rows = handlerRegistry.getForType("EVENT_DRIVEN_TYPE");
		expect(rows.map((r) => r.provider)).toEqual(["high", "low"]);
		// Metadata only — no captured handler function leaks into the registry.
		expect(rows[0]).not.toHaveProperty("handler");
	});

	it("getForTypeExcluding drops the named provider", async () => {
		const { runtime, fire } = makeFakeRuntime([]);
		handlerRegistry.installOn(runtime);
		await fire(
			payload({
				modelType: "EXCL_TYPE",
				provider: "eliza-router",
				priority: 9,
			}),
		);
		await fire(
			payload({ modelType: "EXCL_TYPE", provider: "openai", priority: 5 }),
		);

		expect(
			handlerRegistry
				.getForTypeExcluding("EXCL_TYPE", "eliza-router")
				.map((r) => r.provider),
		).toEqual(["openai"]);
	});

	it("is idempotent per runtime instance (no double subscription)", () => {
		const { runtime, registerEvent } = makeFakeRuntime([]);
		handlerRegistry.installOn(runtime);
		handlerRegistry.installOn(runtime);
		expect(registerEvent).toHaveBeenCalledTimes(1);
	});
});
