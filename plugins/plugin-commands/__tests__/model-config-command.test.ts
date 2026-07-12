/**
 * `/model small|large|coding|show` tests: token parsing, owner gating, the
 * loopback POST/GET to /api/models/config through a stubbed fetch, verbatim
 * 400/409 passthrough, and regression pins for the two pre-existing `/model`
 * behaviors (local/cloud runtime switch, bare-name per-room preference).
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../src/actions";
import { parseModelConfigArgs } from "../src/actions/model-config";
import { initForRuntime } from "../src/registry";

function makeRuntime(): IAgentRuntime {
	const cache = new Map<string, unknown>();
	return {
		agentId: "agent-model-config",
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
		id: "00000000-0000-0000-0000-000000000011",
		entityId: "00000000-0000-0000-0000-0000000000ac",
		roomId: "room-model-config",
		content: { text, source: "client_chat" },
	} as unknown as Memory;
}

const OWNER = { isAuthorized: true, isElevated: true };

function parsedModel(rawArgs: string) {
	return { key: "model", canonical: "/model", args: [], rawArgs };
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("parseModelConfigArgs", () => {
	it("returns null for the pre-existing /model shapes (local/cloud, bare name, empty)", () => {
		expect(parseModelConfigArgs(parsedModel("local"))).toBeNull();
		expect(parseModelConfigArgs(parsedModel("cloud gemma-4-31b"))).toBeNull();
		expect(parseModelConfigArgs(parsedModel("claude-opus"))).toBeNull();
		expect(parseModelConfigArgs(parsedModel(""))).toBeNull();
	});

	it("parses show", () => {
		expect(parseModelConfigArgs(parsedModel("show"))).toEqual({
			kind: "show",
		});
		expect(parseModelConfigArgs(parsedModel("show extra"))).toMatchObject({
			kind: "usage",
		});
	});

	it("parses chat targets with optional provider and effort", () => {
		expect(parseModelConfigArgs(parsedModel("small zai-glm-4.7"))).toEqual({
			kind: "write",
			body: { target: "small", model: "zai-glm-4.7" },
		});
		expect(
			parseModelConfigArgs(parsedModel("large cerebras zai-glm-4.7 high")),
		).toEqual({
			kind: "write",
			body: {
				target: "large",
				provider: "cerebras",
				model: "zai-glm-4.7",
				effort: "high",
			},
		});
	});

	it("splits a fused provider/model token only for a known chat provider", () => {
		expect(
			parseModelConfigArgs(parsedModel("large elizacloud/zai-glm-4.7")),
		).toEqual({
			kind: "write",
			body: { target: "large", provider: "elizacloud", model: "zai-glm-4.7" },
		});
		// "openai" is not a chat provider — the slashed id stays a model id.
		expect(
			parseModelConfigArgs(parsedModel("large openai/gpt-oss-120b")),
		).toEqual({
			kind: "write",
			body: { target: "large", model: "openai/gpt-oss-120b" },
		});
	});

	it("parses coding targets and maps the elizaos alias to the API's eliza-code", () => {
		expect(
			parseModelConfigArgs(parsedModel("coding codex gpt-5.5 xhigh")),
		).toEqual({
			kind: "write",
			body: {
				target: "coding",
				backend: "codex",
				model: "gpt-5.5",
				effort: "xhigh",
			},
		});
		expect(parseModelConfigArgs(parsedModel("coding elizaos eliza-1"))).toEqual(
			{
				kind: "write",
				body: { target: "coding", backend: "eliza-code", model: "eliza-1" },
			},
		);
	});

	it("returns usage errors for malformed config subcommands", () => {
		expect(parseModelConfigArgs(parsedModel("small"))).toMatchObject({
			kind: "usage",
		});
		expect(parseModelConfigArgs(parsedModel("coding"))).toMatchObject({
			kind: "usage",
		});
		expect(
			parseModelConfigArgs(parsedModel("coding gemini gpt")),
		).toMatchObject({ kind: "usage" });
		expect(parseModelConfigArgs(parsedModel("small a b c d"))).toMatchObject({
			kind: "usage",
		});
		expect(
			parseModelConfigArgs(parsedModel("coding codex gpt-5.5 high extra")),
		).toMatchObject({ kind: "usage" });
	});
});

describe("/model small|large|coding → POST /api/models/config", () => {
	let runtime: IAgentRuntime;
	beforeEach(() => {
		initForRuntime("agent-model-config");
		runtime = makeRuntime();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("POSTs a chat write and narrates the restart", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				applied: true,
				restart: true,
				operationId: "op-1",
				keys: ["OPENAI_LARGE_MODEL"],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(
			runtime,
			msg("/model large zai-glm-4.7"),
			OWNER,
		);
		expect(r.handled).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toContain("/api/models/config");
		expect((init as RequestInit).method).toBe("POST");
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			target: "large",
			model: "zai-glm-4.7",
		});
		expect(r.reply).toContain("restarting the agent to apply");
	});

	it("POSTs provider + effort and surfaces the shared OPENAI_REASONING_EFFORT knob", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				applied: true,
				restart: true,
				operationId: "op-2",
				keys: ["OPENAI_SMALL_MODEL", "OPENAI_REASONING_EFFORT"],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(
			runtime,
			msg("/model small cerebras gpt-oss-120b low"),
			OWNER,
		);
		expect(
			JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string),
		).toEqual({
			target: "small",
			provider: "cerebras",
			model: "gpt-oss-120b",
			effort: "low",
		});
		expect(r.reply).toContain("restarting the agent to apply");
		expect(r.reply).toContain(
			"OPENAI_REASONING_EFFORT is shared by the small and large chat targets",
		);
	});

	it("POSTs a coding write and narrates the restart-free apply", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				applied: true,
				restart: false,
				keys: ["ELIZA_CODEX_MODEL_POWERFUL", "ELIZA_CODEX_EFFORT"],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(
			runtime,
			msg("/model coding codex gpt-5.6-terra xhigh"),
			OWNER,
		);
		expect(
			JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string),
		).toEqual({
			target: "coding",
			backend: "codex",
			model: "gpt-5.6-terra",
			effort: "xhigh",
		});
		expect(r.reply).toContain("no restart needed");
		expect(r.reply).not.toContain("restarting the agent");
	});

	it("passes the route's 400 validation error through verbatim", async () => {
		const error =
			'Effort "ultra" is valid for gpt-5.6-terra but not parseable by the pinned codex-acp adapter (supported until the pin is bumped: low, medium, high, xhigh)';
		const fetchMock = vi.fn(async () =>
			jsonResponse({ error, code: "MODEL_CONFIG_INVALID", context: {} }, 400),
		);
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(
			runtime,
			msg("/model coding codex gpt-5.6-terra ultra"),
			OWNER,
		);
		expect(r.handled).toBe(true);
		expect(r.reply).toContain(error);
	});

	it("surfaces a 409 busy runtime operation", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse(
				{
					error: "A runtime operation is already in progress",
					activeOperationId: "op-busy",
				},
				409,
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(
			runtime,
			msg("/model large zai-glm-4.7"),
			OWNER,
		);
		expect(r.reply).toContain("already in progress");
		expect(r.reply).toContain("op-busy");
	});

	it("warns when the write conflicts with service-environment keys", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				applied: true,
				restart: false,
				keys: ["ELIZA_CLAUDE_MODEL_POWERFUL"],
				conflictingServiceEnvKeys: ["ELIZA_CLAUDE_MODEL_POWERFUL"],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(
			runtime,
			msg("/model coding claude claude-opus-4-8"),
			OWNER,
		);
		expect(r.reply).toContain("ELIZA_CLAUDE_MODEL_POWERFUL");
		expect(r.reply).toContain("service-environment");
	});

	it("refuses config writes without elevated permissions and never hits the route", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		// resolveCommand defaults are fail-closed (unauthorized, unelevated).
		const r = await resolveCommand(runtime, msg("/model large zai-glm-4.7"));
		expect(r.handled).toBe(true);
		expect(r.reply).toMatch(/requires (authorization|elevated permissions)/);
		expect(fetchMock).not.toHaveBeenCalled();

		const authorizedOnly = await resolveCommand(
			runtime,
			msg("/model coding codex gpt-5.5"),
			{ isAuthorized: true, isElevated: false },
		);
		expect(authorizedOnly.reply).toBe(
			"This command requires elevated permissions.",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("gates usage errors of the config subcommands behind elevation too", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(runtime, msg("/model small"));
		expect(r.reply).toMatch(/requires (authorization|elevated permissions)/);

		const usage = await resolveCommand(runtime, msg("/model small"), OWNER);
		expect(usage.reply).toContain("Usage: /model small");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("/model show → GET /api/models/config", () => {
	let runtime: IAgentRuntime;
	beforeEach(() => {
		initForRuntime("agent-model-config");
		runtime = makeRuntime();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("formats the effective config with values, sources, and unset keys", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				targets: {
					small: {
						OPENAI_SMALL_MODEL: { value: "gpt-oss-120b", source: "config.env" },
						ANTHROPIC_SMALL_MODEL: null,
					},
					large: {
						OPENAI_LARGE_MODEL: {
							value: "zai-glm-4.7",
							source: "process.env",
						},
					},
					coding: {
						ELIZA_CODEX_MODEL_POWERFUL: {
							value: "gpt-5.6-terra",
							source: "default",
						},
					},
				},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(runtime, msg("/model show"), {
			isAuthorized: true,
			isElevated: false,
		});
		expect(r.handled).toBe(true);
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toContain("/api/models/config");
		expect((init as RequestInit).method).toBe("GET");
		expect(r.reply).toContain("**small**");
		expect(r.reply).toContain("OPENAI_SMALL_MODEL = gpt-oss-120b (config.env)");
		expect(r.reply).toContain("ANTHROPIC_SMALL_MODEL unset");
		expect(r.reply).toContain("OPENAI_LARGE_MODEL = zai-glm-4.7 (process.env)");
		expect(r.reply).toContain(
			"ELIZA_CODEX_MODEL_POWERFUL = gpt-5.6-terra (default)",
		);
	});

	it("requires authorization and never hits the route when unauthorized", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(runtime, msg("/model show"));
		expect(r.reply).toBe("This command requires authorization.");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("surfaces a route error", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ error: "boom" }, 500));
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(runtime, msg("/model show"), OWNER);
		expect(r.reply).toContain("boom");
	});
});

describe("regression — pre-existing /model behaviors are untouched", () => {
	let runtime: IAgentRuntime;
	beforeEach(() => {
		initForRuntime("agent-model-config");
		runtime = makeRuntime();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("/model local still hits the runtime-switch route, not the config route", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				ok: true,
				target: "local",
				model: "eliza-1-4b",
				displayName: "Eliza-1 4B",
				status: "ready",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(
			runtime,
			msg("/model local eliza-1-4b"),
			OWNER,
		);
		expect(r.handled).toBe(true);
		expect(String(fetchMock.mock.calls[0][0])).toContain(
			"/api/runtime/model-switch",
		);
		expect(r.reply).toContain("Eliza-1 4B");
	});

	it("a bare /model <name> still sets the per-room preference without any route call", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(runtime, msg("/model claude-opus"), OWNER);
		expect(r.handled).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(r.reply).toMatch(/Model set to/);
	});

	it("a bare /model still reports the current per-room preference", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(runtime, msg("/model"), OWNER);
		expect(r.handled).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(r.reply).toMatch(/Model is/);
	});
});
