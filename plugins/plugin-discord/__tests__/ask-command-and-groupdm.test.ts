/**
 * The `/ask` command routes free text through the real message service and
 * returns the agent's reply, and `transformCommandToDiscordApi` opts commands
 * into group-DM / user-install availability only when asked. Deterministic —
 * the interaction, runtime, and message service are in-memory doubles; no
 * Discord gateway or live model.
 */
import type { Content, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { transformCommandToDiscordApi } from "../discord-commands";
import { getRegisteredCommands } from "../slash-commands";
import type { DiscordSlashCommand } from "../types";

function command(
	name: string,
	extra: Partial<DiscordSlashCommand> = {},
): DiscordSlashCommand {
	return {
		name,
		description: `${name} command`,
		...extra,
	} as DiscordSlashCommand;
}

describe("transformCommandToDiscordApi group-DM opt-in", () => {
	it("leaves a global command context-free by default (guild + bot DM only)", () => {
		const out = transformCommandToDiscordApi(command("ask")) as {
			contexts?: number[];
			integrationTypes?: number[];
		};
		expect(out.contexts).toBeUndefined();
		expect(out.integrationTypes).toBeUndefined();
	});

	it("opens a global command to all contexts + install types when userInstall is on", () => {
		const out = transformCommandToDiscordApi(command("ask"), {
			userInstall: true,
		}) as { contexts?: number[]; integrationTypes?: number[] };
		// 0 guild, 1 bot DM, 2 private channel (group DMs).
		expect(out.contexts).toEqual([0, 1, 2]);
		// 0 guild install, 1 user install.
		expect(out.integrationTypes).toEqual([0, 1]);
	});

	it("keeps a guild-only command pinned to the guild context even with userInstall", () => {
		const out = transformCommandToDiscordApi(
			command("mod", { guildOnly: true }),
			{ userInstall: true },
		) as { contexts?: number[]; integrationTypes?: number[] };
		expect(out.contexts).toEqual([0]);
		expect(out.integrationTypes).toBeUndefined();
	});

	it("respects an explicit contexts array over the userInstall default", () => {
		const out = transformCommandToDiscordApi(
			command("dmonly", { contexts: [1] }),
			{ userInstall: true },
		) as { contexts?: number[] };
		expect(out.contexts).toEqual([1]);
	});

	it("omits global-only context fields for guild-scoped registration", () => {
		const out = transformCommandToDiscordApi(command("targeted"), {
			userInstall: true,
			guildScoped: true,
		}) as { contexts?: number[]; integrationTypes?: number[] };
		expect(out.contexts).toBeUndefined();
		expect(out.integrationTypes).toBeUndefined();
	});
});

describe("/ask command", () => {
	function makeInteraction(text: string, opts: { inGuild?: boolean } = {}) {
		const followUps: string[] = [];
		let editedReply: string | undefined;
		let deferred = false;
		let directReply: string | undefined;
		return {
			followUps,
			get editedReply() {
				return editedReply;
			},
			get deferred() {
				return deferred;
			},
			get directReply() {
				return directReply;
			},
			interaction: {
				id: "interaction-1",
				channelId: "channel-1",
				guildId: opts.inGuild ? "guild-1" : null,
				guild: opts.inGuild ? { name: "Guild One" } : null,
				user: {
					id: "user-1",
					username: "asker",
					displayName: "Asker",
					createDM: vi.fn(),
				},
				inGuild: () => Boolean(opts.inGuild),
				options: { getString: (_n: string, _r?: boolean) => text },
				reply: async (arg: { content: string }) => {
					directReply = arg.content;
				},
				deferReply: async () => {
					deferred = true;
				},
				editReply: async (content: string) => {
					editedReply = content;
				},
				followUp: async (content: string) => {
					followUps.push(content);
				},
			},
		};
	}

	function makeRuntime(
		handle: (
			runtime: IAgentRuntime,
			message: Memory,
			cb: (r: Content) => Promise<unknown>,
		) => Promise<unknown>,
		dmPolicy = "open",
	): IAgentRuntime {
		return {
			agentId: "00000000-0000-0000-0000-0000000000aa",
			character: { settings: { discord: { dmPolicy } } },
			getSetting: vi.fn(() => undefined),
			ensureConnection: vi.fn(async () => undefined),
			messageService: { handleMessage: handle },
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		} as unknown as IAgentRuntime;
	}

	async function runAsk(text: string, opts: { inGuild?: boolean } = {}) {
		const ask = getRegisteredCommands().get("ask");
		if (!ask) throw new Error("ask command not registered");
		const h = makeInteraction(text, opts);
		let seenMessage: Memory | undefined;
		const runtime = makeRuntime(async (_rt, message, cb) => {
			seenMessage = message;
			await cb({ text: "The answer is 42.", source: "agent" } as Content);
			return {};
		});
		await ask.execute(h.interaction as never, runtime as never);
		return { h, runtime, seenMessage };
	}

	it("is registered as a built-in", () => {
		expect(getRegisteredCommands().has("ask")).toBe(true);
	});

	it("routes the text to the message service and edits in the reply", async () => {
		const { h, seenMessage } = await runAsk("what is 6 times 7?");
		expect(h.deferred).toBe(true);
		expect(seenMessage?.content?.text).toBe("what is 6 times 7?");
		expect(h.editedReply).toBe("The answer is 42.");
	});

	it("uses DM channel type outside a guild (the group-DM / DM path)", async () => {
		const { seenMessage } = await runAsk("hi", { inGuild: false });
		// ChannelType.DM — the interaction-only path a group DM travels.
		expect(seenMessage?.content?.channelType).toBe("DM");
	});

	it("refuses a DM interaction when the connector DM policy is disabled", async () => {
		const ask = getRegisteredCommands().get("ask");
		const h = makeInteraction("bypass the policy");
		const handle = vi.fn();
		const runtime = makeRuntime(handle, "disabled");

		await ask?.execute(h.interaction as never, runtime as never);

		expect(handle).not.toHaveBeenCalled();
		expect(runtime.ensureConnection).not.toHaveBeenCalled();
		expect(h.directReply).toContain("not available");
	});

	it("rejects an empty message without touching the runtime", async () => {
		const ask = getRegisteredCommands().get("ask");
		const h = makeInteraction("   ");
		const handle = vi.fn();
		const runtime = makeRuntime(handle);
		await ask?.execute(h.interaction as never, runtime as never);
		expect(handle).not.toHaveBeenCalled();
		expect(h.directReply).toContain("can't be empty");
	});

	it("degrades cleanly when the message service is unavailable", async () => {
		const ask = getRegisteredCommands().get("ask");
		const h = makeInteraction("hello");
		const runtime = {
			agentId: "00000000-0000-0000-0000-0000000000aa",
			character: { settings: { discord: { dmPolicy: "open" } } },
			getSetting: vi.fn(() => undefined),
			messageService: null,
			logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
		} as unknown as IAgentRuntime;
		await ask?.execute(h.interaction as never, runtime as never);
		expect(h.directReply).toContain("isn't ready");
	});

	it("uses GROUP channel type in-guild, matching getChannelType's GuildText->GROUP mapping", async () => {
		const { seenMessage, runtime } = await runAsk("what's up", {
			inGuild: true,
		});
		expect(seenMessage?.content?.channelType).toBe("GROUP");
		expect(runtime.ensureConnection).toHaveBeenCalledWith(
			expect.objectContaining({ type: "GROUP", worldName: "Guild One" }),
		);
	});

	it("tells the user nothing came back when the agent produces no reply text", async () => {
		const ask = getRegisteredCommands().get("ask");
		const h = makeInteraction("say nothing");
		const runtime = makeRuntime(async (_rt, _m, cb) => {
			await cb({ text: "   ", source: "agent" } as Content);
			return {};
		});
		await ask?.execute(h.interaction as never, runtime as never);
		expect(h.editedReply).toBe(
			"I processed that but didn't have anything to say back.",
		);
	});

	it("splits a long answer across editReply + followUps", async () => {
		const ask = getRegisteredCommands().get("ask");
		const h = makeInteraction("give me a long answer");
		const long = "x".repeat(4500);
		const runtime = makeRuntime(async (_rt, _m, cb) => {
			await cb({ text: long, source: "agent" } as Content);
			return {};
		});
		await ask?.execute(h.interaction as never, runtime as never);
		expect((h.editedReply ?? "").length).toBeLessThanOrEqual(2000);
		expect(h.followUps.length).toBeGreaterThanOrEqual(1);
	});
});
