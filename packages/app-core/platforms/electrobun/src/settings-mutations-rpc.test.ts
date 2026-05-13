import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentNotReadyError } from "./config-and-auth-rpc";
import {
	type AgentAutomationModeReader,
	type AgentAutomationModeWriter,
	type ConfigUpdateWriter,
	composeAgentAutomationModeSnapshot,
	composeAgentAutomationModeUpdate,
	composeConfigUpdate,
	composeTradePermissionModeSnapshot,
	composeTradePermissionModeUpdate,
	readAgentAutomationModeViaHttp,
	readTradePermissionModeViaHttp,
	type TradePermissionModeReader,
	type TradePermissionModeWriter,
	updateAgentAutomationModeViaHttp,
	updateConfigViaHttp,
	updateTradePermissionModeViaHttp,
} from "./settings-mutations-rpc";

const originalFetch = globalThis.fetch;

function mockFetchJson(status: number, body: unknown) {
	const fetchMock = vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(JSON.stringify(body), { status }),
	);
	const replacement: typeof fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => fetchMock(input, init),
		{ preconnect: globalThis.fetch.preconnect },
	);
	globalThis.fetch = replacement;
	return fetchMock;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("settings mutation typed RPC", () => {
	it("throws AgentNotReadyError when updateConfig has no port", async () => {
		const writer: ConfigUpdateWriter = async () => ({});

		await expect(
			composeConfigUpdate(null, { theme: "dark" }, writer),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("writes config through the HTTP bridge", async () => {
		const fetchMock = mockFetchJson(200, {
			theme: "dark",
			cloud: { provider: "openai" },
		});

		await expect(
			updateConfigViaHttp(31337, { theme: "dark" }),
		).resolves.toEqual({
			theme: "dark",
			cloud: { provider: "openai" },
		});
		const call = fetchMock.mock.calls[0];
		expect(String(call?.[0])).toContain("/api/config");
		expect(call?.[1]?.method).toBe("PUT");
		expect(call?.[1]?.body).toBe(JSON.stringify({ theme: "dark" }));
	});

	it("returns null when config update does not return an object", async () => {
		mockFetchJson(200, "ok");

		await expect(updateConfigViaHttp(31337, { theme: "dark" })).resolves.toBe(
			null,
		);
	});

	it("throws AgentNotReadyError when automation mode has no port", async () => {
		const reader: AgentAutomationModeReader = async () => ({
			mode: "connectors-only",
			options: ["connectors-only", "full"],
		});
		const writer: AgentAutomationModeWriter = async () => ({
			mode: "full",
			options: ["connectors-only", "full"],
		});

		await expect(
			composeAgentAutomationModeSnapshot(null, reader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
		await expect(
			composeAgentAutomationModeUpdate(null, "full", writer),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("reads and writes automation mode", async () => {
		mockFetchJson(200, {
			mode: "full",
			options: ["connectors-only", "full"],
		});

		await expect(readAgentAutomationModeViaHttp(31337)).resolves.toEqual({
			mode: "full",
			options: ["connectors-only", "full"],
		});

		const fetchMock = mockFetchJson(200, {
			mode: "connectors-only",
			options: ["connectors-only", "full"],
		});

		await expect(
			updateAgentAutomationModeViaHttp(31337, "connectors-only"),
		).resolves.toEqual({
			mode: "connectors-only",
			options: ["connectors-only", "full"],
		});
		expect(callBody(fetchMock)).toBe(
			JSON.stringify({ mode: "connectors-only" }),
		);
	});

	it("rejects malformed automation mode payloads", async () => {
		mockFetchJson(200, {
			mode: "full",
			options: ["connectors-only", "bad"],
		});

		await expect(readAgentAutomationModeViaHttp(31337)).resolves.toBeNull();
	});

	it("throws AgentNotReadyError when trade mode has no port", async () => {
		const reader: TradePermissionModeReader = async () => ({
			mode: "user-sign-only",
			tradePermissionMode: "user-sign-only",
			options: ["user-sign-only", "manual-local-key", "agent-auto"],
		});
		const writer: TradePermissionModeWriter = async () => ({
			ok: true,
			mode: "agent-auto",
			tradePermissionMode: "agent-auto",
		});

		await expect(
			composeTradePermissionModeSnapshot(null, reader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
		await expect(
			composeTradePermissionModeUpdate(null, "agent-auto", writer),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("reads and writes trade mode", async () => {
		mockFetchJson(200, {
			tradePermissionMode: "manual-local-key",
			canUserLocalExecute: true,
			canAgentAutoTrade: false,
			options: ["user-sign-only", "manual-local-key", "agent-auto"],
		});

		await expect(readTradePermissionModeViaHttp(31337)).resolves.toEqual({
			mode: "manual-local-key",
			tradePermissionMode: "manual-local-key",
			canUserLocalExecute: true,
			canAgentAutoTrade: false,
			options: ["user-sign-only", "manual-local-key", "agent-auto"],
		});

		const fetchMock = mockFetchJson(200, {
			ok: true,
			tradePermissionMode: "agent-auto",
		});

		await expect(
			updateTradePermissionModeViaHttp(31337, "agent-auto"),
		).resolves.toEqual({
			ok: true,
			mode: "agent-auto",
			tradePermissionMode: "agent-auto",
		});
		expect(callBody(fetchMock)).toBe(JSON.stringify({ mode: "agent-auto" }));
	});

	it("rejects malformed trade mode payloads", async () => {
		mockFetchJson(200, {
			tradePermissionMode: "bad",
		});

		await expect(readTradePermissionModeViaHttp(31337)).resolves.toBeNull();
	});
});

function callBody(
	fetchMock: ReturnType<typeof mockFetchJson>,
): BodyInit | null {
	return fetchMock.mock.calls[0]?.[1]?.body ?? null;
}
