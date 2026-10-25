import type { Content, Memory, UUID } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";
import type { Message as DiscordMessage } from "discord.js";
import { ChannelType as DiscordChannelType } from "discord.js";
import { describe, expect, it } from "vitest";
import {
	isSubsetOrEqual,
	MessageManager,
	numericFactSignatureTokens,
} from "../messages";
import type { ICompatRuntime, IDiscordService } from "../types";

// Same decision the callback path makes before sending a second reply to one
// inbound message: suppress when the new signature is a subset of a sent one.
function secondReplySuppressed(first: string, second: string): boolean {
	const sent = numericFactSignatureTokens(first);
	const next = numericFactSignatureTokens(second);
	const priors = sent ? [sent] : [];
	return next !== null && priors.some((prior) => isSubsetOrEqual(next, prior));
}

describe("numericFactSignatureTokens across scripts", () => {
	it("keeps Hangul words next to their numbers", () => {
		expect(
			numericFactSignatureTokens("오늘 회의는 3시와 5시에 있어요"),
		).toEqual(new Set(["3시와", "5시에"]));
		expect(numericFactSignatureTokens("3시 회의가 취소됐어요")).toEqual(
			new Set(["3시", "취소됐어요"]),
		);
	});

	it("keeps Cyrillic words next to their numbers", () => {
		expect(
			numericFactSignatureTokens("Встреча перенесена на 15 марта"),
		).toEqual(new Set(["встреча", "перенесена", "15", "марта"]));
	});

	it("still returns null for a non-Latin reply without a number", () => {
		expect(numericFactSignatureTokens("회의가 취소됐어요")).toBeNull();
	});
});

describe("second reply to the same message", () => {
	it("delivers a different Korean reply that reuses a number", () => {
		expect(
			secondReplySuppressed(
				"오늘 회의는 3시와 5시에 있어요",
				"3시 회의가 취소됐어요",
			),
		).toBe(false);
	});

	it("delivers a different Russian reply that reuses a number", () => {
		expect(
			secondReplySuppressed(
				"Встреча перенесена на 15 марта",
				"Отчёт нужно сдать до 15 марта",
			),
		).toBe(false);
	});

	it("still suppresses an identical Korean reply", () => {
		const reply = "오늘 회의는 3시와 5시에 있어요";
		expect(secondReplySuppressed(reply, reply)).toBe(true);
	});

	it("still suppresses an identical Russian reply", () => {
		const reply = "Встреча перенесена на 15 марта";
		expect(secondReplySuppressed(reply, reply)).toBe(true);
	});

	it("keeps English behavior: bare value after its sentence is suppressed", () => {
		expect(
			secondReplySuppressed(
				"Bitcoin is currently priced at $61,883 USD",
				"$61,883 USD",
			),
		).toBe(true);
	});

	it("keeps English behavior: a different reply reusing a number is delivered", () => {
		expect(
			secondReplySuppressed(
				"Today's meetings are at 3 and 5",
				"The 3 o'clock meeting was cancelled",
			),
		).toBe(false);
	});
});

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as UUID;
const INBOUND_ID = "666000000000000000";
const INBOUND_MEMORY: Memory = {
	id: "12345678-1234-1234-1234-123456789abc" as UUID,
	entityId: "87654321-4321-4321-4321-cba987654321" as UUID,
	agentId: AGENT_ID,
	roomId: "11111111-2222-3333-4444-555555555555" as UUID,
	content: { text: "question", source: "discord" },
};

