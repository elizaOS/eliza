/**
 * Tests for the PLATFORM_CHAT_CONTEXT and PLATFORM_USER_CONTEXT providers —
 * covers connector selection (current-source match vs explicit routing context),
 * per-platform output guidance, omission of recent messages from prompt text,
 * and entity-scoped user resolution. Deterministic: connectors are vi.fn stubs,
 * no live model.
 */
import { describe, expect, it, vi } from "vitest";
import type {
	IAgentRuntime,
	Memory,
	MessageConnector,
	State,
} from "../../../types/index.ts";
import { ChannelType } from "../../../types/index.ts";
import { CONTEXT_ROUTING_METADATA_KEY } from "../../../utils/context-routing.ts";
import {
	platformChatContextProvider,
	platformUserContextProvider,
} from "./platformContext.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const ROOM_ID = "00000000-0000-0000-0000-000000000002";
const ENTITY_ID = "00000000-0000-0000-0000-000000000003";

function makeState(): State {
	return {
		values: {},
		data: {},
		text: "",
	};
}

function makeMessage(source?: string): Memory {
	return {
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		entityId: ENTITY_ID,
		content: {
			text: "hello",
			...(source ? { source } : {}),
		},
	};
}

function makeConnector(
	source: string,
	overrides: Partial<MessageConnector> = {},
): MessageConnector {
	return {
		source,
		label: source,
		capabilities: ["send_message"],
		supportedTargetKinds: ["channel"],
		contexts: ["social", "connectors"],
		...overrides,
	};
}

function makeRuntime(connectors: MessageConnector[]): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		logger: {
			debug: vi.fn(),
		},
		getMessageConnectors: vi.fn(() => connectors),
		getRoom: vi.fn(async () => ({
			id: ROOM_ID,
			type: ChannelType.GROUP,
			source: "slack",
			channelId: "C123",
			serverId: "T123",
			name: "general",
			metadata: { threadTs: "1700000000.000100" },
		})),
	} as IAgentRuntime;
}

