import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import { type Character, ModelType } from "../../types";

/**
 * Phase 5 — request-time chat-brain provider override.
 *
 * `useModel(TEXT_LARGE)` with no pinned provider normally returns the
 * highest-priority registered handler. The `ELIZA_BRAIN_PROVIDER` setting lets
 * an owner flip the brain between loaded providers at runtime. It must:
 *  - flip to the named provider when that provider has a handler,
 *  - be a no-op (highest-priority pick) when unset,
 *  - SAFELY fall back to the default when the named provider has no handler
 *    (a stale/typo'd value must never strand the brain),
 *  - never override an explicitly-pinned provider.
 */
function makeRuntime(settings: Record<string, string> = {}): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "BrainOverrideAgent",
			bio: "test",
			settings,
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
}

/** Register a TEXT_LARGE handler that just echoes which provider answered. */
function registerEcho(
	runtime: AgentRuntime,
	provider: string,
	priority: number,
): void {
	runtime.registerModel(
		ModelType.TEXT_LARGE,
		async () => `answered-by:${provider}`,
		provider,
		priority,
	);
}

describe("brain provider override (ELIZA_BRAIN_PROVIDER)", () => {
	it("uses the highest-priority provider when the override is unset", async () => {
		const runtime = makeRuntime();
		registerEcho(runtime, "anthropic", 10);
		registerEcho(runtime, "cerebras", 0);
		const out = await runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hi" });
		expect(out).toBe("answered-by:anthropic");
	});

	it("flips to the named provider when set and that provider has a handler", async () => {
		const runtime = makeRuntime({ ELIZA_BRAIN_PROVIDER: "cerebras" });
		registerEcho(runtime, "anthropic", 10);
		registerEcho(runtime, "cerebras", 0);
		const out = await runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hi" });
		expect(out).toBe("answered-by:cerebras");
	});

	it("falls back to the default when the named provider has NO handler", async () => {
		// The override names a provider that was never registered — must NOT throw,
		// must use the default highest-priority pick instead.
		const runtime = makeRuntime({ ELIZA_BRAIN_PROVIDER: "ghost-provider" });
		registerEcho(runtime, "anthropic", 10);
		const out = await runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hi" });
		expect(out).toBe("answered-by:anthropic");
	});

	it("never overrides an explicitly pinned provider", async () => {
		const runtime = makeRuntime({ ELIZA_BRAIN_PROVIDER: "cerebras" });
		registerEcho(runtime, "anthropic", 10);
		registerEcho(runtime, "cerebras", 0);
		// caller pins anthropic explicitly → override must not apply.
		const out = await runtime.useModel(
			ModelType.TEXT_LARGE,
			{ prompt: "hi" },
			"anthropic",
		);
		expect(out).toBe("answered-by:anthropic");
	});

	it("ignores a blank override value", async () => {
		const runtime = makeRuntime({ ELIZA_BRAIN_PROVIDER: "   " });
		registerEcho(runtime, "anthropic", 10);
		registerEcho(runtime, "cerebras", 0);
		const out = await runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hi" });
		expect(out).toBe("answered-by:anthropic");
	});
});
