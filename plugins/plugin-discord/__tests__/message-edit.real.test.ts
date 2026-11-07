/**
 * Discord message edits through the real connector, assistant message service,
 * and PGlite runtime. Deterministic model fixtures and a captured DM send seam
 * replace external services. A wrapper around `runtime.useModel` holds Stage 1
 * so an edit can land before the agent decides to respond; holding the send
 * lands one after it started typing. `message-edit.test.ts` covers the same
 * rules against a stub message service.
 */

import { inspect } from "node:util";
import { createUniqueUuid, ModelType } from "@elizaos/core";
import { createAssistantPlugin } from "@elizaos/plugin-assistant";
import { createTestRuntimeWithModelProvider } from "@elizaos/testing/runtime";
import type { Message as DiscordMessage } from "discord.js";
import { ChannelType as DiscordChannelType } from "discord.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageManager } from "../messages.ts";
import { DiscordService } from "../service.ts";
import { createTurnDrainRegistry } from "../shutdown-drain.ts";
import type { DiscordSettings, IDiscordService } from "../types.ts";

const cleanups: Array<() => Promise<void>> = [];
let savedPassiveConnectors: string | undefined;

beforeEach(() => {
	// Passive connectors default on and only ingest; see connector-loop.real.
	savedPassiveConnectors = process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS;
	process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS = "false";
});

afterEach(async () => {
	while (cleanups.length > 0) {
		const cleanup = cleanups.pop();
		if (cleanup) await cleanup();
	}
	if (savedPassiveConnectors === undefined) {
		delete process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS;
	} else {
		process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS = savedPassiveConnectors;
	}
});

/** The "# Current message" JSON the Stage-1 prompt shows the model. */
function currentMessage(prompt: string): Record<string, unknown> {
	const json = /# Current message\n(\{.*\})/.exec(prompt)?.[1];
	if (!json) throw new Error("prompt has no current message");
	return JSON.parse(json);
}

const BOT_ID = "9999999999999999999";
const AUTHOR_ID = "555000111222333444";
const EDITED_AT = Date.UTC(2026, 9, 20, 20, 57, 23);

interface Gate {
	entered: Promise<void>;
	release: () => void;
}

function gate(): Gate & { enter: () => void; released: Promise<void> } {
	let enter = () => {};
	let release = () => {};
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { entered, enter, released, release };
}

/**
 * One DM channel on a real runtime. `replies` maps the current text of the
 * message to the Stage-1 reply; `holdStage1` / `holdSend` hold the next
 * RESPONSE_HANDLER call or DM send until released.
 */
