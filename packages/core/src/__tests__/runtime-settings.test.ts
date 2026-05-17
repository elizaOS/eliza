import { describe, expect, it } from "vitest";
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
});
