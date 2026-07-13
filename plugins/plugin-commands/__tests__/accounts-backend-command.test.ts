/**
 * `/accounts` + `/backend` tests: token parsing, the authorized-read /
 * elevated-write gate split, account matching (ambiguous and empty matches
 * refuse with candidates), the use-disables-siblings PATCH sequence, strategy
 * and refresh flows, and the defaultBackend-only POST — all through
 * `resolveCommand` with a stubbed loopback fetch.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../src/actions";
import { parseAccountsArgs } from "../src/actions/accounts";
import { parseBackendArgs } from "../src/actions/backend";
import { gateConnectorCommandByName } from "../src/connector-bridge";
import { initForRuntime } from "../src/registry";

function makeRuntime(): IAgentRuntime {
	const cache = new Map<string, unknown>();
	return {
		agentId: "agent-accounts-backend",
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
		id: "00000000-0000-0000-0000-000000000021",
		entityId: "00000000-0000-0000-0000-0000000000ad",
		roomId: "room-accounts-backend",
		content: { text, source: "client_chat" },
	} as unknown as Memory;
}

const OWNER = { isAuthorized: true, isElevated: true };
const AUTHORIZED = { isAuthorized: true, isElevated: false };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

interface RecordedCall {
	url: string;
	method: string;
	body?: unknown;
}

function recordedCalls(fetchMock: ReturnType<typeof vi.fn>): RecordedCall[] {
	return fetchMock.mock.calls.map((call) => {
		const init = call[1] as RequestInit | undefined;
		return {
			url: String(call[0]),
			method: init?.method ?? "GET",
			...(typeof init?.body === "string"
				? { body: JSON.parse(init.body) }
				: {}),
		};
	});
}

const NOW = Date.now();

function accountsPayload(overrides?: {
	workEnabled?: boolean;
	personalEnabled?: boolean;
	sessionPct?: number;
}) {
	return {
		providers: [
			{
				providerId: "anthropic-subscription",
				strategy: "priority",
				accounts: [
					{
						id: "acct-work-1234",
						label: "work-max",
						email: "work@example.com",
						enabled: overrides?.workEnabled ?? true,
						priority: 0,
						health: "ok",
						hasCredential: true,
						usage: {
							sessionPct: overrides?.sessionPct ?? 42.4,
							weeklyPct: 63.2,
							resetsAt: NOW + 2 * 60 * 60 * 1000,
							refreshedAt: NOW,
						},
					},
					{
						id: "acct-personal-5678",
						label: "personal-pro",
						email: "me@example.com",
						enabled: overrides?.personalEnabled ?? false,
						priority: 1,
						health: "rate-limited",
						hasCredential: true,
					},
				],
			},
			{ providerId: "openai-codex", strategy: "priority", accounts: [] },
		],
	};
}

describe("parseAccountsArgs", () => {
	it("parses the report, toggles, strategy, and refresh shapes", () => {
		expect(
			parseAccountsArgs({ key: "accounts", canonical: "/accounts", args: [] }),
		).toEqual({ kind: "report" });
		expect(
			parseAccountsArgs({
				key: "accounts",
				canonical: "/accounts",
				args: [],
				rawArgs: "use claude work-max",
			}),
		).toEqual({
			kind: "use",
			provider: "anthropic-subscription",
			account: "work-max",
		});
		expect(
			parseAccountsArgs({
				key: "accounts",
				canonical: "/accounts",
				args: [],
				rawArgs: "strategy codex round-robin",
			}),
		).toEqual({
			kind: "strategy",
			provider: "openai-codex",
			strategy: "round-robin",
		});
		expect(
			parseAccountsArgs({
				key: "accounts",
				canonical: "/accounts",
				args: [],
				rawArgs: "refresh cerebras",
			}),
		).toEqual({ kind: "refresh", provider: "cerebras-api" });
	});

	it("returns usage errors for unknown actions, providers, and strategies", () => {
		expect(
			parseAccountsArgs({
				key: "accounts",
				canonical: "/accounts",
				args: [],
				rawArgs: "frobnicate",
			}),
		).toMatchObject({ kind: "usage" });
		expect(
			parseAccountsArgs({
				key: "accounts",
				canonical: "/accounts",
				args: [],
				rawArgs: "use gemini acct",
			}),
		).toMatchObject({ kind: "usage" });
		expect(
			parseAccountsArgs({
				key: "accounts",
				canonical: "/accounts",
				args: [],
				rawArgs: "strategy claude fastest",
			}),
		).toMatchObject({ kind: "usage" });
		expect(
			parseAccountsArgs({
				key: "accounts",
				canonical: "/accounts",
				args: [],
				rawArgs: "use claude",
			}),
		).toMatchObject({ kind: "usage" });
	});
});

describe("/accounts report", () => {
	let runtime: IAgentRuntime;
	beforeEach(() => {
		initForRuntime("agent-accounts-backend");
		runtime = makeRuntime();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("renders strategy + per-account usage lines for providers that have accounts", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(accountsPayload()));
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(runtime, msg("/accounts"), AUTHORIZED);
		expect(r.handled).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [call] = recordedCalls(fetchMock);
		expect(call?.url).toContain("/api/accounts");
		expect(call?.method).toBe("GET");
		expect(r.reply).toContain(
			"**anthropic-subscription** (strategy: priority)",
		);
		expect(r.reply).toContain("work-max (work@example.com) — enabled, prio 0");
		expect(r.reply).toContain("session 42% / weekly 63%");
		expect(r.reply).toContain("resets in");
		expect(r.reply).toContain(
			"personal-pro (me@example.com) — disabled, prio 1, rate-limited",
		);
		// Providers without accounts are omitted from the report.
		expect(r.reply).not.toContain("openai-codex");
	});

	it("requires authorization for the bare read and never hits the route", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(runtime, msg("/accounts"));
		expect(r.reply).toBe("This command requires authorization.");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("surfaces a route error verbatim", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ error: "pool exploded" }, 500),
		);
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(runtime, msg("/accounts"), OWNER);
		expect(r.reply).toContain("pool exploded");
	});
});

describe("/accounts writes", () => {
	let runtime: IAgentRuntime;
	beforeEach(() => {
		initForRuntime("agent-accounts-backend");
		runtime = makeRuntime();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("refuses writes (and their usage errors) without elevation, never hitting the route", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const write = await resolveCommand(
			runtime,
			msg("/accounts use claude work-max"),
			AUTHORIZED,
		);
		expect(write.reply).toBe("This command requires elevated permissions.");

		const usage = await resolveCommand(
			runtime,
			msg("/accounts frobnicate"),
			AUTHORIZED,
		);
		expect(usage.reply).toBe("This command requires elevated permissions.");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("use enables the target then disables its enabled siblings, PATCH by PATCH", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				if ((init?.method ?? "GET") === "GET") {
					// Second GET (post-patch re-read) reports the flipped states.
					const flipped = fetchMock.mock.calls.length > 1;
					return jsonResponse(
						flipped
							? accountsPayload({ workEnabled: false, personalEnabled: true })
							: accountsPayload({ workEnabled: true, personalEnabled: true }),
					);
				}
				return jsonResponse({ ok: true });
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(
			runtime,
			msg("/accounts use claude personal-pro"),
			OWNER,
		);
		expect(r.handled).toBe(true);
		const calls = recordedCalls(fetchMock);
		expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
			"GET /api/accounts",
			"PATCH /api/accounts/anthropic-subscription/acct-personal-5678",
			"PATCH /api/accounts/anthropic-subscription/acct-work-1234",
			"GET /api/accounts",
		]);
		expect(calls[1]?.body).toEqual({ enabled: true });
		expect(calls[2]?.body).toEqual({ enabled: false });
		expect(r.reply).toContain("Now using personal-pro");
		expect(r.reply).toContain("work-max — disabled");
		expect(r.reply).toContain("personal-pro — enabled");
	});

	it("refuses an ambiguous account with the candidate list and never PATCHes", async () => {
		const payload = accountsPayload();
		const provider = payload.providers[0];
		if (!provider) throw new Error("fixture missing provider");
		// Both accounts share a label so the token matches more than one.
		for (const account of provider.accounts) account.label = "dup";
		const fetchMock = vi.fn(async () => jsonResponse(payload));
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(
			runtime,
			msg("/accounts use claude dup"),
			OWNER,
		);
		expect(r.reply).toContain("matches more than one");
		expect(r.reply).toContain("acct-work-1234");
		expect(r.reply).toContain("acct-personal-5678");
		expect(
			recordedCalls(fetchMock).filter((c) => c.method === "PATCH"),
		).toEqual([]);
	});

	it("refuses an unknown account with the candidate list and never PATCHes", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(accountsPayload()));
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(
			runtime,
			msg("/accounts enable claude nosuch"),
			OWNER,
		);
		expect(r.reply).toContain(
			'No anthropic-subscription account matches "nosuch"',
		);
		expect(r.reply).toContain("work-max");
		expect(r.reply).toContain("personal-pro");
		expect(
			recordedCalls(fetchMock).filter((c) => c.method === "PATCH"),
		).toEqual([]);
	});

	it("matches by id prefix (≥6 chars) and email, and disable is a single PATCH", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) =>
				(init?.method ?? "GET") === "GET"
					? jsonResponse(accountsPayload())
					: jsonResponse({ ok: true }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const byPrefix = await resolveCommand(
			runtime,
			msg("/accounts disable claude acct-w"),
			OWNER,
		);
		expect(byPrefix.reply).toBe(
			"Disabled work-max for anthropic-subscription.",
		);

		const byEmail = await resolveCommand(
			runtime,
			msg("/accounts enable claude me@example.com"),
			OWNER,
		);
		expect(byEmail.reply).toBe(
			"Enabled personal-pro for anthropic-subscription.",
		);

		const patches = recordedCalls(fetchMock).filter(
			(c) => c.method === "PATCH",
		);
		expect(patches).toEqual([
			{
				url: patches[0]?.url ?? "",
				method: "PATCH",
				body: { enabled: false },
			},
			{
				url: patches[1]?.url ?? "",
				method: "PATCH",
				body: { enabled: true },
			},
		]);
		expect(patches[0]?.url).toContain(
			"/api/accounts/anthropic-subscription/acct-work-1234",
		);
		expect(patches[1]?.url).toContain(
			"/api/accounts/anthropic-subscription/acct-personal-5678",
		);
	});

	it("strategy PATCHes the provider strategy route with the exact body", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ providerId: "cerebras-api", strategy: "least-used" }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(
			runtime,
			msg("/accounts strategy cerebras least-used"),
			OWNER,
		);
		const [call] = recordedCalls(fetchMock);
		expect(call?.method).toBe("PATCH");
		expect(new URL(call?.url ?? "").pathname).toBe(
			"/api/providers/cerebras-api/strategy",
		);
		expect(call?.body).toEqual({ strategy: "least-used" });
		expect(r.reply).toBe(
			"Account strategy for cerebras-api set to least-used.",
		);
	});

	it("surfaces a strategy route 400 verbatim", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ error: "Unknown providerId: cerebras-api" }, 400),
		);
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(
			runtime,
			msg("/accounts strategy cerebras priority"),
			OWNER,
		);
		expect(r.reply).toContain("Unknown providerId: cerebras-api");
	});

	it("refresh POSTs refresh-usage per account then re-reads fresh usage", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				if ((init?.method ?? "GET") === "GET") {
					const refreshed = fetchMock.mock.calls.length > 1;
					return jsonResponse(
						accountsPayload(refreshed ? { sessionPct: 99 } : {}),
					);
				}
				return jsonResponse({ account: {}, source: "pool" });
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(
			runtime,
			msg("/accounts refresh claude"),
			OWNER,
		);
		const calls = recordedCalls(fetchMock);
		expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
			"GET /api/accounts",
			"POST /api/accounts/anthropic-subscription/acct-work-1234/refresh-usage",
			"POST /api/accounts/anthropic-subscription/acct-personal-5678/refresh-usage",
			"GET /api/accounts",
		]);
		expect(r.reply).toContain("Refreshed usage for anthropic-subscription");
		expect(r.reply).toContain("session 99%");
	});

	it("refresh with an account token targets just that account and reports probe failures", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				if ((init?.method ?? "GET") === "GET") {
					return jsonResponse(accountsPayload());
				}
				return jsonResponse({ error: "No credential available" }, 400);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(
			runtime,
			msg("/accounts refresh claude work-max"),
			OWNER,
		);
		const posts = recordedCalls(fetchMock).filter((c) => c.method === "POST");
		expect(posts).toHaveLength(1);
		expect(posts[0]?.url).toContain("acct-work-1234/refresh-usage");
		expect(r.reply).toContain("Refresh failed for:");
		expect(r.reply).toContain("work-max: No credential available");
	});
});

describe("/backend", () => {
	let runtime: IAgentRuntime;
	beforeEach(() => {
		initForRuntime("agent-accounts-backend");
		runtime = makeRuntime();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("parses show, writes, the elizaos alias, and usage errors", () => {
		expect(
			parseBackendArgs({ key: "backend", canonical: "/backend", args: [] }),
		).toEqual({ kind: "show" });
		expect(
			parseBackendArgs({
				key: "backend",
				canonical: "/backend",
				args: [],
				rawArgs: "codex",
			}),
		).toEqual({ kind: "write", backend: "codex" });
		expect(
			parseBackendArgs({
				key: "backend",
				canonical: "/backend",
				args: [],
				rawArgs: "elizaos",
			}),
		).toEqual({ kind: "write", backend: "eliza-code" });
		expect(
			parseBackendArgs({
				key: "backend",
				canonical: "/backend",
				args: [],
				rawArgs: "vscode",
			}),
		).toMatchObject({ kind: "usage" });
		expect(
			parseBackendArgs({
				key: "backend",
				canonical: "/backend",
				args: [],
				rawArgs: "codex extra",
			}),
		).toMatchObject({ kind: "usage" });
	});

	it("bare /backend reads the coding target and lists the available backends", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				targets: {
					coding: {
						ELIZA_DEFAULT_AGENT_TYPE: {
							value: "opencode",
							source: "config.env",
						},
					},
				},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(runtime, msg("/backend"), AUTHORIZED);
		expect(r.handled).toBe(true);
		const [call] = recordedCalls(fetchMock);
		expect(call?.url).toContain("/api/models/config");
		expect(call?.method).toBe("GET");
		expect(r.reply).toContain("Default coding backend: opencode (config.env)");
		expect(r.reply).toContain("codex, claude, opencode, eliza");
	});

	it("bare /backend reports the unset state", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ targets: { coding: { ELIZA_DEFAULT_AGENT_TYPE: null } } }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(runtime, msg("/backend"), AUTHORIZED);
		expect(r.reply).toContain("not set");
	});

	it("requires authorization for the read and never hits the route", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(runtime, msg("/backend"));
		expect(r.reply).toBe("This command requires authorization.");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("POSTs the defaultBackend-only write and narrates the restart-free apply", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				applied: true,
				restart: false,
				keys: ["ELIZA_DEFAULT_AGENT_TYPE"],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(runtime, msg("/backend codex"), OWNER);
		const [call] = recordedCalls(fetchMock);
		expect(call?.url).toContain("/api/models/config");
		expect(call?.method).toBe("POST");
		expect(call?.body).toEqual({ target: "coding", defaultBackend: "codex" });
		expect(r.reply).toContain("Default coding backend set to codex");
		expect(r.reply).toContain("no restart needed");
	});

	it("refuses writes (and usage errors) without elevation, never hitting the route", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const write = await resolveCommand(
			runtime,
			msg("/backend codex"),
			AUTHORIZED,
		);
		expect(write.reply).toBe("This command requires elevated permissions.");

		const usage = await resolveCommand(
			runtime,
			msg("/backend vscode"),
			AUTHORIZED,
		);
		expect(usage.reply).toBe("This command requires elevated permissions.");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns the usage error for an unknown backend when elevated", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(runtime, msg("/backend vscode"), OWNER);
		expect(r.reply).toContain('Unknown coding backend "vscode"');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("passes the route's 400 validation error through verbatim", async () => {
		const error = 'Unknown defaultBackend "vscode"';
		const fetchMock = vi.fn(async () =>
			jsonResponse({ error, code: "MODEL_CONFIG_INVALID", context: {} }, 400),
		);
		vi.stubGlobal("fetch", fetchMock);

		const r = await resolveCommand(runtime, msg("/backend opencode"), OWNER);
		expect(r.reply).toContain(error);
	});
});

describe("connector read gate (requiresAuth only, not requiresElevated)", () => {
	beforeEach(() => {
		initForRuntime("agent-accounts-backend");
	});

	// Regression: definition-level requiresElevated made connectors (which gate
	// via gateConnectorCommandByName BEFORE runCommand) refuse the bare read to
	// an authorized-but-not-elevated sender. With requiresAuth only, the read
	// passes the bridge and the write subcommands re-check isElevated in-handler.
	it.each([
		"accounts",
		"backend",
	])("lets an authorized non-elevated sender through the bridge for /%s", (name) => {
		const decision = gateConnectorCommandByName(
			"agent-accounts-backend",
			name,
			{ isAuthorized: true, isElevated: false, senderName: "t" },
		);
		expect(decision.allowed).toBe(true);
	});

	it.each([
		"accounts",
		"backend",
	])("refuses an unauthorized sender at the bridge for /%s", (name) => {
		const decision = gateConnectorCommandByName(
			"agent-accounts-backend",
			name,
			{ isAuthorized: false, isElevated: false, senderName: "t" },
		);
		expect(decision.allowed).toBe(false);
	});
});
