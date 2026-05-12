import { describe, expect, it, mock } from "bun:test";
import { AgentNotReadyError } from "./config-and-auth-rpc";
import {
	type AgentSelfStatusReader,
	type CorePluginsReader,
	composeAgentSelfStatusSnapshot,
	composeCorePluginsSnapshot,
	composeTriggerHealthSnapshot,
	readAgentSelfStatusViaHttp,
	readCorePluginsViaHttp,
	readTriggerHealthViaHttp,
	type TriggerHealthReader,
} from "./dashboard-rpc";
import type {
	AgentSelfStatusSnapshot,
	CorePluginsSnapshot,
	TriggerHealthSnapshot,
} from "./rpc-schema";

function mockFetchJson(status: number, body: unknown) {
	const fetchMock = mock(
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

const agentSelfStatus = {
	generatedAt: "2026-05-12T12:00:00.000Z",
	state: "running",
	agentName: "Milady",
	model: "gpt-5.5",
	provider: "openai",
	automationMode: "full",
	tradePermissionMode: "user-sign-only",
	shellEnabled: true,
	wallet: {
		walletSource: "local",
		evmAddress: "0x1234567890abcdef",
		evmAddressShort: "0x1234...cdef",
		solanaAddress: null,
		solanaAddressShort: null,
		hasWallet: true,
		hasEvm: true,
		hasSolana: false,
		localSignerAvailable: true,
		managedBscRpcReady: true,
		rpcReady: true,
		pluginEvmLoaded: true,
		pluginEvmRequired: true,
		executionReady: true,
		executionBlockedReason: null,
	},
	plugins: {
		totalActive: 2,
		active: ["openai", "plugin-wallet"],
		aiProviders: ["openai"],
		connectors: [],
	},
	capabilities: {
		canTrade: true,
		canLocalTrade: true,
		canAutoTrade: false,
		canUseBrowser: false,
		canUseComputer: false,
		canRunTerminal: true,
		canInstallPlugins: true,
		canConfigurePlugins: true,
		canConfigureConnectors: true,
	},
	registrySummary: "registered",
} satisfies AgentSelfStatusSnapshot;

const triggerHealth = {
	triggersEnabled: true,
	activeTriggers: 2,
	disabledTriggers: 1,
	totalExecutions: 14,
	totalFailures: 1,
	totalSkipped: 3,
	lastExecutionAt: 1_700_000_000_000,
} satisfies TriggerHealthSnapshot;

const corePlugins = {
	core: [
		{
			npmName: "@elizaos/plugin-bootstrap",
			id: "bootstrap",
			name: "Bootstrap",
			isCore: true,
			loaded: true,
			enabled: true,
		},
	],
	optional: [
		{
			npmName: "@elizaos/plugin-discord",
			id: "discord",
			name: "Discord",
			isCore: false,
			loaded: false,
			enabled: false,
		},
	],
} satisfies CorePluginsSnapshot;

describe("dashboard typed RPC readers", () => {
	it("throws AgentNotReadyError when agent self-status has no port", async () => {
		const reader: AgentSelfStatusReader = async () => agentSelfStatus;

		await expect(
			composeAgentSelfStatusSnapshot(null, reader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("forwards the agent self-status snapshot", async () => {
		const reader: AgentSelfStatusReader = async () => agentSelfStatus;

		await expect(
			composeAgentSelfStatusSnapshot(31337, reader),
		).resolves.toEqual(agentSelfStatus);
	});

	it("reads and validates the HTTP agent self-status payload", async () => {
		const fetchMock = mockFetchJson(200, agentSelfStatus);

		await expect(readAgentSelfStatusViaHttp(31337)).resolves.toEqual(
			agentSelfStatus,
		);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
			"/api/agent/self-status",
		);
	});

	it("returns null on malformed agent self-status payloads", async () => {
		mockFetchJson(200, {
			...agentSelfStatus,
			wallet: { ...agentSelfStatus.wallet, executionReady: "yes" },
		});

		await expect(readAgentSelfStatusViaHttp(31337)).resolves.toBeNull();
	});

	it("throws AgentNotReadyError when trigger health has no port", async () => {
		const reader: TriggerHealthReader = async () => triggerHealth;

		await expect(
			composeTriggerHealthSnapshot(null, reader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("reads and validates trigger health", async () => {
		const fetchMock = mockFetchJson(200, triggerHealth);

		await expect(readTriggerHealthViaHttp(31337)).resolves.toEqual(
			triggerHealth,
		);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
			"/api/triggers/health",
		);
	});

	it("returns null on malformed trigger health payloads", async () => {
		mockFetchJson(200, {
			...triggerHealth,
			totalFailures: "1",
		});

		await expect(readTriggerHealthViaHttp(31337)).resolves.toBeNull();
	});

	it("throws AgentNotReadyError when core plugins have no port", async () => {
		const reader: CorePluginsReader = async () => corePlugins;

		await expect(
			composeCorePluginsSnapshot(null, reader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("reads and validates core plugins", async () => {
		const fetchMock = mockFetchJson(200, corePlugins);

		await expect(readCorePluginsViaHttp(31337)).resolves.toEqual(corePlugins);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/plugins/core");
	});

	it("returns null on malformed core plugin payloads", async () => {
		mockFetchJson(200, {
			core: [{ ...corePlugins.core[0], loaded: "true" }],
			optional: corePlugins.optional,
		});

		await expect(readCorePluginsViaHttp(31337)).resolves.toBeNull();
	});
});
