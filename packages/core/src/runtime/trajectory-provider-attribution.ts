/**
 * Provider attribution helpers for trajectory records. Runtime prompt
 * composition already knows the ordered provider blocks that fed a model call;
 * these helpers persist hash-first spans so optimizers can reason about
 * provider selection without storing another copy of provider text.
 */
import { createHash } from "node:crypto";
import type { ChatMessage } from "../types/model";
import type { State } from "../types/state";

export interface TrajectoryProviderAttribution {
	providerName: string;
	sha256: string;
	tokenCount: number;
	position: number;
	spanStart?: number;
	spanEnd?: number;
}

interface ProviderTextSnapshot {
	providerName: string;
	text: string;
	position: number;
}

export function sha256Text(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

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
					: JSON.stringify(record.content ?? "");
			return `${role}:\n${content}`;
		})
		.join("\n\n");
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
		if (typeof text !== "string" || text.trim() === "") {
			continue;
		}
		snapshots.push({
			providerName,
			text: text.trim(),
			position: snapshots.length,
		});
	}
	return { providerOrder, snapshots };
}

function locateProviderSpan(
	prompt: string,
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
	prompt?: string;
}): {
	providerOrder: string[];
	providerAttributions: TrajectoryProviderAttribution[];
} {
	const { providerOrder, snapshots } = providerSnapshotsFromState(args.state);
	let cursor = 0;
	const providerAttributions = snapshots.map((snapshot) => {
		const span = locateProviderSpan(args.prompt ?? "", snapshot, cursor);
		cursor = span.nextCursor;
		return {
			providerName: snapshot.providerName,
			sha256: sha256Text(snapshot.text),
			tokenCount: estimateTrajectoryTextTokens(snapshot.text),
			position: snapshot.position,
			...(span.start !== undefined && span.end !== undefined
				? { spanStart: span.start, spanEnd: span.end }
				: {}),
		};
	});
	return { providerOrder, providerAttributions };
}
