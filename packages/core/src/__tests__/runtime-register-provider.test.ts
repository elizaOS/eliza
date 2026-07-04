/**
 * Coverage for `AgentRuntime.registerProvider` — name-based deduplication and
 * the `registerByDefault: false` opt-out across plugin and direct registration.
 * Drives a real `AgentRuntime`; no model.
 */
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime";
import type { Character, Provider } from "../types";

function makeProvider(name: string, text: string): Provider {
	return {
		name,
		get: async () => ({ text, values: {}, data: {} }),
	};
}

describe("AgentRuntime.registerProvider deduplication", () => {
	it("does not register two providers with the same name", () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-dedupe-test" } as Character,
		});

		const before = runtime.providers.length;
		runtime.registerProvider(makeProvider("DUP", "first"));
		runtime.registerProvider(makeProvider("DUP", "second"));

		const matches = runtime.providers.filter((p) => p.name === "DUP");
		expect(matches).toHaveLength(1);
		// First registration wins; the duplicate is skipped, not swapped in.
		expect(runtime.providers.length).toBe(before + 1);
	});

	it("still registers distinctly-named providers", () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-distinct-test" } as Character,
		});

		const before = runtime.providers.length;
		runtime.registerProvider(makeProvider("ALPHA", "a"));
		runtime.registerProvider(makeProvider("BETA", "b"));

		expect(runtime.providers.length).toBe(before + 2);
		expect(runtime.providers.some((p) => p.name === "ALPHA")).toBe(true);
		expect(runtime.providers.some((p) => p.name === "BETA")).toBe(true);
	});

	it("skips plugin providers that opt out of default registration", async () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-default-registration-test" } as Character,
		});

		await runtime.registerPlugin({
			name: "provider-default-registration-plugin",
			description: "Provider registration behavior test",
			providers: [
				makeProvider("DEFAULT_PROVIDER", "default"),
				{
					...makeProvider("EXPLICIT_PROVIDER", "explicit"),
					registerByDefault: false,
				},
			],
		});

		expect(runtime.providers.some((p) => p.name === "DEFAULT_PROVIDER")).toBe(
			true,
		);
		expect(runtime.providers.some((p) => p.name === "EXPLICIT_PROVIDER")).toBe(
			false,
		);
	});

	it("allows direct registration of providers that opt out of plugin defaults", () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-direct-registration-test" } as Character,
		});

		runtime.registerProvider({
			...makeProvider("DIRECT_EXPLICIT_PROVIDER", "explicit"),
			registerByDefault: false,
		});

		expect(
			runtime.providers.some((p) => p.name === "DIRECT_EXPLICIT_PROVIDER"),
		).toBe(true);
	});
});