// Drives the real MessageManager.handleMessage; the message service answers
// one inbound message with two callback replies, and the DM sends are captured.
async function deliverTwoReplies(first: string, second: string) {
	const sent: string[] = [];
	const suppressed: string[] = [];
	const errors: string[] = [];
	const dmUser = {
		id: "555000111222333444",
		send: async (options: { content?: string }) => {
			sent.push(options.content ?? "");
			const id = `99000000000000000${sent.length}`;
			return {
				id,
				content: options.content ?? "",
				url: `https://discord.com/channels/@me/1/${id}`,
				createdTimestamp: Date.now(),
				attachments: { size: 0 },
				edit: async () => ({ id }),
			};
		},
	};
	const channel = {
		id: "777000000000000000",
		type: DiscordChannelType.DM,
		isThread: () => false,
		send: async () => {
			throw new Error("DM replies must go through user.send");
		},
	};
	const runtime = {
		agentId: AGENT_ID,
		character: { name: "Eliza" },
		logger: {
			debug: (fields: { reason?: string }, msg?: string) => {
				if (msg === "Suppressing duplicate callback reply")
					suppressed.push(fields.reason ?? "");
			},
			info: () => {},
			warn: () => {},
			error: (...args: unknown[]) => errors.push(JSON.stringify(args)),
		},
		getSetting: (key: string) =>
			key === "ELIZA_LIFEOPS_PASSIVE_CONNECTORS" ? "false" : undefined,
		getService: () => null,
		ensureConnection: async () => {},
		getRoom: async () => ({ id: INBOUND_MEMORY.roomId, type: ChannelType.DM }),
		getParticipantsForRoom: async () => [INBOUND_MEMORY.entityId, AGENT_ID],
		reportError: (...args: unknown[]) => errors.push(JSON.stringify(args)),
		getMemoryById: async () => null,
		createMemory: async (memory: Memory) => memory.id,
		messageService: {
			handleMessage: async (
				_runtime: unknown,
				_message: Memory,
				callback: (content: Content) => Promise<unknown>,
			) => {
				for (const text of [first, second]) {
					await callback({ text, channelType: "DM", inReplyTo: INBOUND_ID });
				}
			},
		},
	} as unknown as ICompatRuntime;
	const service = {
		client: {
			user: { id: "888000000000000000" },
			users: { fetch: async () => dmUser },
		},
		accountId: "default",
		getChannelType: async () => ChannelType.DM,
		discordSettings: {
			autoReply: true,
			dmPolicy: "open",
			shouldIgnoreBotMessages: true,
			shouldIgnoreDirectMessages: false,
			replyToMode: "first",
		},
		buildMemoryFromMessage: async () => INBOUND_MEMORY,
	} as unknown as IDiscordService;
	const inbound = {
		id: INBOUND_ID,
		content: "question",
		createdTimestamp: Date.now(),
		author: {
			id: dmUser.id,
			bot: false,
			username: "tester",
			globalName: "Tester",
			displayName: "Tester",
			discriminator: "0",
		},
		member: null,
		channel,
		guild: undefined,
		interaction: null,
		reference: undefined,
		embeds: [],
		stickers: { size: 0 },
		attachments: { size: 0 },
		mentions: { users: new Map(), repliedUser: undefined },
	} as unknown as DiscordMessage;
	await new MessageManager(service, runtime).handleMessage(inbound);
	return { sent, suppressed, errors };
}

describe("MessageManager reply de-duplication across scripts", () => {
	it("sends both Korean replies when the second only reuses a number", async () => {
		const first = "오늘 회의는 3시와 5시에 있어요";
		const second = "3시 회의가 취소됐어요";
		const result = await deliverTwoReplies(first, second);
		expect(result.errors).toEqual([]);
		expect(result.suppressed).toEqual([]);
		expect(result.sent).toEqual([first, second]);
	});

	it("sends both Russian replies when the second only reuses a number", async () => {
		const first = "Встреча перенесена на 15 марта";
		const second = "Отчёт нужно сдать до 15 марта";
		const result = await deliverTwoReplies(first, second);
		expect(result.errors).toEqual([]);
		expect(result.suppressed).toEqual([]);
		expect(result.sent).toEqual([first, second]);
	});

	it("still drops a Korean bare-value restatement as a fact-signature repeat", async () => {
		const first = "비트코인 가격은 61,883달러입니다";
		const result = await deliverTwoReplies(first, "61,883달러입니다");
		expect(result.errors).toEqual([]);
		expect(result.suppressed).toEqual(["fact-signature"]);
		expect(result.sent).toEqual([first]);
	});

	it("still drops an English bare-value restatement as a fact-signature repeat", async () => {
		const first = "Bitcoin is currently priced at $61,883 USD";
		const result = await deliverTwoReplies(first, "$61,883 USD");
		expect(result.errors).toEqual([]);
		expect(result.suppressed).toEqual(["fact-signature"]);
		expect(result.sent).toEqual([first]);
	});
});
