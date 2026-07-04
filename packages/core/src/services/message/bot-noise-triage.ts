/**
 * Small-model triage for unaddressed bot/webhook traffic.
 *
 * Every inbound message normally runs the full Stage 1 RESPONSE_HANDLER call —
 * the most expensive model in the stack. That is correct for human/addressed
 * turns (Stage 1 produces the reply), but a relay channel flooding automated
 * webhook embeds (status feeds, queue updates, bot-to-bot chatter) burns a
 * full composeState + RESPONSE_HANDLER call per message just to conclude
 * IGNORE. On subscription-backed RESPONSE_HANDLER providers (plugin-cli-
 * inference claude-sdk/codex-sdk) ~1000 such IGNOREs/day drain the daily
 * session budget and take the whole agent down at the provider's reset window.
 *
 * This gate runs BEFORE state composition, only for messages that are
 * positively bot/webhook-authored (`fromBot` connector metadata) AND not
 * addressed to the agent (no platform mention/reply, agent not named in the
 * text). It asks the cheap TEXT_SMALL tier for a one-word RESPOND/IGNORE
 * verdict; IGNORE ends the turn with zero large-tier calls. Everything
 * ambiguous fails OPEN into the normal pipeline: private channels, sub-agent
 * completion relays, autonomous turns, missing channel metadata, a missing
 * TEXT_SMALL handler, model errors, and unparseable verdicts all fall through
 * to the full Stage 1 path, so behavior for addressed/owner/human traffic is
 * unchanged.
 */

import type { Memory } from "../../types/memory";
import {
	MESSAGE_SOURCE_CLIENT_CHAT,
	MESSAGE_SOURCE_SUB_AGENT,
} from "../../types/message-source";
import {
	type GenerateTextParams,
	type GenerateTextResult,
	ModelType,
} from "../../types/model";
import { ChannelType } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import { stripReasoningBlocks } from "./fallback-reply";
import { getV5ModelText } from "./generate-text-result";

/**
 * Text group-ish channel types the gate applies to. Private channels
 * (DM/VOICE_DM/SELF/API) always respond and never reach the gate; voice group
 * rooms have their own turn-taking pipeline and are deliberately excluded.
 */
const TRIAGE_CHANNEL_TYPES: ReadonlySet<string> = new Set([
	String(ChannelType.GROUP),
	String(ChannelType.THREAD),
	String(ChannelType.WORLD),
	String(ChannelType.FORUM),
	String(ChannelType.FEED),
]);

/** Sub-agent completion relays are routed by their own evaluator — never gate. */
const SUB_AGENT_SOURCE = MESSAGE_SOURCE_SUB_AGENT;

/** Sources that bypass should-respond entirely (mirrors the deterministic gate). */
const ALWAYS_RESPOND_SOURCES: readonly string[] = [MESSAGE_SOURCE_CLIENT_CHAT];

const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_LINE_CHARS = 160;
const MAX_CURRENT_TEXT_CHARS = 1200;

export interface BotNoiseTriageArgs {
	runtime: IAgentRuntime;
	message: Memory;
	/** Platform mention/reply or agent named in text (computed by the caller). */
	explicitlyAddressesAgent: boolean;
}

export type BotNoiseTriageResult =
	/** Gate did not apply (or failed open) — run the full pipeline. */
	| { applied: false }
	/** Small-model verdict. `respond: false` ends the turn before Stage 1. */
	| { applied: true; respond: boolean };

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * The gate is ON by default; opt out with ELIZA_BOT_NOISE_TRIAGE=0|false|off.
 */
export function isBotNoiseTriageEnabled(runtime: IAgentRuntime): boolean {
	const raw = runtime.getSetting("ELIZA_BOT_NOISE_TRIAGE");
	if (raw === undefined || raw === null) return true;
	const normalized = String(raw).trim().toLowerCase();
	return !["0", "false", "no", "off"].includes(normalized);
}

/**
 * Deterministic preconditions: only positively-identified, unaddressed
 * bot/webhook group traffic is triagable. Anything the checks cannot confirm
 * falls through to the full pipeline (fail-open).
 */
export function isTriagableBotNoiseMessage(
	message: Memory,
	explicitlyAddressesAgent: boolean,
): boolean {
	if (explicitlyAddressesAgent) return false;

	const contentMetadata = metadataRecord(message.content?.metadata);
	const topLevelMetadata = metadataRecord(message.metadata);

	// Positively bot/webhook-authored only (connector-stamped `fromBot`).
	// NOTE: `fromBot` here is a COST proxy, not behavioral special-handling. This
	// gate never suppresses a response — it only ROUTES high-volume automated
	// relay traffic (the ~1000 IGNOREs/day webhook floods of #11944) to the cheap
	// TEXT_SMALL tier, and fails OPEN on every uncertain path. The precondition
	// SCOPES that cost route to where the volume problem actually is; dropping it
	// to gate on addressing alone would widen triage to all unaddressed human
	// group chatter — a strictly worse cost/quality trade #11944 does not justify.
	// So a future "handle all messages uniformly" pass must NOT uniformize this
	// away: behavior (respond vs not) still branches only on the model verdict +
	// addressing, never on bot-ness.
	const fromBot =
		contentMetadata?.fromBot === true || topLevelMetadata?.fromBot === true;
	if (!fromBot) return false;

	// Autonomous self-turns are not inbound noise.
	if (
		contentMetadata?.isAutonomous === true ||
		topLevelMetadata?.isAutonomous === true
	) {
		return false;
	}

	// Sub-agent completion relays carry their own routing evaluator.
	const source =
		typeof message.content?.source === "string"
			? message.content.source.trim().toLowerCase()
			: "";
	if (source === SUB_AGENT_SOURCE) return false;
	if (
		contentMetadata?.subAgent === true ||
		topLevelMetadata?.subAgent === true
	) {
		return false;
	}
	if (ALWAYS_RESPOND_SOURCES.some((pattern) => source.includes(pattern))) {
		return false;
	}

	// Only known text group-ish channels; unknown/missing channel type fails open.
	const channelType =
		typeof message.content?.channelType === "string"
			? message.content.channelType.trim().toUpperCase()
			: "";
	return TRIAGE_CHANNEL_TYPES.has(channelType);
}

