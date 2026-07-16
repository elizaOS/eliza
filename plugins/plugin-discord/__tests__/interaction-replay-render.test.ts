/**
 * Regression guard for #14527: the Discord button-tap replay path must render a
 * follow-up reply's link-out blocks (task cards, navigate chips) as native
 * components, exactly like the message-manager reply path. Before the fix the
 * replay callback rendered without the app-origin resolver, so a `[TASK:…]`
 * reply produced after a choice tap silently lost its "Open task" button.
 *
 * Also guards the group-DM delivery fix: a user-installed app is not a channel
 * member in a group DM / DM-with-others, so `channel.send` is unavailable and
 * the button reply must ride the interaction token via `followUp`. The reply is
 * delivered through `followUp` on every surface, falling back to `channel.send`
 * only if the interaction delivery fails.
 *
 * Drives the REAL `handleInteractionCreate` codec-button branch with a fake
 * discord.js interaction + a fake message service whose handler replies with a
 * task card. Only the discord.js SDK objects are stubbed — no bot token, no
 * network.
 */
import { encodeReplyCallback } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleInteractionCreate } from "../discord-interactions";

const TASK_ID = "abc12345def67890abcdef1234567890";
const noop = () => {};

interface CapturedSend {
	content?: string;
	components?: Array<{ toJSON(): { type: number; components: unknown[] } }>;
}

function makeService(
	appUrl: string | undefined,
	options: { channelSendable?: boolean } = {},
) {
	const sends: CapturedSend[] = [];
	const channel = options.channelSendable
		? {
				id: "chan-1",
				send: vi.fn(async (opts: CapturedSend) => {
					sends.push(opts);
					return { id: `sent-${sends.length}` };
				}),
			}
		: // Group DM: the user-installed bot is not a member, so there is no
			// usable `channel.send`.
			{ id: "chan-1" };
	// The fake message service replays the tapped choice value back into the
	// agent loop and, like a real turn, answers with a task-card reply.
	const messageService = {
		handleMessage: vi.fn(
			async (
				_runtime: unknown,
				_memory: unknown,
				callback: (content: {
					text: string;
					source: string;
				}) => Promise<unknown[]>,
			) => {
				await callback({
					text: `Opening your task.\n[TASK:${TASK_ID}]Ship the release[/TASK]`,
					source: "discord",
				});
			},
		),
	};
	const service = {
		accountId: "test",
		client: { user: { id: "bot-1" }, users: { fetch: vi.fn() } },
		character: {},
		slashCommands: [],
		timeouts: [],
		userSelections: new Map(),
		resolveDiscordEntityId: vi.fn(() => "00000000-0000-0000-0000-000000000001"),
		getChannelType: vi.fn(),
		runtime: {
			agentId: "00000000-0000-0000-0000-0000000000aa",
			messageService,
			getSetting: (key: string): string | undefined =>
				key === "ELIZA_APP_URL" ? appUrl : undefined,
			ensureConnection: vi.fn(async () => {}),
			logger: { info: noop, warn: noop, debug: noop, error: noop },
		},
	};
	return { service, channel, sends, messageService };
}

function makeCodecButtonInteraction(channel: unknown, follows: CapturedSend[]) {
	const codecId = encodeReplyCallback("yes", { maxBytes: 100 });
	if (!codecId) throw new Error("codec id should encode");
	return {
		id: "interaction-1",
		type: 3,
		componentType: 2,
		user: {
			id: "user-1",
			username: "alice",
			displayName: "Alice",
			bot: false,
		},
		guild: null,
		channel,
		message: { id: "msg-1" },
		customId: codecId,
		isCommand: () => false,
		isModalSubmit: () => false,
		isMessageComponent: () => true,
		isStringSelectMenu: () => false,
		isButton: () => true,
		replied: false,
		deferred: false,
		deferUpdate: vi.fn(async () => {}),
		// The interaction token delivery path — works in servers, group DMs, and
		// DMs-with-others alike.
		followUp: vi.fn(async (opts: CapturedSend) => {
			follows.push(opts);
			return { id: `follow-${follows.length}` };
		}),
	};
}

describe("#14527 button-tap replay renders link-out blocks natively", () => {
	it("attaches an Open task link button to a post-tap task reply", async () => {
		const { service, channel } = makeService("https://app.test", {
			channelSendable: true,
		});
		const follows: CapturedSend[] = [];
		const interaction = makeCodecButtonInteraction(channel, follows);

		await handleInteractionCreate(service as never, interaction as never);

		// Delivered through the interaction token, not channel.send.
		expect(interaction.followUp).toHaveBeenCalledTimes(1);
		const built = follows[0]?.components;
		expect(built).toBeDefined();
		expect(built).toHaveLength(1);
		const row = built?.[0].toJSON();
		expect(row?.type).toBe(1);
		const button = (
			row?.components as Array<{ style: number; url?: string }>
		)[0];
		// Style 5 = Link; the URL is the resolved orchestrator task view.
		expect(button.style).toBe(5);
		expect(button.url).toBe(`https://app.test/orchestrator?taskId=${TASK_ID}`);
		// Prose keeps the title; the raw marker is stripped.
		expect(follows[0]?.content).toContain("Opening your task.");
		expect(follows[0]?.content).not.toContain("[TASK:");
	});

	it("degrades the same reply to prose when no app origin is configured", async () => {
		const { service, channel } = makeService(undefined, {
			channelSendable: true,
		});
		const follows: CapturedSend[] = [];
		const interaction = makeCodecButtonInteraction(channel, follows);

		await handleInteractionCreate(service as never, interaction as never);

		expect(interaction.followUp).toHaveBeenCalledTimes(1);
		// No resolver URL: no fabricated dead button, and the title survives as prose.
		expect(follows[0]?.components ?? []).toHaveLength(0);
		expect(follows[0]?.content).toContain("Ship the release");
	});

	it("delivers via followUp in a group DM where channel.send is unavailable", async () => {
		// The live 2026-07-16 bug: a group-DM button tap ran the turn but the
		// reply used channel.send (the bot is not a member) and vanished.
		const { service, channel } = makeService("https://app.test", {
			channelSendable: false,
		});
		const follows: CapturedSend[] = [];
		const interaction = makeCodecButtonInteraction(channel, follows);

		await handleInteractionCreate(service as never, interaction as never);

		expect(interaction.followUp).toHaveBeenCalledTimes(1);
		expect(follows[0]?.content).toContain("Opening your task.");
		expect(follows[0]?.components).toHaveLength(1);
		// No channel.send exists on the group-DM channel; delivery still landed.
		expect(
			(channel as { send?: unknown }).send,
			"a group-DM channel has no send method",
		).toBeUndefined();
	});
});
