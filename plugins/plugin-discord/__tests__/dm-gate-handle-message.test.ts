/**
 * Drives MessageManager.handleMessage's real DM-policy gate (messages.ts
 * ~L779-814) end to end — not just the isolated checkDmAccess unit covered by
 * dm-policy.test.ts. The fail-closed "no PairingService" case (dm-policy.test.ts)
 * denies without a reply — `checkDiscordDmAccess` only forwards `replyMessage`
 * when `newRequest` is true (dm-access.ts L76-79), and the fail-closed path
 * never sets `newRequest`. The reply-DM branch is exercised here by mocking
 * `../dm-access` directly, isolating messages.ts's own send/catch handling
 * (L797-811) from the pairing-service internals dm-policy.test.ts already
 * covers.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { ChannelType as DiscordChannelType } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IDiscordService } from "../types";

const CLIENT_ID = "888000000000000000";
const STRANGER_SNOWFLAKE = "600000000000000009";

function makeManager(
	MessageManagerCtor: typeof import("../messages").MessageManager,
	dmPolicy: string,
	reportError = vi.fn(),
) {
	const runtime = {
		agentId: "11111111-1111-1111-1111-111111111111",
		character: { name: "TestAgent" },
		getSetting: () => undefined,
		getService: () => null,
		reportError,
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	} as unknown as IAgentRuntime;
	const service = {
		client: { user: { id: CLIENT_ID } },
		accountId: "default",
		getChannelType: async () => "DM",
		discordSettings: {
			autoReply: true,
			dmPolicy,
			shouldIgnoreBotMessages: true,
			shouldIgnoreDirectMessages: false,
			replyToMode: "first",
		},
	} as unknown as IDiscordService;
	return { manager: new MessageManagerCtor(service, runtime), reportError };
}

function dmMessage(overrides: { send?: ReturnType<typeof vi.fn> } = {}) {
	return {
		id: `msg-${Math.random()}`,
		interaction: undefined,
		author: {
			id: STRANGER_SNOWFLAKE,
			username: "someone",
			displayName: "Someone",
			discriminator: "0",
			bot: false,
			send: overrides.send ?? vi.fn(async () => undefined),
		},
		channel: { type: DiscordChannelType.DM },
	};
}

describe("MessageManager.handleMessage — DM policy gate (real flow, not just checkDmAccess)", () => {
	afterEach(() => {
		vi.doUnmock("../dm-access");
		vi.resetModules();
	});

	it("blocks a stranger under pairing policy with no PairingService: fail-closed, no reply DM", async () => {
		const { MessageManager } = await import("../messages");
		const { manager, reportError } = makeManager(MessageManager, "pairing");
		const message = dmMessage();

		await manager.handleMessage(message as never);

		// dm-access.ts only forwards replyMessage when newRequest is true; the
		// fail-closed "service missing" branch never sets it.
		expect(message.author.send).not.toHaveBeenCalled();
		expect(reportError).toHaveBeenCalledTimes(1);
	});

	it("blocks under a disabled policy without attempting a reply DM", async () => {
		const { MessageManager } = await import("../messages");
		const { manager } = makeManager(MessageManager, "disabled");
		const message = dmMessage();

		await manager.handleMessage(message as never);

		expect(message.author.send).not.toHaveBeenCalled();
	});

	it("DMs the pairing reply via message.author.send when access is denied with a reply message", async () => {
		vi.doMock("../dm-access", () => ({
			checkDiscordDmAccess: vi.fn(async () => ({
				allowed: false,
				replyMessage: "Reply STRANGER to pair.",
			})),
		}));
		const { MessageManager } = await import("../messages");
		const { manager } = makeManager(MessageManager, "pairing");
		const message = dmMessage();

		await manager.handleMessage(message as never);

		expect(message.author.send).toHaveBeenCalledWith("Reply STRANGER to pair.");
	});

	it("warns instead of throwing when the pairing reply DM itself fails to send", async () => {
		vi.doMock("../dm-access", () => ({
			checkDiscordDmAccess: vi.fn(async () => ({
				allowed: false,
				replyMessage: "Reply STRANGER to pair.",
			})),
		}));
		const send = vi.fn(async () => {
			throw new Error("Cannot send messages to this user");
		});
		const { MessageManager } = await import("../messages");
		const { manager } = makeManager(MessageManager, "pairing");
		const message = dmMessage({ send });

		await expect(
			manager.handleMessage(message as never),
		).resolves.toBeUndefined();
		expect(send).toHaveBeenCalledTimes(1);
	});
});