function senderNameOf(message: Memory): string {
	const metadata = metadataRecord(message.metadata);
	const entityName = metadata?.entityName;
	if (typeof entityName === "string" && entityName.trim() !== "") {
		return entityName.trim();
	}
	const entityUserName = metadata?.entityUserName;
	if (typeof entityUserName === "string" && entityUserName.trim() !== "") {
		return entityUserName.trim();
	}
	return "bot";
}

function clip(text: string, maxChars: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > maxChars
		? `${collapsed.slice(0, maxChars)}…`
		: collapsed;
}

function historyLine(runtime: IAgentRuntime, memory: Memory): string | null {
	const text =
		typeof memory.content?.text === "string" ? memory.content.text : "";
	if (text.trim() === "") return null;
	const name =
		memory.entityId === runtime.agentId
			? (runtime.character?.name ?? "agent")
			: senderNameOf(memory);
	return `${name}: ${clip(text, MAX_HISTORY_LINE_CHARS)}`;
}

export function buildBotNoiseTriagePrompt(args: {
	agentName: string;
	senderName: string;
	messageText: string;
	historyLines: readonly string[];
}): string {
	const history =
		args.historyLines.length > 0 ? args.historyLines.join("\n") : "(none)";
	return [
		`You decide whether ${args.agentName}, an AI agent in a group channel, should respond to a message.`,
		`The newest message was posted by a bot or webhook and does not mention or address ${args.agentName}.`,
		"",
		"Recent channel messages:",
		history,
		"",
		`Newest message, from ${args.senderName} (bot/webhook):`,
		clip(args.messageText, MAX_CURRENT_TEXT_CHARS) || "(empty)",
		"",
		`Automated status feeds, embeds, queue/system updates, notifications, and bot-to-bot chatter not involving ${args.agentName} should be ignored.`,
		`Answer RESPOND only if the message clearly asks ${args.agentName} something or requires ${args.agentName} to act.`,
		"Reply with exactly one word: RESPOND or IGNORE.",
	].join("\n");
}

function parseTriageVerdict(raw: string): boolean | undefined {
	const normalized = raw.trim().toUpperCase();
	const saysIgnore = /\bIGNORE\b/.test(normalized);
	const saysRespond = /\bRESPOND\b/.test(normalized);
	if (saysIgnore && !saysRespond) return false;
	if (saysRespond && !saysIgnore) return true;
	return undefined;
}

/**
 * Run the cheap-tier triage. Returns `{ applied: false }` whenever the gate
 * does not confidently apply — the caller then runs the normal pipeline.
 */
export async function runBotNoiseTriage(
	args: BotNoiseTriageArgs,
): Promise<BotNoiseTriageResult> {
	const { runtime, message, explicitlyAddressesAgent } = args;
	if (!isBotNoiseTriageEnabled(runtime)) return { applied: false };
	if (!isTriagableBotNoiseMessage(message, explicitlyAddressesAgent)) {
		return { applied: false };
	}

	let historyLines: string[] = [];
	try {
		const recent = await runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			count: MAX_HISTORY_MESSAGES,
		});
		historyLines = recent
			.filter((memory) => memory.id !== message.id)
			.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
			.map((memory) => historyLine(runtime, memory))
			.filter((line): line is string => line !== null);
	} catch {
		// History is best-effort context; triage still works without it.
	}

	const prompt = buildBotNoiseTriagePrompt({
		agentName: runtime.character?.name ?? "agent",
		senderName: senderNameOf(message),
		messageText:
			typeof message.content?.text === "string" ? message.content.text : "",
		historyLines,
	});

	try {
		const params: GenerateTextParams = {
			prompt,
			// One word is the contract, but reasoning-style small models may spend
			// budget before the visible answer — leave headroom so the verdict is
			// never truncated into a fail-open.
			maxTokens: 64,
			temperature: 0,
			voiceOutput: "internal",
		};
		const raw = (await runtime.useModel(ModelType.TEXT_SMALL, params)) as
			| string
			| GenerateTextResult;
		// Reuse the canonical helpers Stage 1 uses for the same TEXT_SMALL call:
		// getV5ModelText handles the content-array / response-field result shapes
		// (structured output from reasoning-tier providers has no flat `.text`),
		// and stripReasoningBlocks drops <think>…</think> so a reasoning model
		// that names both RESPOND and IGNORE while deliberating still yields a
		// clean one-word verdict instead of an ambiguous fail-open.
		const text = stripReasoningBlocks(getV5ModelText(raw));
		const verdict = parseTriageVerdict(text);
		if (verdict === undefined) {
			// Unparseable verdict — fail open into the full pipeline.
			return { applied: false };
		}
		return { applied: true, respond: verdict };
	} catch (error) {
		// No TEXT_SMALL handler / provider failure: the gate must never take
		// the pipeline down. Fail open.
		runtime.logger?.debug?.(
			{
				src: "service:message",
				agentId: runtime.agentId,
				error: error instanceof Error ? error.message : String(error),
			},
			"[message] bot-noise triage model call failed — falling back to full pipeline",
		);
		return { applied: false };
	}
}