describe("platform context providers", () => {
	it("returns no chat context when no message connectors are registered", async () => {
		const result = await platformChatContextProvider.get(
			makeRuntime([]),
			makeMessage("slack"),
			makeState(),
		);

		expect(result.text).toBe("");
		expect(result.data).toMatchObject({
			connectorCount: 0,
			chatContextCount: 0,
		});
	});

	it("uses one relevant connector and passes the current room target", async () => {
		const getChatContext = vi.fn(async (target) => ({
			target,
			label: "#general",
			summary: "team channel",
			recentMessages: [{ name: "Sam", text: "ship it" }],
		}));
		const runtime = makeRuntime([
			makeConnector("slack", {
				getChatContext,
			}),
		]);

		const result = await platformChatContextProvider.get(
			runtime,
			makeMessage("slack"),
			makeState(),
		);

		expect(getChatContext).toHaveBeenCalledOnce();
		expect(getChatContext.mock.calls[0][0]).toMatchObject({
			source: "slack",
			roomId: ROOM_ID,
			entityId: ENTITY_ID,
			channelId: "C123",
			serverId: "T123",
			threadId: "1700000000.000100",
		});
		expect(result.text).toContain('"platform_chat_context":');
		expect(result.text).not.toContain("ship it");
		expect(result.text).not.toContain('"recentMessages"');
		expect(result.data).toMatchObject({
			source: "slack",
			chatContextCount: 1,
			contexts: [
				{
					source: "slack",
					label: "#general",
					summary: "team channel",
					recentMessages: [{ name: "Sam", text: "ship it" }],
				},
			],
		});
	});

	it("includes multiple context-relevant connectors and skips irrelevant connectors", async () => {
		const slackChat = vi.fn(async (target) => ({
			target,
			label: "#general",
		}));
		const discordChat = vi.fn(async (target) => ({
			target,
			label: "#town-square",
		}));
		const walletChat = vi.fn(async (target) => ({
			target,
			label: "wallet",
		}));
		const runtime = makeRuntime([
			makeConnector("slack", { getChatContext: slackChat }),
			makeConnector("discord", { getChatContext: discordChat }),
			makeConnector("wallet-chat", {
				contexts: ["wallet"],
				getChatContext: walletChat,
			}),
		]);
		const message = makeMessage();
		message.content.metadata = {
			[CONTEXT_ROUTING_METADATA_KEY]: { primaryContext: "connectors" },
		};
		const state = makeState();
		state.data.room = {
			id: ROOM_ID,
			type: ChannelType.GROUP,
			source: "",
			channelId: "C999",
		};

		const result = await platformChatContextProvider.get(
			runtime,
			message,
			state,
		);

		expect(slackChat).toHaveBeenCalledOnce();
		expect(discordChat).toHaveBeenCalledOnce();
		expect(walletChat).not.toHaveBeenCalled();
		expect(result.data).toMatchObject({
			chatContextCount: 2,
			relevantConnectorCount: 2,
		});
	});

	it("drops the legacy unscoped connector when an account-scoped sibling shares its source", async () => {
		const legacyChat = vi.fn(async (target) => ({
			target,
			label: "#legacy",
		}));
		const scopedChat = vi.fn(async (target) => ({
			target,
			label: "#scoped",
		}));
		const runtime = makeRuntime([
			makeConnector("slack", { getChatContext: legacyChat }),
			makeConnector("slack", {
				accountId: "acct-1",
				getChatContext: scopedChat,
			}),
		]);

		const result = await platformChatContextProvider.get(
			runtime,
			makeMessage("slack"),
			makeState(),
		);

		expect(legacyChat).not.toHaveBeenCalled();
		expect(scopedChat).toHaveBeenCalledOnce();
		expect(result.data).toMatchObject({
			chatContextCount: 1,
			relevantConnectorCount: 1,
		});
	});

	it("routes context hooks only to the trusted inbound connector account", async () => {
		const legacyChat = vi.fn(async (target) => ({ target, label: "#legacy" }));
		const firstChat = vi.fn(async (target) => ({ target, label: "#first" }));
		const secondChat = vi.fn(async (target) => ({ target, label: "#second" }));
		const firstUser = vi.fn(async (entityId) => ({
			entityId,
			label: "First User",
		}));
		const secondUser = vi.fn(async (entityId) => ({
			entityId,
			label: "Second User",
		}));
		const runtime = makeRuntime([
			makeConnector("discord", { getChatContext: legacyChat }),
			makeConnector("discord", {
				accountId: "acct-1",
				getChatContext: firstChat,
				getUserContext: firstUser,
			}),
			makeConnector("discord", {
				accountId: "acct-2",
				getChatContext: secondChat,
				getUserContext: secondUser,
			}),
		]);
		const message = makeMessage("discord");
		message.metadata = {
			type: "message",
			source: "discord",
			accountId: "acct-2",
		};
		// Content metadata is user-controlled and must not override the trusted
		// account stamped on the Memory envelope.
		message.content.metadata = { accountId: "acct-1" };

		const chatResult = await platformChatContextProvider.get(
			runtime,
			message,
			makeState(),
		);
		const userResult = await platformUserContextProvider.get(
			runtime,
			message,
			makeState(),
		);

		expect(legacyChat).not.toHaveBeenCalled();
		expect(firstChat).not.toHaveBeenCalled();
		expect(firstUser).not.toHaveBeenCalled();
		expect(secondChat).toHaveBeenCalledWith(
			expect.objectContaining({ source: "discord", accountId: "acct-2" }),
			expect.objectContaining({
				source: "discord",
				accountId: "acct-2",
				target: expect.objectContaining({
					source: "discord",
					accountId: "acct-2",
				}),
				metadata: expect.objectContaining({ accountId: "acct-2" }),
			}),
		);
		expect(secondUser).toHaveBeenCalledWith(
			ENTITY_ID,
			expect.objectContaining({
				source: "discord",
				accountId: "acct-2",
				target: expect.objectContaining({ accountId: "acct-2" }),
				metadata: expect.objectContaining({ accountId: "acct-2" }),
			}),
		);
		// Query metadata is copied/rebound; the user payload is left untouched.
		expect(message.content.metadata).toEqual({ accountId: "acct-1" });
		expect(chatResult.data).toMatchObject({
			accountId: "acct-2",
			relevantConnectorCount: 1,
			chatContextCount: 1,
		});
		expect(userResult.data).toMatchObject({
			accountId: "acct-2",
			relevantConnectorCount: 1,
			userContextCount: 1,
		});
	});

	it("passes a trusted account to an explicitly account-dispatching connector", async () => {
		const dispatchingChat = vi.fn(async (target) => ({
			target,
			label: "X direct messages",
		}));
		const runtime = makeRuntime([
			makeConnector("x", {
				accountRouting: "connector",
				getChatContext: dispatchingChat,
			}),
		]);
		const message = makeMessage("untrusted-conflict");
		message.metadata = {
			type: "message",
			source: "x",
			accountId: "secondary",
		};

		const result = await platformChatContextProvider.get(
			runtime,
			message,
			makeState(),
		);

		expect(dispatchingChat).toHaveBeenCalledWith(
			expect.objectContaining({ source: "x", accountId: "secondary" }),
			expect.objectContaining({ source: "x", accountId: "secondary" }),
		);
		expect(result.data).toMatchObject({
			accountId: "secondary",
			relevantConnectorCount: 1,
			chatContextCount: 1,
		});
	});

	it("prefers an exact scoped connector over an account-dispatching fallback", async () => {
		const exactChat = vi.fn(async (target) => ({ target, label: "#exact" }));
		const dispatchingChat = vi.fn(async (target) => ({
			target,
			label: "#dispatcher",
		}));
		const runtime = makeRuntime([
			makeConnector("x", {
				accountRouting: "connector",
				getChatContext: dispatchingChat,
			}),
			makeConnector("x", {
				accountId: "secondary",
				getChatContext: exactChat,
			}),
		]);
		const message = makeMessage();
		message.metadata = {
			type: "message",
			source: "x",
			accountId: "secondary",
		};

		await platformChatContextProvider.get(runtime, message, makeState());

		expect(exactChat).toHaveBeenCalledOnce();
		expect(dispatchingChat).not.toHaveBeenCalled();
	});

	it("fails closed when account-dispatching connector selection is ambiguous", async () => {
		const firstChat = vi.fn(async (target) => ({ target, label: "#first" }));
		const secondChat = vi.fn(async (target) => ({ target, label: "#second" }));
		const runtime = makeRuntime([
			makeConnector("x", {
				accountRouting: "connector",
				getChatContext: firstChat,
			}),
			makeConnector("x", {
				accountRouting: "connector",
				getChatContext: secondChat,
			}),
		]);
		const message = makeMessage();
		message.metadata = {
			type: "message",
			source: "x",
			accountId: "secondary",
		};

		const result = await platformChatContextProvider.get(
			runtime,
			message,
			makeState(),
		);

		expect(firstChat).not.toHaveBeenCalled();
		expect(secondChat).not.toHaveBeenCalled();
		expect(result.data).toMatchObject({ relevantConnectorCount: 0 });
	});

	it("fails closed when a source has multiple scoped accounts but no trusted inbound account", async () => {
		const legacyChat = vi.fn(async (target) => ({ target, label: "#legacy" }));
		const firstChat = vi.fn(async (target) => ({ target, label: "#first" }));
		const secondChat = vi.fn(async (target) => ({ target, label: "#second" }));
		const firstUser = vi.fn(async (entityId) => ({
			entityId,
			label: "First User",
		}));
		const secondUser = vi.fn(async (entityId) => ({
			entityId,
			label: "Second User",
		}));
		const runtime = makeRuntime([
			makeConnector("discord", { getChatContext: legacyChat }),
			makeConnector("discord", {
				accountId: "acct-1",
				getChatContext: firstChat,
				getUserContext: firstUser,
			}),
			makeConnector("discord", {
				accountId: "acct-2",
				getChatContext: secondChat,
				getUserContext: secondUser,
			}),
		]);
		const message = makeMessage("discord");

		const chatResult = await platformChatContextProvider.get(
			runtime,
			message,
			makeState(),
		);
		const userResult = await platformUserContextProvider.get(
			runtime,
			message,
			makeState(),
		);

		expect(legacyChat).not.toHaveBeenCalled();
		expect(firstChat).not.toHaveBeenCalled();
		expect(secondChat).not.toHaveBeenCalled();
		expect(firstUser).not.toHaveBeenCalled();
		expect(secondUser).not.toHaveBeenCalled();
		expect(chatResult.data).toMatchObject({
			relevantConnectorCount: 0,
			chatContextCount: 0,
		});
		expect(userResult.data).toMatchObject({
			relevantConnectorCount: 0,
			userContextCount: 0,
		});
	});

	it("prefers the trusted envelope source over conflicting Content source", async () => {
		const discordChat = vi.fn(async (target) => ({
			target,
			label: "#discord",
		}));
		const slackChat = vi.fn(async (target) => ({ target, label: "#slack" }));
		const runtime = makeRuntime([
			makeConnector("discord", {
				accountId: "default",
				getChatContext: discordChat,
			}),
			makeConnector("slack", {
				accountId: "default",
				getChatContext: slackChat,
			}),
		]);
		const message = makeMessage("slack");
		message.metadata = {
			type: "message",
			source: "discord",
			accountId: "default",
		};

		const result = await platformChatContextProvider.get(
			runtime,
			message,
			makeState(),
		);

		expect(discordChat).toHaveBeenCalledOnce();
		expect(slackChat).not.toHaveBeenCalled();
		expect(discordChat).toHaveBeenCalledWith(
			expect.objectContaining({ source: "discord", accountId: "default" }),
			expect.objectContaining({ source: "discord", accountId: "default" }),
		);
		expect(result.data).toMatchObject({
			source: "discord",
			accountId: "default",
			chatContextCount: 1,
		});
	});

	it("fails closed when an account-bearing Memory has no trusted envelope source", async () => {
		const discordChat = vi.fn(async (target) => ({
			target,
			label: "#discord",
		}));
		const slackChat = vi.fn(async (target) => ({ target, label: "#slack" }));
		const runtime = makeRuntime([
			makeConnector("discord", {
				accountId: "default",
				getChatContext: discordChat,
			}),
			makeConnector("slack", {
				accountId: "default",
				getChatContext: slackChat,
			}),
		]);
		// Neither this Content source nor the room's Slack source may be paired
		// with an account id that came from the trusted Memory envelope.
		const message = makeMessage("discord");
		message.metadata = { type: "message", accountId: "default" };
		message.content.metadata = {
			[CONTEXT_ROUTING_METADATA_KEY]: { primaryContext: "connectors" },
		};

		const result = await platformChatContextProvider.get(
			runtime,
			message,
			makeState(),
		);

		expect(discordChat).not.toHaveBeenCalled();
		expect(slackChat).not.toHaveBeenCalled();
		expect(result.data).toMatchObject({
			connectorCount: 2,
			relevantConnectorCount: 0,
			chatContextCount: 0,
		});
	});

	it("matches trusted account ids exactly after trimming whitespace", async () => {
		const exactChat = vi.fn(async (target) => ({ target, label: "#exact" }));
		const caseFoldedChat = vi.fn(async (target) => ({
			target,
			label: "#wrong",
		}));
		const runtime = makeRuntime([
			makeConnector("discord", {
				accountId: "Acct-2",
				getChatContext: exactChat,
			}),
			makeConnector("discord", {
				accountId: "acct-2",
				getChatContext: caseFoldedChat,
			}),
		]);
		const message = makeMessage("discord");
		message.metadata = {
			type: "message",
			source: "discord",
			accountId: "  Acct-2  ",
		};

		const result = await platformChatContextProvider.get(
			runtime,
			message,
			makeState(),
		);

		expect(exactChat).toHaveBeenCalledOnce();
		expect(caseFoldedChat).not.toHaveBeenCalled();
		expect(result.data).toMatchObject({
			accountId: "Acct-2",
			relevantConnectorCount: 1,
		});
	});

	it("does not treat Content metadata as an account routing constraint", async () => {
		const getChatContext = vi.fn(async (target, context) => ({
			target,
			label: String(context.metadata?.marker),
		}));
		const runtime = makeRuntime([makeConnector("slack", { getChatContext })]);
		const message = makeMessage("slack");
		message.content.metadata = {
			accountId: "user-supplied",
			marker: "preserved",
		};

		const result = await platformChatContextProvider.get(
			runtime,
			message,
			makeState(),
		);

		expect(getChatContext).toHaveBeenCalledWith(
			expect.not.objectContaining({ accountId: expect.anything() }),
			expect.objectContaining({
				metadata: { marker: "preserved" },
			}),
		);
		expect(result.data).toMatchObject({
			relevantConnectorCount: 1,
			chatContextCount: 1,
		});
		expect(message.content.metadata).toEqual({
			accountId: "user-supplied",
			marker: "preserved",
		});
	});

	it("fails closed when the trusted inbound account has no connector", async () => {
		const firstChat = vi.fn(async (target) => ({ target, label: "#first" }));
		const legacyChat = vi.fn(async (target) => ({ target, label: "#legacy" }));
		const runtime = makeRuntime([
			makeConnector("discord", { getChatContext: legacyChat }),
			makeConnector("discord", {
				accountId: "acct-1",
				getChatContext: firstChat,
			}),
		]);
		const message = makeMessage("discord");
		message.metadata = {
			type: "message",
			source: "discord",
			accountId: "acct-missing",
		};

		const result = await platformChatContextProvider.get(
			runtime,
			message,
			makeState(),
		);

		expect(legacyChat).not.toHaveBeenCalled();
		expect(firstChat).not.toHaveBeenCalled();
		expect(result.data).toMatchObject({
			connectorCount: 2,
			relevantConnectorCount: 0,
			chatContextCount: 0,
		});
	});

	it("keeps an unscoped connector whose source has no account-scoped sibling", async () => {
		const slackChat = vi.fn(async (target) => ({
			target,
			label: "#general",
		}));
		const runtime = makeRuntime([
			makeConnector("slack", { getChatContext: slackChat }),
			makeConnector("discord", {
				accountId: "acct-9",
				getChatContext: vi.fn(async (target) => ({ target, label: "#d" })),
			}),
		]);

		const result = await platformChatContextProvider.get(
			runtime,
			makeMessage("slack"),
			makeState(),
		);

		expect(slackChat).toHaveBeenCalledOnce();
		expect(result.data).toMatchObject({ chatContextCount: 1 });
	});

	it("runs chat-context hooks concurrently across connectors", async () => {
		// The first connector's hook only resolves once the second connector's
		// hook has STARTED — serial execution would leave it pending until the
		// race below times it out and drops its context.
		let secondStarted: () => void = () => {};
		const secondStartedPromise = new Promise<void>((resolve) => {
			secondStarted = resolve;
		});
		const firstChat = vi.fn(async (target) => {
			await Promise.race([
				secondStartedPromise,
				new Promise((_resolve, reject) =>
					setTimeout(() => reject(new Error("hooks ran serially")), 1000),
				),
			]);
			return { target, label: "#first" };
		});
		const secondChat = vi.fn(async (target) => {
			secondStarted();
			return { target, label: "#second" };
		});
		const runtime = makeRuntime([
			makeConnector("slack", { getChatContext: firstChat }),
			makeConnector("discord", { getChatContext: secondChat }),
		]);
		const message = makeMessage();
		message.content.metadata = {
			[CONTEXT_ROUTING_METADATA_KEY]: { primaryContext: "connectors" },
		};
		const state = makeState();
		state.data.room = {
			id: ROOM_ID,
			type: ChannelType.GROUP,
			source: "",
			channelId: "C999",
		};

		const result = await platformChatContextProvider.get(
			runtime,
			message,
			state,
		);

		expect(result.data).toMatchObject({ chatContextCount: 2 });
	});

	it("runs user-context hooks concurrently across connectors", async () => {
		let secondStarted: () => void = () => {};
		const secondStartedPromise = new Promise<void>((resolve) => {
			secondStarted = resolve;
		});
		const firstUser = vi.fn(async (entityId) => {
			await Promise.race([
				secondStartedPromise,
				new Promise((_resolve, reject) =>
					setTimeout(() => reject(new Error("hooks ran serially")), 1000),
				),
			]);
			return { entityId, label: "First User" };
		});
		const secondUser = vi.fn(async (entityId) => {
			secondStarted();
			return { entityId, label: "Second User" };
		});
		const runtime = makeRuntime([
			makeConnector("slack", { getUserContext: firstUser }),
			makeConnector("discord", { getUserContext: secondUser }),
		]);
		const message = makeMessage();
		message.content.metadata = {
			[CONTEXT_ROUTING_METADATA_KEY]: { primaryContext: "connectors" },
		};
		const state = makeState();
		state.data.room = {
			id: ROOM_ID,
			type: ChannelType.GROUP,
			source: "",
			channelId: "C999",
		};

		const result = await platformUserContextProvider.get(
			runtime,
			message,
			state,
		);

		expect(result.data).toMatchObject({ userContextCount: 2 });
	});

	it("prefers the current platform source over other connector contexts", async () => {
		const slackChat = vi.fn(async (target) => ({
			target,
			label: "#general",
		}));
		const discordChat = vi.fn(async (target) => ({
			target,
			label: "#town-square",
		}));
		const runtime = makeRuntime([
			makeConnector("slack", { getChatContext: slackChat }),
			makeConnector("discord", { getChatContext: discordChat }),
		]);

		const result = await platformChatContextProvider.get(
			runtime,
			makeMessage("slack"),
			makeState(),
		);

		expect(slackChat).toHaveBeenCalledOnce();
		expect(discordChat).not.toHaveBeenCalled();
		expect(result.data).toMatchObject({
			source: "slack",
			chatContextCount: 1,
			relevantConnectorCount: 1,
		});
	});

	it("includes platform-specific output guidance for Discord", async () => {
		const getChatContext = vi.fn(async (target) => ({
			target,
			label: "#general",
			recentMessages: [{ name: "Sam", text: "show this as a table" }],
		}));
		const runtime = makeRuntime([
			makeConnector("discord", {
				getChatContext,
			}),
		]);

		const result = await platformChatContextProvider.get(
			runtime,
			makeMessage("discord"),
			makeState(),
		);

		expect(result.text).toContain("avoid markdown tables");
		expect(result.text).toContain("wrap each URL in angle brackets");
		expect(result.text).not.toContain("show this as a table");
		expect(result.data).toMatchObject({
			source: "discord",
			outputGuidance: [
				expect.stringContaining("avoid markdown tables"),
				expect.stringContaining("wrap each URL in angle brackets"),
			],
		});
	});

	it("resolves entity-specific user context through the relevant connector", async () => {
		const getUserContext = vi.fn(async (entityId) => ({
			entityId,
			label: "Sam Example",
			aliases: ["sam"],
			handles: { slack: "U123" },
		}));
		const runtime = makeRuntime([
			makeConnector("slack", {
				getUserContext,
			}),
		]);

		const result = await platformUserContextProvider.get(
			runtime,
			makeMessage("slack"),
			makeState(),
		);

		expect(getUserContext).toHaveBeenCalledWith(
			ENTITY_ID,
			expect.objectContaining({
				roomId: ROOM_ID,
				entityId: ENTITY_ID,
				source: "slack",
			}),
		);
		expect(result.text).toContain('"platform_user_context":');
		expect(result.data).toMatchObject({
			source: "slack",
			entityId: ENTITY_ID,
			userContextCount: 1,
			users: [
				{
					source: "slack",
					label: "Sam Example",
					handles: { slack: "U123" },
				},
			],
		});
	});
});
