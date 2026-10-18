/**
 * A guild message is admitted when it arrives, then waits in the channel
 * debouncer (3 s by default) before the message manager handles it. Stopping
 * the service or disconnecting an account must hand that message to the
 * message manager, so the drain tracks it, instead of dropping it with the
 * debouncer. Real DiscordService cordon/drain/disconnect, real
 * setupDiscordEventListeners debouncer, real MessageManager#handleMessage
 * choke point; the turn body and the Discord client are stand-ins.
 */
import type { Message } from "discord.js";
import { describe, expect, it } from "vitest";
import { setupDiscordEventListeners } from "../discord-events.ts";
import { MessageManager } from "../messages.ts";
import { DiscordService } from "../service.ts";
import { createTurnDrainRegistry } from "../shutdown-drain.ts";

const ACCOUNT_ID = "second";

function message(id: string, content: string): Message {
	return {
		id,
		content,
		channel: { id: "channel-1" },
		author: { id: "user-1", username: "alice", displayName: "Alice" },
		mentions: { repliedUser: undefined },
		reference: null,
		attachments: new Map(),
		embeds: [],
	} as unknown as Message;
}

function serviceWithQueuedMessage() {
	const handled: string[] = [];
	const state = {
		accountId: ACCOUNT_ID,
		client: { destroy: async () => undefined },
		channelDebouncer: undefined as
			| ReturnType<typeof setupDiscordEventListeners>["channelDebouncer"]
			| undefined,
		messageManager: undefined as MessageManager | undefined,
	};
	const states = new Map([[ACCOUNT_ID, state]]);
	const service = Object.assign(Object.create(DiscordService.prototype), {
		runtime: {
			agentId: "00000000-0000-4000-8000-000000000001",
			getSetting: () => undefined,
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			reportError() {},
		},
		client: { user: { id: "999" }, on() {}, once() {} },
		discordSettings: {},
		accountId: ACCOUNT_ID,
		defaultAccountId: "default",
		accountPool: {
			get: (id: string) => states.get(id) ?? null,
			list: () => [...states.values()],
			delete: (id: string) => states.delete(id),
		},
		voiceTargets: { list: () => [], unregisterAccount() {} },
		audioSinks: new Map(),
		turnDrainRegistry: createTurnDrainRegistry(),
		ingressClosedReason: null,
		accountTurnRegistries: new Map(),
		cordonedAccounts: new Set<string>(),
	});
	// Per-account facade, as createAccountServiceFacade binds it.
	const facade = Object.assign(Object.create(service), {
		admitInboundMessage: (messageId: string, channelId: string) =>
			service.admitInboundMessage(messageId, channelId, ACCOUNT_ID),
		trackInFlightTurn: (messageId: string, promise: Promise<unknown>) =>
			service.trackInFlightTurn(messageId, promise, ACCOUNT_ID),
	});
	const manager = Object.assign(Object.create(MessageManager.prototype), {
		discordService: facade,
		runMessageTurn: async (handledMessage: Message) => {
			handled.push(handledMessage.id);
		},
		destroy() {},
	}) as MessageManager;
	facade.messageManager = manager;
	state.messageManager = manager;
	const { channelDebouncer } = setupDiscordEventListeners(facade);
	state.channelDebouncer = channelDebouncer;

	// An unaddressed guild message waits for the debounce window.
	channelDebouncer.enqueue(message("m1", "anyone around?"));
	expect(handled).toEqual([]);
	return { service: service as DiscordService, handled };
}

describe("Discord stop with debounced guild messages", () => {
	it("handles and drains a queued message on service shutdown", async () => {
		const { service, handled } = serviceWithQueuedMessage();

		service.prepareStop("shutdown");
		const drain = await (
			service as unknown as {
				turnDrainRegistry: ReturnType<typeof createTurnDrainRegistry>;
			}
		).turnDrainRegistry.drain(1_000);

		expect(handled).toEqual(["m1"]);
		expect(drain.observedCount).toBe(1);
		expect(drain.timedOut).toBe(false);
	});

	it("handles and drains a queued message on account disconnect", async () => {
		const { service, handled } = serviceWithQueuedMessage();

		const drain = await service.disconnectAccount(ACCOUNT_ID);

		expect(handled).toEqual(["m1"]);
		expect(drain.observedCount).toBe(1);
	});
});
