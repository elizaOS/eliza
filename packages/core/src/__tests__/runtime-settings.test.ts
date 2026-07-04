/**
 * Exercises `AgentRuntime.getSetting` resolution precedence (character env vs
 * settings vs constructor settings vs DB-persisted values on restart) and
 * prompt-batcher construction. Deterministic: real runtime over the in-memory
 * adapter, no model calls.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import type { Character } from "../types";

describe("AgentRuntime.getSetting", () => {
	it("reads primitive character env values as runtime settings", () => {
		const runtime = new AgentRuntime({
			character: {
				name: "env-settings-test",
				env: {
					FEATURE_FLAG: true,
					TIMEOUT_MS: 5000,
					vars: {
						ROUTE_POLICY: '{"default":"guest"}',
					},
				},
				settings: {
					ROUTE_POLICY: '{"default":"owner"}',
				},
			} as Character,
		});

		expect(runtime.getSetting("FEATURE_FLAG")).toBe(true);
		expect(runtime.getSetting("TIMEOUT_MS")).toBe(5000);
		expect(runtime.getSetting("ROUTE_POLICY")).toBe('{"default":"owner"}');
	});

	it("reads primitive values from character env vars", () => {
		const runtime = new AgentRuntime({
			character: {
				name: "env-vars-settings-test",
				env: {
					vars: {
						ROUTE_POLICY: '{"default":"guest"}',
					},
				},
			} as Character,
		});

		expect(runtime.getSetting("ROUTE_POLICY")).toBe('{"default":"guest"}');
	});

	it("falls back to env vars when direct env values are not primitive", () => {
		const runtime = new AgentRuntime({
			character: {
				name: "env-vars-fallback-test",
				env: {
					ROUTE_POLICY: {
						default: "owner",
					},
					vars: {
						ROUTE_POLICY: '{"default":"guest"}',
					},
				},
			} as Character,
		});

		expect(runtime.getSetting("ROUTE_POLICY")).toBe('{"default":"guest"}');
	});

	it("keeps character settings ahead of constructor settings", () => {
		const runtime = new AgentRuntime({
			character: {
				name: "character-settings-override-test",
				settings: {
					ROUTE_POLICY: '{"default":"owner"}',
				},
			} as Character,
			settings: {
				ROUTE_POLICY: '{"default":"guest"}',
			},
		});

		expect(runtime.getSetting("ROUTE_POLICY")).toBe('{"default":"owner"}');
	});

	it("uses fresh constructor settings over DB-persisted agent settings on restart", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const characterName = "runtime-settings-restart-test";
		const firstRuntime = new AgentRuntime({
			character: {
				name: characterName,
				bio: ["test"],
				settings: {},
			} as Character,
			adapter,
			settings: { FOO: "v1" },
			logLevel: "fatal",
		});

		let secondRuntime: AgentRuntime | undefined;
		try {
			await firstRuntime.initialize({ skipMigrations: true });
			expect(firstRuntime.getSetting("FOO")).toBe("v1");
			await adapter.updateAgents([
				{
					agentId: firstRuntime.agentId,
					agent: {
						settings: { FOO: "v1", secrets: { BAR: "v1" } },
						secrets: { BAZ: "v1" },
					},
				},
			]);

			secondRuntime = new AgentRuntime({
				character: {
					name: characterName,
					bio: ["test"],
					settings: {},
				} as Character,
				adapter,
				settings: { FOO: "v2", BAR: "v2", BAZ: "v2" },
				logLevel: "fatal",
			});
			await secondRuntime.initialize({ skipMigrations: true });

			expect(secondRuntime.getSetting("FOO")).toBe("v2");
			expect(secondRuntime.getSetting("BAR")).toBe("v2");
			expect(secondRuntime.getSetting("BAZ")).toBe("v2");
		} finally {
			await firstRuntime.stop({ fast: true });
			await secondRuntime?.stop({ fast: true });
			firstRuntime.promptBatcher.dispose();
			secondRuntime?.promptBatcher.dispose();
		}
	});
});

describe("AgentRuntime prompt batcher", () => {
	it("creates a prompt batcher for production autonomy drains", () => {
		const runtime = new AgentRuntime({
			character: {
				name: "prompt-batcher-runtime-test",
			} as Character,
		});

		expect(runtime.promptBatcher).toBeDefined();
		expect(runtime.promptBatcher.getStats()).toMatchObject({
			totalDrains: 0,
			totalCalls: 0,
		});

		runtime.promptBatcher.dispose();
	});
});
