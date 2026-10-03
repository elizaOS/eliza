/**
 * Per-account Discord disconnect through the real ConnectorAccountManager and
 * the real DiscordService disconnect path (#31464). The gateway boundary is a
 * deterministic fake client; admission, drain, teardown, persisted policy and
 * restart filtering run for real.
 */
import {
	ConnectorAccountManager,
	type IAgentRuntime,
	InMemoryConnectorAccountStorage,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordAccountClientPool } from "../account-client-pool";
import type { ResolvedDiscordAccount } from "../accounts";
import {
	DISCORD_ACCOUNT_POLICY_CACHE_KEY,
	readDiscordAccountPolicy,
} from "../connector-account-policy";
import { createDiscordConnectorAccountProvider } from "../connector-account-provider";
import { DiscordService } from "../service";
import { createTurnDrainRegistry } from "../shutdown-drain";
import { DiscordVoiceTargetRegistry } from "../voice-target-registry";

type FakeClient = {
	token: string;
	isReady: () => boolean;
	destroy: ReturnType<typeof vi.fn>;
};

function fakeClient(token: string): FakeClient {
	return {
		token,
		isReady: () => true,
		destroy: vi.fn().mockResolvedValue(undefined),
	};
}

function harness() {
	const accounts = {
		previous: { token: "previous-token", enabled: true },
		replacement: { token: "replacement-token", enabled: true },
	};
	const cache = new Map<string, unknown>();
	const logger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	};
	const runtime = {
		agentId: "agent-1",
		character: { name: "Eliza", settings: { discord: { accounts } } },
		logger,
		getSetting: () => undefined,
		getCache: async (key: string) => structuredClone(cache.get(key)),
		setCache: async (key: string, value: unknown) => {
			cache.set(key, structuredClone(value));
			return true;
		},
		getService: () => service,
	} as unknown as IAgentRuntime;

	const pool = new DiscordAccountClientPool("previous");
	const clients: Record<keyof typeof accounts, FakeClient> = {
		previous: fakeClient("previous-token"),
		replacement: fakeClient("replacement-token"),
	};
	for (const id of ["previous", "replacement"] as const) {
		pool.set({
			accountId: id,
			account: { accountId: id, token: accounts[id].token },
			client: clients[id],
			settings: {},
			dynamicChannelIds: new Set(),
			clientReadyPromise: null,
			loginFailed: false,
			messageManager: { destroy: vi.fn() },
			voiceManager: { stop: vi.fn() },
		} as never);
	}
	const service = Object.assign(Object.create(DiscordService.prototype), {
		runtime,
		accountId: "previous",
		defaultAccountId: "previous",
		accountPool: pool,
		turnDrainRegistry: createTurnDrainRegistry(),
		accountTurnRegistries: new Map(),
		cordonedAccounts: new Set<string>(),
		ingressClosedReason: null,
		voiceTargets: new DiscordVoiceTargetRegistry(),
		audioSinks: new Map(),
		syncLegacyDefaultAliases: vi.fn(),
	}) as DiscordService;

	const manager = new ConnectorAccountManager(
		undefined,
		new InMemoryConnectorAccountStorage(),
	);
	manager.registerProvider(createDiscordConnectorAccountProvider(runtime));
	return { accounts, cache, clients, manager, runtime, service };
}

describe("Discord per-account disconnect", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("persists the policy, drains the account's admitted turn, and keeps the sibling running", async () => {
		const h = harness();
		let finishTurn: () => void = () => undefined;
		const turn = new Promise<void>((resolve) => {
			finishTurn = resolve;
		});
		expect(h.service.admitInboundMessage("m1", "c1", "previous")).toBe(true);
		h.service.trackInFlightTurn("m1", turn, "previous");

		const deletion = h.manager.deleteAccount("discord", "previous");
		await vi.waitFor(async () => {
			expect(
				(await readDiscordAccountPolicy(h.runtime)).previous,
			).toBeDefined();
		});
		// Policy is durable before the gateway stops; new deliveries for the
		// disconnecting account are rejected, the sibling is unaffected, and the
		// admitted turn still holds the teardown.
		expect(h.service.admitInboundMessage("m2", "c1", "previous")).toBe(false);
		expect(h.service.admitInboundMessage("m3", "c1", "replacement")).toBe(true);
		expect(h.clients.previous.destroy).not.toHaveBeenCalled();

		finishTurn();
		await deletion;

		expect(h.clients.previous.destroy).toHaveBeenCalledTimes(1);
		expect(h.clients.replacement.destroy).not.toHaveBeenCalled();
		expect(h.service.getAccountIds()).toEqual(["replacement"]);
		expect(h.service.getClient("replacement")).toBe(h.clients.replacement);
		expect((await h.manager.listAccounts("discord")).map((a) => a.id)).toEqual([
			"replacement",
		]);
		const stored = JSON.stringify(
			h.cache.get(DISCORD_ACCOUNT_POLICY_CACHE_KEY),
		);
		expect(stored).not.toContain("previous-token");
	});

	it("retries a failed gateway teardown and stays disabled meanwhile", async () => {
		const h = harness();
		h.clients.previous.destroy.mockRejectedValueOnce(new Error("socket busy"));

		await expect(
			h.manager.deleteAccount("discord", "previous"),
		).rejects.toThrow("socket busy");
		expect((await readDiscordAccountPolicy(h.runtime)).previous).toBeDefined();
		expect(h.service.admitInboundMessage("m1", "c1", "previous")).toBe(false);
		expect(h.service.getAccountIds()).toContain("previous");

		await h.manager.deleteAccount("discord", "previous");
		expect(h.clients.previous.destroy).toHaveBeenCalledTimes(2);
		expect(h.service.getAccountIds()).toEqual(["replacement"]);
	});

	it("skips the disconnected token on restart but starts a replacement token", async () => {
		const h = harness();
		await h.manager.deleteAccount("discord", "previous");
		const policy = await readDiscordAccountPolicy(h.runtime);

		const started: string[] = [];
		vi.spyOn(
			DiscordService.prototype as unknown as {
				initializeAccount: (account: ResolvedDiscordAccount) => void;
			},
			"initializeAccount",
		).mockImplementation((account) => {
			started.push(account.accountId);
		});

		new DiscordService(h.runtime, policy);
		expect(started).toEqual(["replacement"]);

		started.length = 0;
		h.accounts.previous.token = "client-bot-token";
		new DiscordService(h.runtime, policy);
		expect(started).toEqual(["previous", "replacement"]);
		expect(
			(await h.manager.listAccounts("discord")).map((a) => a.id).sort(),
		).toEqual(["previous", "replacement"]);
	});
});
