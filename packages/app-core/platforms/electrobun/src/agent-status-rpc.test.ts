import { describe, expect, it, vi } from "vitest";
import {
	type AgentStatusReader,
	composeAgentStatusSnapshot,
	readAgentStatusViaHttp,
} from "./agent-status-rpc";
import { AgentNotReadyError } from "./config-and-auth-rpc";

function mockFetchJson(status: number, body: unknown) {
	const fetchMock = vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(JSON.stringify(body), {
				status,
			}),
	);
	const replacement: typeof fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => fetchMock(input, init),
		{ preconnect: globalThis.fetch.preconnect },
	);
	globalThis.fetch = replacement;
	return fetchMock;
}

describe("getAgentStatus typed RPC", () => {
	it("throws AgentNotReadyError when port is null", async () => {
		const reader: AgentStatusReader = async () => ({
			state: "running",
			agentName: "eliza",
		});

		await expect(
			composeAgentStatusSnapshot(null, reader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("forwards a valid /api/status payload", async () => {
		const reader: AgentStatusReader = async () => ({
			state: "running",
			agentName: "eliza",
			model: "gpt-5.5",
			uptime: 1000,
			startedAt: 1700000000000,
			pendingRestart: true,
			pendingRestartReasons: ["config"],
			startup: { phase: "running" },
			cloud: {
				connectionStatus: "connected",
				activeAgentId: "agent-1",
				cloudProvisioned: true,
				hasApiKey: true,
			},
		});

		const snap = await composeAgentStatusSnapshot(31337, reader);
		expect(snap.state).toBe("running");
		expect(snap.agentName).toBe("eliza");
		expect(snap.cloud?.activeAgentId).toBe("agent-1");
		expect(snap.pendingRestartReasons).toEqual(["config"]);
	});

	it("reads and validates the HTTP status payload", async () => {
		mockFetchJson(200, {
			state: "starting",
			agentName: "milady",
			startedAt: 1700000000000,
			cloud: {
				connectionStatus: "disconnected",
				activeAgentId: null,
				cloudProvisioned: false,
				hasApiKey: false,
			},
		});

		await expect(readAgentStatusViaHttp(31337)).resolves.toEqual({
			state: "starting",
			agentName: "milady",
			startedAt: 1700000000000,
			cloud: {
				connectionStatus: "disconnected",
				activeAgentId: null,
				cloudProvisioned: false,
				hasApiKey: false,
			},
		});
	});

	it("returns null on malformed status payloads", async () => {
		mockFetchJson(200, {
			state: "paused",
			agentName: "milady",
		});

		await expect(readAgentStatusViaHttp(31337)).resolves.toBeNull();
	});
});
