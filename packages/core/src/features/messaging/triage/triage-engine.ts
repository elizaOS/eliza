/**
 * Structural triage signals for cross-platform messages.
 *
 * The engine deliberately makes no urgency, spam, or next-action judgment —
 * those are language-understanding calls that belong to the model reading the
 * MESSAGE action output (#14716; keyword tables were English-only and
 * word-presence-based, so "no deadline on this" read as urgent). It attaches
 * only typed structural facts the model cannot cheaply derive from the
 * message text itself:
 *   - contact weight (relationship category resolved via RelationshipsService)
 *   - whether the user previously replied in the message's thread
 * and orders the feed by recency, with contact weight as the tie-break.
 */

import { logger } from "../../../logger.ts";
import type {
	ContactInfo,
	RelationshipsService,
} from "../../../services/relationships.ts";
import type { IAgentRuntime } from "../../../types/index.ts";
import type { MessageRef, TriageScore } from "./types.ts";

const CATEGORY_WEIGHTS: Record<string, number> = {
	family: 1.0,
	"close-friend": 0.9,
	"close friend": 0.9,
	professional: 0.7,
	work: 0.7,
	colleague: 0.7,
	acquaintance: 0.4,
	stranger: 0.2,
};

export const DEFAULT_CONTACT_WEIGHT = 0.5;

/**
 * Resolve the contact weight for a sender. Returns DEFAULT_CONTACT_WEIGHT
 * when the relationships service is unavailable (and logs once) or when no
 * matching contact is found.
 */
let missingServiceWarned = false;
export function resetMissingServiceWarning(): void {
	missingServiceWarned = false;
}

export async function resolveContactWeight(
	runtime: IAgentRuntime,
	source: string,
	identifier: string,
): Promise<{ weight: number; contact: ContactInfo | null }> {
	const service = runtime.getService(
		"relationships",
	) as RelationshipsService | null;
	if (!service || typeof service.findByHandle !== "function") {
		if (!missingServiceWarned) {
			logger.info(
				"[TriageEngine] RelationshipsService not available; using default contact weight",
			);
			missingServiceWarned = true;
		}
		return { weight: DEFAULT_CONTACT_WEIGHT, contact: null };
	}

	const contact = await service.findByHandle(source, identifier);
	if (!contact) return { weight: DEFAULT_CONTACT_WEIGHT, contact: null };

	let best = DEFAULT_CONTACT_WEIGHT;
	for (const category of contact.categories) {
		const normalized = category.trim().toLowerCase();
		const weight = CATEGORY_WEIGHTS[normalized];
		if (weight !== undefined && weight > best) best = weight;
	}
	return { weight: best, contact };
}

export interface ScoreContext {
	/**
	 * Optional: set of threadIds in which the user has previously replied.
	 * Surfaced as the userRepliedInThread signal.
	 */
	userRepliedThreadIds?: Set<string>;
	nowMs?: number;
}

export async function scoreMessage(
	runtime: IAgentRuntime,
	message: MessageRef,
	ctx: ScoreContext = {},
): Promise<TriageScore> {
	const nowMs = ctx.nowMs ?? Date.now();
	const { weight: contactWeight } = await resolveContactWeight(
		runtime,
		message.source,
		message.from.identifier,
	);
	return {
		contactWeight,
		userRepliedInThread: Boolean(
			message.threadId && ctx.userRepliedThreadIds?.has(message.threadId),
		),
		scoredAt: nowMs,
	};
}

export async function scoreMessages(
	runtime: IAgentRuntime,
	messages: MessageRef[],
	ctx: ScoreContext = {},
): Promise<MessageRef[]> {
	const out: MessageRef[] = [];
	for (const m of messages) {
		const triageScore = await scoreMessage(runtime, m, ctx);
		out.push({ ...m, triageScore });
	}
	return out;
}

/**
 * Presentation order for the feed: newest first, contact weight breaking
 * ties. Unscored refs sort at the default weight — the comparator needs a
 * total order, and a missing score carries no relationship information.
 */
export function rankScored(messages: MessageRef[]): MessageRef[] {
	return [...messages].sort((a, b) => {
		if (a.receivedAtMs !== b.receivedAtMs) {
			return b.receivedAtMs - a.receivedAtMs;
		}
		return (
			(b.triageScore?.contactWeight ?? DEFAULT_CONTACT_WEIGHT) -
			(a.triageScore?.contactWeight ?? DEFAULT_CONTACT_WEIGHT)
		);
	});
}
