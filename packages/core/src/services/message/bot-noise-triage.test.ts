/**
 * Small-model triage for unaddressed bot/webhook traffic.
 *
 * Contract under test: a relay channel flooding automated webhook embeds must
 * NOT reach the expensive Stage 1 RESPONSE_HANDLER call — the RESPOND/IGNORE
 * verdict for positively bot-authored, unaddressed group messages is made by
 * the cheap TEXT_SMALL tier. Everything ambiguous (humans, addressed turns,
 * private channels, sub-agent relays, model failures, unparseable verdicts)
 * fails OPEN into the normal pipeline.
 */

import { describe, expect, it, vi } from "vitest";
import type { Memory } from "../../types/memory";
import { ModelType } from "../../types/model";
import { ChannelType, type UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import {
	buildBotNoiseTriagePrompt,
	isBotNoiseTriageEnabled,
	isTriagableBotNoiseMessage,
	runBotNoiseTriage,
} from "./bot-noise-triage";

const AGENT_ID = "00000000-0000-0000-0000-00000000000a" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000000b" as UUID;
const SENDER_ID = "00000000-0000-0000-0000-00000000000c" as UUID;

/** A ZenithProxy-style relay embed: webhook-authored, unaddressed, GROUP. */
function relayEmbedMessage(overrides: Partial<Memory> = {}): Memory {
	return {
		id: "00000000-0000-0000-0000-00000000000d" as UUID,
		entityId: SENDER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: {
			text: "3fingersBTW | ZenithProxy:\n\nEmbed #1:\n  Title:Started Queuing\n  Description:(none)",
			source: "discord",
			channelType: ChannelType.GROUP,
		},
		metadata: {
			type: "message",
			fromBot: true,
			entityName: "ZenithProxy",
			entityUserName: "ZenithProxy#0000",
		} as Memory["metadata"],
		createdAt: 1,
		...overrides,
	};
}

function makeRuntime(args: {
	modelResult?: unknown;
	modelError?: Error;
	settings?: Record<string, string>;
	memories?: Memory[];
	memoriesError?: Error;
}): IAgentRuntime & { useModel: ReturnType<typeof vi.fn> } {
	const useModel = vi.fn(async () => {
		if (args.modelError) throw args.modelError;
		return args.modelResult ?? "IGNORE";
	});
	const getMemories = vi.fn(async () => {
		if (args.memoriesError) throw args.memoriesError;
		return args.memories ?? [];
	});
	return {
		agentId: AGENT_ID,
		character: { name: "Remilio" },
		getSetting: (key: string) => args.settings?.[key],
		useModel,
		getMemories,
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
	} as unknown as IAgentRuntime & { useModel: ReturnType<typeof vi.fn> };
}

describe("isTriagableBotNoiseMessage — deterministic preconditions", () => {
	it("accepts an unaddressed webhook embed in a GROUP channel", () => {
		expect(isTriagableBotNoiseMessage(relayEmbedMessage(), false)).toBe(true);
	});

	it("rejects addressed messages (mention/reply/name)", () => {
		expect(isTriagableBotNoiseMessage(relayEmbedMessage(), true)).toBe(false);
	});

	it("rejects human-authored messages (no fromBot)", () => {
		const message = relayEmbedMessage({
			metadata: { type: "message" } as Memory["metadata"],
		});
		expect(isTriagableBotNoiseMessage(message, false)).toBe(false);
	});

	it("accepts fromBot stamped on content.metadata (alternate connector shape)", () => {
		const base = relayEmbedMessage({
			metadata: { type: "message" } as Memory["metadata"],
		});
		const message: Memory = {
			...base,
			content: { ...base.content, metadata: { fromBot: true } },
		};
		expect(isTriagableBotNoiseMessage(message, false)).toBe(true);
	});

	it("rejects private channels (DM) and unknown/missing channel types", () => {
		const dm = relayEmbedMessage();
		dm.content = { ...dm.content, channelType: ChannelType.DM };
		expect(isTriagableBotNoiseMessage(dm, false)).toBe(false);

		const missing = relayEmbedMessage();
		missing.content = { ...missing.content, channelType: undefined };
		expect(isTriagableBotNoiseMessage(missing, false)).toBe(false);
	});

	it("rejects voice group rooms (own turn-taking pipeline)", () => {
		const voice = relayEmbedMessage();
		voice.content = { ...voice.content, channelType: ChannelType.VOICE_GROUP };
		expect(isTriagableBotNoiseMessage(voice, false)).toBe(false);
	});

	it("rejects sub-agent completion relays (source and metadata shapes)", () => {
		const bySource = relayEmbedMessage();
		bySource.content = { ...bySource.content, source: "sub_agent" };
		expect(isTriagableBotNoiseMessage(bySource, false)).toBe(false);

		const byMetadata = relayEmbedMessage({
			metadata: {
				type: "message",
				fromBot: true,
				subAgent: true,
			} as Memory["metadata"],
		});
		expect(isTriagableBotNoiseMessage(byMetadata, false)).toBe(false);
	});

	it("rejects autonomous turns and always-respond sources", () => {
		const autonomous = relayEmbedMessage();
		autonomous.content = {
			...autonomous.content,
			metadata: { isAutonomous: true },
		};
		expect(isTriagableBotNoiseMessage(autonomous, false)).toBe(false);

		const clientChat = relayEmbedMessage();
		clientChat.content = { ...clientChat.content, source: "client_chat" };
		expect(isTriagableBotNoiseMessage(clientChat, false)).toBe(false);
	});
});

describe("isBotNoiseTriageEnabled", () => {
	it("defaults ON and honors the opt-out", () => {
		expect(isBotNoiseTriageEnabled(makeRuntime({}))).toBe(true);
		for (const value of ["0", "false", "off", "no"]) {
			expect(
				isBotNoiseTriageEnabled(
					makeRuntime({ settings: { ELIZA_BOT_NOISE_TRIAGE: value } }),
				),
			).toBe(false);
		}
		expect(
			isBotNoiseTriageEnabled(
				makeRuntime({ settings: { ELIZA_BOT_NOISE_TRIAGE: "1" } }),
			),
		).toBe(true);
	});
});

describe("runBotNoiseTriage — cheap-tier verdict", () => {
	it("IGNORE verdict ends the turn via TEXT_SMALL, never RESPONSE_HANDLER", async () => {
		const runtime = makeRuntime({ modelResult: "IGNORE" });
		const result = await runBotNoiseTriage({
			runtime,
			message: relayEmbedMessage(),
			explicitlyAddressesAgent: false,
		});
		expect(result).toEqual({ applied: true, respond: false });
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		const [modelType, params] = runtime.useModel.mock.calls[0] as [
			string,
			{ prompt: string },
		];
		expect(modelType).toBe(ModelType.TEXT_SMALL);
		expect(modelType).not.toBe(ModelType.RESPONSE_HANDLER);
		expect(params.prompt).toContain("ZenithProxy");
		expect(params.prompt).toContain("Remilio");
		expect(params.prompt).toContain("RESPOND or IGNORE");
	});

	it("RESPOND verdict falls through to the full pipeline", async () => {
		const runtime = makeRuntime({ modelResult: "RESPOND" });
		const result = await runBotNoiseTriage({
			runtime,
			message: relayEmbedMessage(),
			explicitlyAddressesAgent: false,
		});
		expect(result).toEqual({ applied: true, respond: true });
	});

	it("accepts GenerateTextResult-shaped model output", async () => {
		const runtime = makeRuntime({ modelResult: { text: "ignore" } });
		const result = await runBotNoiseTriage({
			runtime,
			message: relayEmbedMessage(),
			explicitlyAddressesAgent: false,
		});
		expect(result).toEqual({ applied: true, respond: false });
	});

	it("parses IGNORE from a reasoning model that names both verdicts inside <think>", async () => {
		// A REASONING-tier TEXT_SMALL provider (e.g. Cerebras gpt-oss) deliberates
		// out loud before the one-word answer. The reasoning block mentions both
		// RESPOND and IGNORE; only the post-think verdict counts. Without stripping
		// the block the regex sees both words and fails open — the silent no-op.
		const runtime = makeRuntime({
			modelResult:
				"<think>The bot embed is a status feed and does not address Remilio. " +
				"I could RESPOND, but automated updates like this should IGNORE. " +
				"Final answer below.</think>\nIGNORE",
		});
		const result = await runBotNoiseTriage({
			runtime,
			message: relayEmbedMessage(),
			explicitlyAddressesAgent: false,
		});
		expect(result).toEqual({ applied: true, respond: false });
	});

	it("extracts the verdict from a content-array GenerateTextResult with no flat text", async () => {
		// Reasoning-tier providers surface structured output: the flat `.text` is
		// empty and the real assistant text lives in the `content` parts array.
		// getV5ModelText must recover it; the ad-hoc `.text` read saw "" (fail open).
		const runtime = makeRuntime({
			modelResult: {
				text: "",
				content: [
					{ type: "reasoning", text: "weighing RESPOND vs IGNORE" },
					{ type: "text", text: "IGNORE" },
				],
			},
		});
		const result = await runBotNoiseTriage({
			runtime,
			message: relayEmbedMessage(),
			explicitlyAddressesAgent: false,
		});
		expect(result).toEqual({ applied: true, respond: false });
	});

	it("fails open on an unparseable verdict", async () => {
		for (const garbage of ["", "maybe?", "RESPOND IGNORE"]) {
			const runtime = makeRuntime({ modelResult: garbage });
			const result = await runBotNoiseTriage({
				runtime,
				message: relayEmbedMessage(),
				explicitlyAddressesAgent: false,
			});
			expect(result).toEqual({ applied: false });
		}
	});

	it("fails open when the TEXT_SMALL call throws (missing handler / provider down)", async () => {
		const runtime = makeRuntime({
			modelError: new Error("No handler found for delegate type: TEXT_SMALL"),
		});
		const result = await runBotNoiseTriage({
			runtime,
			message: relayEmbedMessage(),
			explicitlyAddressesAgent: false,
		});
		expect(result).toEqual({ applied: false });
	});

	it("still triages when the history fetch fails", async () => {
		const runtime = makeRuntime({
			modelResult: "IGNORE",
			memoriesError: new Error("db down"),
		});
		const result = await runBotNoiseTriage({
			runtime,
			message: relayEmbedMessage(),
			explicitlyAddressesAgent: false,
		});
		expect(result).toEqual({ applied: true, respond: false });
	});

	it("never calls the model for non-triagable messages", async () => {
		const runtime = makeRuntime({});
		const result = await runBotNoiseTriage({
			runtime,
			message: relayEmbedMessage(),
			explicitlyAddressesAgent: true,
		});
		expect(result).toEqual({ applied: false });
		expect(runtime.useModel).not.toHaveBeenCalled();
	});

	it("never calls the model when disabled", async () => {
		const runtime = makeRuntime({
			settings: { ELIZA_BOT_NOISE_TRIAGE: "0" },
		});
		const result = await runBotNoiseTriage({
			runtime,
			message: relayEmbedMessage(),
			explicitlyAddressesAgent: false,
		});
		expect(result).toEqual({ applied: false });
		expect(runtime.useModel).not.toHaveBeenCalled();
	});

	it("includes recent room history in the prompt, oldest first, excluding the current message", async () => {
		const older = relayEmbedMessage({
			id: "00000000-0000-0000-0000-000000000021" as UUID,
			createdAt: 10,
		});
		older.content = { ...older.content, text: "earlier queue update" };
		const agentMsg = relayEmbedMessage({
			id: "00000000-0000-0000-0000-000000000022" as UUID,
			entityId: AGENT_ID,
			createdAt: 20,
		});
		agentMsg.content = { ...agentMsg.content, text: "on it" };
		const current = relayEmbedMessage();
		const runtime = makeRuntime({
			modelResult: "IGNORE",
			memories: [agentMsg, older, current],
		});
		await runBotNoiseTriage({
			runtime,
			message: current,
			explicitlyAddressesAgent: false,
		});
		const [, params] = runtime.useModel.mock.calls[0] as [
			string,
			{ prompt: string },
		];
		const earlierIdx = params.prompt.indexOf("earlier queue update");
		const agentIdx = params.prompt.indexOf("Remilio: on it");
		expect(earlierIdx).toBeGreaterThan(-1);
		expect(agentIdx).toBeGreaterThan(earlierIdx);
	});
});

describe("buildBotNoiseTriagePrompt", () => {
	it("clips oversized embed bodies so triage stays cheap", () => {
		const prompt = buildBotNoiseTriagePrompt({
			agentName: "Remilio",
			senderName: "ZenithProxy",
			messageText: "x".repeat(10_000),
			historyLines: [],
		});
		expect(prompt.length).toBeLessThan(2_500);
		expect(prompt).toContain("…");
	});
});