async function createEditHarness(options: {
	channelId: string;
	messageId: string;
	replies: Record<string, string>;
}) {
	const stage1Prompts: string[] = [];
	let stage1Calls = 0;
	const harness = await createTestRuntimeWithModelProvider({
		plugins: [createAssistantPlugin()],
		fixtures: [
			{
				name: "edit-stage1",
				match: { modelType: ModelType.RESPONSE_HANDLER },
				times: "any",
				response: (call) => {
					stage1Prompts.push(call.latestUserText);
					const text = currentMessage(call.latestUserText).currentMessageText;
					const reply = options.replies[String(text)];
					if (!reply) throw new Error(`no reply for "${text}"`);
					return {
						contexts: ["simple"],
						intents: [],
						replyText: reply,
						candidateActionNames: [],
					};
				},
			},
		],
	});
	cleanups.push(harness.cleanup);
	const { runtime } = harness;

	const sent: string[] = [];
	const errors: string[] = [];
	const stage1Holds: Array<ReturnType<typeof gate>> = [];
	const sendHolds: Array<ReturnType<typeof gate>> = [];

	const useModel = runtime.useModel.bind(runtime);
	runtime.useModel = (async (...args: Parameters<typeof runtime.useModel>) => {
		if (args[0] === ModelType.RESPONSE_HANDLER) {
			stage1Calls += 1;
			const hold = stage1Holds.shift();
			if (hold) {
				hold.enter();
				await hold.released;
			}
		}
		return useModel(...args);
	}) as typeof runtime.useModel;

	const logError = runtime.logger.error.bind(runtime.logger);
	runtime.logger.error = ((...args: unknown[]) => {
		errors.push(
			inspect(args, { depth: 4, breakLength: Number.POSITIVE_INFINITY }),
		);
		return (logError as (...rest: unknown[]) => void)(...args);
	}) as typeof runtime.logger.error;
	const reportError = runtime.reportError.bind(runtime);
	runtime.reportError = ((scope: string, error: unknown, ...rest: never[]) => {
		errors.push(
			`${scope}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return reportError(scope, error, ...rest);
	}) as typeof runtime.reportError;

	const capture = async (payload: string | { content?: string }) => {
		const hold = sendHolds.shift();
		if (hold) {
			hold.enter();
			await hold.released;
		}
		const content =
			typeof payload === "string" ? payload : (payload.content ?? "");
		sent.push(content);
		return {
			id: `${options.channelId}${sent.length}`,
			content,
			createdTimestamp: Date.now(),
			attachments: { size: 0 },
		};
	};
	const author = {
		id: AUTHOR_ID,
		bot: false,
		username: "tester",
		globalName: "Tester",
		displayName: "Tester",
		discriminator: "0",
		displayAvatarURL: () => "https://cdn.discordapp.com/avatar.png",
		send: capture,
	};
	const channel = {
		id: options.channelId,
		type: DiscordChannelType.DM,
		name: undefined,
		guild: undefined,
		recipient: author,
		client: { user: { id: BOT_ID } },
		isThread: () => false,
		permissionsFor: () => ({ has: () => true }),
		// Failure replies go to the channel; capture them with the DM sends.
		send: capture,
	};

	const discordSettings: DiscordSettings = {
		autoReply: true,
		shouldRespondOnlyToMentions: false,
		shouldIgnoreBotMessages: true,
		shouldIgnoreDirectMessages: false,
		dmPolicy: "open",
		replyToMode: "first",
	};
	const discordService = Object.assign(
		Object.create(DiscordService.prototype),
		{
			runtime,
			client: {
				user: { id: BOT_ID },
				users: { fetch: async () => author },
			},
			clientReadyPromise: null,
			accountId: "default",
			defaultAccountId: "default",
			discordSettings,
			ownerDiscordUserIds: new Set<string>(),
			accountPool: { get: () => null, getDefault: () => null },
			turnDrainRegistry: createTurnDrainRegistry(),
			dmRegistries: new Map(),
			ingressClosedReason: null,
			accountTurnRegistries: new Map(),
			cordonedAccounts: new Set<string>(),
		},
	);
	discordService.getChannelType =
		DiscordService.prototype.getChannelType.bind(discordService);
	const manager = new MessageManager(
		discordService as unknown as IDiscordService,
		runtime as never,
	);

	const message = (text: string) =>
		({
			id: options.messageId,
			content: text,
			createdTimestamp: Date.now(),
			editedTimestamp: null,
			author,
			member: null,
			channel,
			channelId: options.channelId,
			guild: null,
			url: `https://discord.com/channels/@me/${options.channelId}/${options.messageId}`,
			interaction: null,
			reference: undefined,
			embeds: [],
			stickers: { size: 0 },
			attachments: { size: 0 },
			mentions: { users: new Map(), repliedUser: undefined },
			partial: false,
			react: async () => undefined,
			reactions: { resolve: () => null },
		}) as unknown as DiscordMessage;

	return {
		runtime,
		manager,
		sent,
		stage1Prompts,
		stage1Calls: () => stage1Calls,
		/**
		 * Errors from the turn itself: the connector, a publication conflict, or
		 * a failed generation. The keyless runtime also logs missing embeddings.
		 */
		connectorErrors: () =>
			errors.filter((line) =>
				/plugin:discord|MESSAGE_CONTENT_PUBLICATION_CONFLICT|bound to different|v5Runtime/i.test(
					line,
				),
			),
		message,
		/** What discord.js does to the cached message when the author edits it. */
		edit(target: DiscordMessage, text: string) {
			Object.assign(target, { content: text, editedTimestamp: EDITED_AT });
			return target;
		},
		stored: () =>
			runtime.getMemoryById(createUniqueUuid(runtime, options.messageId)),
		holdStage1(): Gate {
			const hold = gate();
			stage1Holds.push(hold);
			return hold;
		},
		holdSend(): Gate {
			const hold = gate();
			sendHolds.push(hold);
			return hold;
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("Discord message edits (deterministic model-provider runtime)", () => {
	it("answers an edit after a reply, and the model sees the text it replaced", async () => {
		const h = await createEditHarness({
			channelId: "1253563208833434701",
			messageId: "1253563208833434801",
			replies: { hi: "hey there", "wyd?": "not much, you?" },
		});
		const message = h.message("hi");
		await h.manager.handleMessage(message);
		expect(h.sent).toEqual(["hey there"]);

		await h.manager.handleMessageEdit(h.edit(message, "wyd?"));

		expect(h.sent).toEqual(["hey there", "not much, you?"]);
		const stored = (await h.stored())?.content;
		expect(stored?.currentMessageText).toBe("wyd?");
		expect(stored?.editedFrom).toBe("hi");
		expect(h.stage1Prompts).toHaveLength(2);
		expect(currentMessage(h.stage1Prompts[0]).editedFrom).toBeUndefined();
		expect(currentMessage(h.stage1Prompts[1])).toMatchObject({
			currentMessageText: "wyd?",
			editedFrom: "hi",
		});
		expect(h.connectorErrors()).toEqual([]);
	}, 120_000);

	it("an edit during Stage-1 cancels the original and gets the only reply", async () => {
		const h = await createEditHarness({
			channelId: "1253563208833434702",
			messageId: "1253563208833434802",
			replies: { hihi: "that is doubled", hi: "hi! what's up" },
		});
		const message = h.message("hihi");
		const stage1 = h.holdStage1();
		const original = h.manager.handleMessage(message);
		await stage1.entered;

		const edited = h.manager.handleMessageEdit(h.edit(message, "hi"));
		await settle();
		expect(h.sent).toEqual([]);
		stage1.release();
		await Promise.all([original, edited]);

		// The original's reply never goes out, nor does a failure reply.
		expect(h.sent).toEqual(["hi! what's up"]);
		expect((await h.stored())?.content.currentMessageText).toBe("hi");
		expect(h.connectorErrors()).toEqual([]);
	}, 120_000);

	it("an edit after the agent started typing waits and both are answered", async () => {
		const h = await createEditHarness({
			channelId: "1253563208833434703",
			messageId: "1253563208833434803",
			replies: {
				"remind me at 5": "ok, 5 it is",
				"remind me at 6": "moved it to 6",
			},
		});
		const message = h.message("remind me at 5");
		// The reply is being sent: Stage 1 committed and the agent is typing.
		const send = h.holdSend();
		const original = h.manager.handleMessage(message);
		await send.entered;

		const edited = h.manager.handleMessageEdit(
			h.edit(message, "remind me at 6"),
		);
		await settle();
		// The edit waits for the running turn instead of cancelling it.
		expect(h.stage1Calls()).toBe(1);
		send.release();
		await Promise.all([original, edited]);

		expect(h.sent).toEqual(["ok, 5 it is", "moved it to 6"]);
		expect(currentMessage(h.stage1Prompts[1]).editedFrom).toBe(
			"remind me at 5",
		);
		expect(h.connectorErrors()).toEqual([]);
	}, 120_000);
});
