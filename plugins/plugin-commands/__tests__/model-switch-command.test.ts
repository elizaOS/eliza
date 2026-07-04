/**
 * Model command tests cover local/cloud runtime switching through a stubbed
 * loopback route while preserving per-room model preference behavior.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../src/actions";
import { parseModelSwitchArgs } from "../src/actions/handlers";
import { initForRuntime } from "../src/registry";

function makeRuntime(): IAgentRuntime {
	const cache = new Map<string, unknown>();
	return {
		agentId: "agent-model",
		character: { name: "Eliza", settings: {} },
		actions: [],
		getSetting: () => null,
		getCache: async (key: string) => cache.get(key),
		setCache: async (key: string, value: unknown) => {
			cache.set(key, value);
			return true;
		},
		deleteCache: async (key: string) => cache.delete(key),
	} as unknown as IAgentRuntime;
}

function msg(text: string): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000010",
		entityId: "00000000-0000-0000-0000-0000000000ab",
		roomId: "room-model",
		content: { text, source: "client_chat" },
	} as unknown as Memory;
}

describe("parseModelSwitchArgs", () => {
	it("parses local/cloud targets and an optional id", () => {
		expect(
			parseModelSwitchArgs({
				key: "model",
				canonical: "/model",
				args: [],
				rawArgs: "local",
			}),
		).toEqual({ target: "local" });
		expect(
			parseModelSwitchArgs({
				key: "model",
				canonical: "/model",
				args: [],
				rawArgs: "local eliza-1-4b",
			}),
		).toEqual({ target: "local", model: "eliza-1-4b" });
		expect(
			parseModelSwitchArgs({
				key: "model",
				canonical: "/model",
				args: ["cloud"],
				rawArgs: "",
			}),
		).toEqual({ target: "cloud" });
	});

	it("returns null for a bare model name (per-room preference path)", () => {
		expect(
			parseModelSwitchArgs({
				key: "model",
				canonical: "/model",
				args: [],
				rawArgs: "gpt-5",
			}),
		).toBeNull();
	});
});

describe("/model local|cloud → shared runtime-switch route", () => {
	let runtime: IAgentRuntime;
	beforeEach(() => {
		initForRuntime("agent-model");
		runtime = makeRuntime();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("POSTs the runtime-switch route for /model cloud and narrates the reply", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						ok: true,
						target: "cloud",
						model: "gemma-4-31b",
						status: "ready",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(runtime, msg("/model cloud"));
		expect(r.handled).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toContain("/api/runtime/model-switch");
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			target: "cloud",
		});
		expect(r.reply).toMatch(/Eliza Cloud/);
	});

	it("POSTs local with a specific tier and narrates a download", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						ok: true,
						target: "local",
						model: "eliza-1-4b",
						displayName: "Eliza-1 4B",
						status: "downloading",
						downloadSizeGb: 2.6,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(runtime, msg("/model local eliza-1-4b"));
		expect(r.handled).toBe(true);
		expect(
			JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string),
		).toEqual({ target: "local", model: "eliza-1-4b" });
		expect(r.reply).toMatch(/downloading \(2\.6 GB\)/);
	});

	it("surfaces a route error", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: "no provider" }), {
					status: 502,
					headers: { "Content-Type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(runtime, msg("/model local"));
		expect(r.handled).toBe(true);
		expect(r.reply).toMatch(/no provider/);
	});

	it("does NOT hit the route for a bare /model <name> (per-room preference)", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(runtime, msg("/model claude-opus"));
		expect(r.handled).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(r.reply).toMatch(/Model set to/);
	});
});
