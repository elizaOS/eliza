/**
 * Provider attribution helpers for trajectory records. Runtime prompt
 * composition already knows the ordered provider blocks that fed a model call;
 * these helpers persist hash-first spans so optimizers can reason about
 * provider selection without storing another copy of provider text.
 *
 * Spans are only meaningful against one exact canonical prompt string — the
 * flattened `messages` (or bare `prompt`) persisted on the consuming model
 * call. composeState may snapshot provider text early; every model-call writer
 * must rebind (or omit) spans against that call's recorded representation.
 */
import { createHash } from "node:crypto";
import type { ChatMessage } from "../types/model";
import type { State } from "../types/state";

export interface TrajectoryProviderAttribution {
	providerName: string;
	sha256: string;
	/**
	 * Character-based estimate (`ceil(len / 3.5)`), not a model tokenizer count.
	 * Always paired with `tokenCountEstimated: true` from the runtime helpers.
	 */
	tokenCount: number;
	/** True when `tokenCount` is the length-based estimate, not billed usage. */
	tokenCountEstimated?: boolean;
	position: number;
	/** Inclusive-exclusive offsets into the call's canonical prompt, when exact. */
	spanStart?: number;
	spanEnd?: number;
}

interface ProviderTextSnapshot {
	providerName: string;
	text: string;
	position: number;
}

/** Lowercase hex SHA-256 of UTF-8 text or raw bytes. */
export function sha256Hex(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * Length-based token estimate for trajectory diagnostics only. Do not treat
 * the result as billed or tokenizer-accurate usage.
 */
export function estimateTrajectoryTextTokens(text: string): number {
	return Math.ceil(text.length / 3.5);
}

export function flattenTrajectoryMessages(
	messages: readonly ChatMessage[] | readonly unknown[] | undefined,
): string {
	if (!Array.isArray(messages) || messages.length === 0) {
		return "";
	}
	return messages
		.map((message) => {
			if (!message || typeof message !== "object") {
				return String(message);
			}
			const record = message as { role?: unknown; content?: unknown };
			const role = typeof record.role === "string" ? record.role : "message";
			const content =
				typeof record.content === "string"
					? record.content
					: // Diagnostics rendering: an absent content serializes as "null" so
						// the trajectory shows the hole instead of silently reading empty.
						JSON.stringify(record.content ?? null);
			return `${role}:\n${content}`;
		})
		.join("\n\n");
}

/**
 * Canonical prompt representation for a recorded model call. Prefer the
 * flattened `messages` array (the persisted source of truth); fall back to a
 * bare prompt string when messages are absent.
 */
export function canonicalPromptForModelCall(args: {
	messages?: readonly ChatMessage[] | readonly unknown[] | undefined;
	prompt?: string | null | undefined;
}): string {
	const fromMessages = flattenTrajectoryMessages(args.messages);
	if (fromMessages.length > 0) {
		return fromMessages;
	}
	return typeof args.prompt === "string" ? args.prompt : "";
}

/**
 * Drop span offsets that are not proven against a known prompt. Keeps hash,
 * order, and estimated token fields so consumers still see contribution
 * identity without a false exact-match claim.
 */
export function omitUnvalidatedProviderSpans(
	attributions: readonly TrajectoryProviderAttribution[] | undefined,
): TrajectoryProviderAttribution[] | undefined {
	if (!attributions || attributions.length === 0) {
		return attributions === undefined ? undefined : [];
	}
	return attributions.map((entry) => {
		const { spanStart: _spanStart, spanEnd: _spanEnd, ...rest } = entry;
		return {
			...rest,
			tokenCountEstimated: rest.tokenCountEstimated ?? true,
		};
	});
}

function providerSnapshotsFromState(state: State | undefined): {
	providerOrder: string[];
	snapshots: ProviderTextSnapshot[];
} {
	const providers = state?.data?.providers;
	if (!providers || typeof providers !== "object") {
		return { providerOrder: [], snapshots: [] };
	}
	const providerMap = providers as Record<string, unknown>;
	const providerOrder = Array.isArray(state.data.providerOrder)
		? state.data.providerOrder.map((name) => String(name))
		: Object.keys(providerMap).sort((left, right) => left.localeCompare(right));
	const seen = new Set<string>();
	const snapshots: ProviderTextSnapshot[] = [];
	for (const providerName of providerOrder) {
		if (seen.has(providerName)) {
			continue;
		}
		seen.add(providerName);
		const provider = providerMap[providerName];
		if (!provider || typeof provider !== "object") {
			continue;
		}
		const text = (provider as { text?: unknown }).text;
		if (typeof text !== "string") continue;
		const trimmed = text.trim();
		if (trimmed === "") continue;
		snapshots.push({ providerName, text: trimmed, position: snapshots.length });
	}
	return { providerOrder, snapshots };
}

function locateProviderSpan(
	// Undefined (no prompt captured) and empty both mean "nothing to locate";
	// the guard below already returns the explicit no-span result for both.
	prompt: string | undefined,
	snapshot: ProviderTextSnapshot,
	cursor: number,
): { start?: number; end?: number; nextCursor: number } {
	if (!prompt) {
		return { nextCursor: cursor };
	}
	const direct = prompt.indexOf(snapshot.text, cursor);
	if (direct >= 0) {
		return {
			start: direct,
			end: direct + snapshot.text.length,
			nextCursor: direct + snapshot.text.length,
		};
	}
	const labeled = `provider:${snapshot.providerName}:\n${snapshot.text}`;
	const labeledStart = prompt.indexOf(labeled, cursor);
	if (labeledStart >= 0) {
		const textStart = labeledStart + labeled.length - snapshot.text.length;
		return {
			start: textStart,
			end: textStart + snapshot.text.length,
			nextCursor: textStart + snapshot.text.length,
		};
	}
	return { nextCursor: cursor };
}

export function buildProviderAttributionsFromState(args: {
	state?: State;
	/**
	 * Exact canonical prompt for the consuming call. Spans are located only
	 * inside this string; when a provider is not present, spans are omitted.
	 */
	prompt?: string;
}): {
	providerOrder: string[];
	providerAttributions: TrajectoryProviderAttribution[];
} {
	const { providerOrder, snapshots } = providerSnapshotsFromState(args.state);
	let cursor = 0;
	const providerAttributions = snapshots.map((snapshot) => {
		const span = locateProviderSpan(args.prompt, snapshot, cursor);
		cursor = span.nextCursor;
		return {
			providerName: snapshot.providerName,
			sha256: sha256Hex(snapshot.text),
			tokenCount: estimateTrajectoryTextTokens(snapshot.text),
			tokenCountEstimated: true as const,
			position: snapshot.position,
			...(span.start !== undefined && span.end !== undefined
				? { spanStart: span.start, spanEnd: span.end }
				: {}),
		};
	});
	return { providerOrder, providerAttributions };
}
