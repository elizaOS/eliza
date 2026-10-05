import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EMBEDDED_PORT = 45123;
const LOCAL_TOKEN = "local-desktop-secret";

vi.mock("./native/agent", () => ({
	configureDesktopLocalApiAuth: () => LOCAL_TOKEN,
	getAgentManager: () => ({ getPort: () => EMBEDDED_PORT }),
}));

import { postAgentResetFromMain } from "./agent-reset-from-main";
import {
	createMainApiHeaderBuilder,
	postCloudDisconnectFromMain,
} from "./cloud-disconnect-from-main";

const ENV_KEYS = [
	"ELIZA_API_TOKEN",
	"ELIZA_DESKTOP_TEST_API_BASE",
	"ELIZA_DESKTOP_API_BASE",
	"ELIZA_API_BASE_URL",
	"ELIZA_API_BASE",
	"ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT",
	"ELIZA_DESKTOP_LOCAL_AGENT_IPC",
	"ELIZA_RENDERER_URL",
	"VITE_DEV_SERVER_URL",
	"ELIZA_API_PORT",
	"ELIZA_PORT",
] as const;

type Call = { url: string; authorization: string | undefined };

function recordingFetch(calls: Call[]) {
	return async (input: string, init?: RequestInit): Promise<Response> => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({ url: input, authorization: headers.Authorization });
		return new Response("{}", {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	};
}

describe("main-process API headers for reset / cloud disconnect", () => {
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	it("never sends the local API bearer to a renderer-chosen remote apiBase (disconnect)", async () => {
		const calls: Call[] = [];
		const result = await postCloudDisconnectFromMain({
			fetchImpl: recordingFetch(calls),
			apiBaseOverride: "https://remote.example.com",
			bearerTokenOverride: null,
		});
		expect(result).toEqual({ ok: true });
		const remoteCalls = calls.filter((c) =>
			c.url.startsWith("https://remote.example.com"),
		);
		expect(remoteCalls.length).toBeGreaterThan(0);
		for (const call of remoteCalls) {
			expect(call.authorization).toBeUndefined();
		}
	});

	it("never sends the configured ELIZA_API_TOKEN to a renderer-chosen remote apiBase (reset)", async () => {
		process.env.ELIZA_API_TOKEN = "env-configured-secret";
		const calls: Call[] = [];
		const result = await postAgentResetFromMain({
			fetchImpl: recordingFetch(calls),
			apiBaseOverride: "https://remote.example.com",
			bearerTokenOverride: null,
		});
		expect(result).toEqual({ ok: true });
		expect(calls.map((c) => c.url)).toEqual([
			"https://remote.example.com/api/status",
			"https://remote.example.com/api/agent/reset",
		]);
		for (const call of calls) {
			expect(call.authorization).toBeUndefined();
		}
	});

	it("still authenticates to the embedded local agent in local mode", async () => {
		const calls: Call[] = [];
		const result = await postAgentResetFromMain({
			fetchImpl: recordingFetch(calls),
			apiBaseOverride: `http://127.0.0.1:${EMBEDDED_PORT}`,
		});
		expect(result).toEqual({ ok: true });
		expect(calls.length).toBe(2);
		for (const call of calls) {
			expect(call.authorization).toBe(`Bearer ${LOCAL_TOKEN}`);
		}
	});

	it("authenticates to the loopback dev-server origin that proxies the local agent", () => {
		process.env.ELIZA_RENDERER_URL = "http://localhost:2138/";
		const build = createMainApiHeaderBuilder({
			localAgentOrigins: ["http://localhost:2138"],
		});
		expect(build("http://localhost:2138/api/status").Authorization).toBe(
			`Bearer ${LOCAL_TOKEN}`,
		);
		expect(
			build("https://remote.example.com/api/status").Authorization,
		).toBeUndefined();
	});

	it("forwards a renderer-provided bearer to its own apiBase", async () => {
		const calls: Call[] = [];
		await postCloudDisconnectFromMain({
			fetchImpl: recordingFetch(calls),
			apiBaseOverride: "https://remote.example.com",
			bearerTokenOverride: "renderer-remote-token",
		});
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call.authorization).toBe("Bearer renderer-remote-token");
		}
	});

	it("in external mode only sends the configured token to the external origin", () => {
		process.env.ELIZA_DESKTOP_API_BASE = "https://agent.example.com";
		process.env.ELIZA_API_TOKEN = "external-secret";
		const build = createMainApiHeaderBuilder({ localAgentOrigins: [] });
		expect(build("https://agent.example.com/api/status").Authorization).toBe(
			"Bearer external-secret",
		);
		expect(
			build("https://attacker.example.com/api/status").Authorization,
		).toBeUndefined();
	});

	it("sends no main-process token in disabled mode", () => {
		process.env.ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT = "1";
		process.env.ELIZA_API_TOKEN = "env-secret";
		const build = createMainApiHeaderBuilder({
			localAgentOrigins: [`http://127.0.0.1:${EMBEDDED_PORT}`],
		});
		expect(
			build(`http://127.0.0.1:${EMBEDDED_PORT}/api/status`).Authorization,
		).toBeUndefined();
	});
});
