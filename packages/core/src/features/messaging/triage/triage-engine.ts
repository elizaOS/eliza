/**
 * Deterministic cross-platform triage scoring.
 *
 * Scoring inputs:
 *   - contact weight (resolved via RelationshipsService.findByHandle)
 *   - urgency keywords in subject/snippet/body
 *   - recency floor (<1h => high floor, <24h => medium floor)
 *   - thread context (bump one level if user previously replied in thread)
 *   - spam heuristics (bulk-mailer / promotional keywords)
 */

import { logger } from "../../../logger.ts";
import type {
	ContactInfo,
	RelationshipsService,
} from "../../../services/relationships.ts";
import type { IAgentRuntime } from "../../../types/index.ts";
import type {
	MessageRef,
	SuggestedAction,
	TriagePriority,
	TriageScore,
} from "./types.ts";

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

const URGENCY_KEYWORDS = [
	"urgent",
	"asap",
	"emergency",
	"deadline",
	"today",
	"need now",
	"help",
] as const;

const URGENCY_BUMP_PER_HIT = 0.2;
const URGENCY_MAX_BUMP = 0.5;

const SPAM_KEYWORDS = [
	"unsubscribe",
	"click here to unsubscribe",
	"limited time offer",
	"act now",
	"free trial",
	"promotional",
	"newsletter",
	"marketing",
	"you've been selected",
	"viagra",
	"crypto airdrop",
	"congratulations you won",
] as const;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

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

function findUrgencyKeywords(text: string): string[] {
	const lower = text.toLowerCase();
	const hits: string[] = [];
	for (const keyword of URGENCY_KEYWORDS) {
		if (lower.includes(keyword)) hits.push(keyword);
	}
	return hits;
}

function looksLikeSpam(msg: MessageRef): boolean {
	const haystack =
		`${msg.subject ?? ""} ${msg.snippet} ${msg.body ?? ""}`.toLowerCase();
	let hits = 0;
	for (const kw of SPAM_KEYWORDS) {
		if (haystack.includes(kw)) hits++;
	}
	// two promotional markers is a strong spam signal
	return hits >= 2;
}

function scoreToPriority(score: number): TriagePriority {
	if (score >= 1.1) return "critical";
	if (score >= 0.8) return "high";
	if (score >= 0.5) return "medium";
	return "low";
}

function priorityToAction(priority: TriagePriority): SuggestedAction {
	switch (priority) {
		case "critical":
			return "respond-now";
		case "high":
			return "respond-today";
		case "medium":
			return "respond-this-week";
		case "low":
			return "archive";
		case "spam":
			return "skip";
	}
}

const PRIORITY_ORDER: TriagePriority[] = ["low", "medium", "high", "critical"];

function bumpPriority(priority: TriagePriority): TriagePriority {
	if (priority === "spam") return priority;
	const idx = PRIORITY_ORDER.indexOf(priority);
	if (idx < 0 || idx === PRIORITY_ORDER.length - 1) return priority;
	return PRIORITY_ORDER[idx + 1];
}

function floorPriority(
	priority: TriagePriority,
	floor: TriagePriority,
): TriagePriority {
	if (priority === "spam" || floor === "spam") return priority;
	const a = PRIORITY_ORDER.indexOf(priority);
	const b = PRIORITY_ORDER.indexOf(floor);
	if (a < 0 || b < 0) return priority;
	return PRIORITY_ORDER[Math.max(a, b)];
}

export interface ScoreContext {
	/**
	 * Optional: set of threadIds in which the user has previously replied.
	 * Used for the thread-context bump.
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

	const searchText = `${message.subject ?? ""} ${message.snippet} ${message.body ?? ""}`;
	const urgencyHits = findUrgencyKeywords(searchText);
	const urgencyBump = Math.min(
		URGENCY_MAX_BUMP,
		urgencyHits.length * URGENCY_BUMP_PER_HIT,
	);

	if (looksLikeSpam(message) && contactWeight <= DEFAULT_CONTACT_WEIGHT) {
		return {
			priority: "spam",
			reason: "Matches promotional / bulk-mailer heuristics",
			suggestedAction: "skip",
			contactWeight,
			urgencyKeywords: urgencyHits,
			scoredAt: nowMs,
		};
	}

	const rawScore = contactWeight + urgencyBump;
	let priority = scoreToPriority(rawScore);

	// Recency floors
	const ageMs = Math.max(0, nowMs - message.receivedAtMs);
	if (ageMs < HOUR_MS) {
		priority = floorPriority(priority, "high");
	} else if (ageMs < DAY_MS) {
		priority = floorPriority(priority, "medium");
	}

	// Thread context bump
	if (message.threadId && ctx.userRepliedThreadIds?.has(message.threadId)) {
		priority = bumpPriority(priority);
	}

	const reasonParts: string[] = [`contact weight ${contactWeight.toFixed(2)}`];
	if (urgencyHits.length > 0) {
		reasonParts.push(`urgency [${urgencyHits.join(", ")}]`);
	}
	if (ageMs < HOUR_MS) reasonParts.push("received <1h ago");
	else if (ageMs < DAY_MS) reasonParts.push("received <24h ago");
	if (message.threadId && ctx.userRepliedThreadIds?.has(message.threadId)) {
		reasonParts.push("user previously replied in thread");
	}

	return {
		priority,
		reason: reasonParts.join("; "),
		suggestedAction: priorityToAction(priority),
		contactWeight,
		urgencyKeywords: urgencyHits,
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

const PRIORITY_RANK: Record<TriagePriority, number> = {
	critical: 4,
	high: 3,
	medium: 2,
	low: 1,
	spam: 0,
};

export function rankScored(messages: MessageRef[]): MessageRef[] {
	return [...messages].sort((a, b) => {
		const pa = a.triageScore ? PRIORITY_RANK[a.triageScore.priority] : -1;
		const pb = b.triageScore ? PRIORITY_RANK[b.triageScore.priority] : -1;
		if (pa !== pb) return pb - pa;
		return b.receivedAtMs - a.receivedAtMs;
	});
}
