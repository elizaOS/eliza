/**
 * A Discord draft whose send Discord did not confirm is not posted again on
 * the next confirmation: the adapter looks the channel up first and returns
 * the agent's own posted message as the receipt.
 */
import type {
	Content,
	IAgentRuntime,
	Memory,
	MessageConnectorQueryContext,
	MessageConnectorTarget,
	TargetInfo,
	UUID,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { DiscordTriageAdapter } from "../triage-adapter";

const AGENT_ID = "00000000-0000-0000-0000-00000000a9e7" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000b001" as UUID;
const CHANNEL_ID = "555";

function postedByAgent(
	messageId: string,
	text: string,
	createdAt: number,
): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000777" as UUID,
		entityId: AGENT_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		createdAt,
		content: { text, source: "discord" },
		metadata: {
			type: "message",
			source: "discord",
			discordMessageId: messageId,
			discordChannelId: CHANNEL_ID,
			fromId: "bot-1",
			entityName: "Eliza",
			fromBot: true,
		} as Memory["metadata"],
	};
}

function harness(opts: { posted: boolean; firstError: unknown }) {
	const sends: Array<{ target: TargetInfo; content: Content }> = [];
	let lookups = 0;
	const service = {
		async fetchConnectorMessages(
			_context: MessageConnectorQueryContext,
			_params: { channelId?: string },
		): Promise<Memory[]> {
			lookups += 1;
			return opts.posted
				? [postedByAgent("first-id", "Shipping Friday.", Date.now() + 1)]
				: [];
		},
		async listConnectorRooms(): Promise<MessageConnectorTarget[]> {
			return [{ target: { source: "discord", channelId: CHANNEL_ID } }];
		},
		async handleSendMessage(
			_runtime: IAgentRuntime,
			target: TargetInfo,
			content: Content,
		): Promise<Memory> {
			sends.push({ target, content });
			if (sends.length === 1) throw opts.firstError;
			return postedByAgent("second-id", "Shipping Friday.", Date.now());
		},
		getClient() {
			return { isReady: () => true };
		},
	};
	const runtime = {
		agentId: AGENT_ID,
		getService: (name: string) => (name === "discord" ? service : null),
		reportError: () => undefined,
	} as unknown as IAgentRuntime;
	return {
		adapter: new DiscordTriageAdapter(),
		runtime,
		sends,
		lookups: () => lookups,
	};
}

async function confirmTwice(opts: { posted: boolean; firstError: unknown }) {
	const { adapter, runtime, sends, lookups } = harness(opts);
	const { draftId } = await adapter.createDraft(runtime, {
		source: "discord",
		to: [],
		body: "Shipping Friday.",
		channelId: CHANNEL_ID,
	});
	const first = await adapter.sendDraft(runtime, draftId).then(
		() => "sent",
		(error: unknown) =>
			(error as { code?: unknown }).code === "DISCORD_SEND_OUTCOME_UNKNOWN"
				? "outcome-unknown"
				: "refused",
	);
	const second = await adapter.sendDraft(runtime, draftId);
	return {
		first,
		second: second.externalId,
		sends: sends.length,
		lookups: lookups(),
	};
}

const socketReset = Object.assign(new Error("socket hang up"), {
	code: "ECONNRESET",
});

it("returns the posted message instead of posting again", async () => {
	expect(await confirmTwice({ posted: true, firstError: socketReset })).toEqual(
		{
			first: "outcome-unknown",
			second: "first-id",
			sends: 1,
			lookups: 1,
		},
	);
});

it("posts once more when the channel has no such message", async () => {
	expect(
		await confirmTwice({ posted: false, firstError: socketReset }),
	).toEqual({
		first: "outcome-unknown",
		second: "second-id",
		sends: 2,
		lookups: 1,
	});
});

it("reports a refusal as before and lets the owner post again", async () => {
	const forbidden = Object.assign(new Error("Missing Access"), {
		status: 403,
		code: 50001,
	});
	expect(await confirmTwice({ posted: true, firstError: forbidden })).toEqual({
		first: "refused",
		second: "second-id",
		sends: 2,
		lookups: 0,
	});
});
