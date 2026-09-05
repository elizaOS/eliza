/**
 * Turn-bound user consent for sending an outbound draft (#25284).
 *
 * A send may be authorized only by a real subsequent user turn that answered
 * the preview the agent showed. Planner tool-call arguments — most notably a
 * `confirmed: true` boolean — are model-authored and never count as consent
 * (the GHSA-rqm7 class; `llmConfirmedFlagIsAuthoritative` is unconditionally
 * false in utils/confirmation.ts). This module implements the two-phase flow
 * for the MESSAGE send_draft op only: phase one stashes a pending record
 * binding the requester's actor, room, the arming turn's message id and
 * timestamp, and a SHA-256 digest of a canonical encoding of every
 * delivery-relevant field in the draft snapshot; phase two — on a LATER user
 * turn, proven by a different message id AND a timestamp that does not
 * predate the arming turn — admits only an unqualified affirmative that
 * carries an affirmative anchor, with the record's draft binding still
 * matching, and consumes the record exactly once per arming (the
 * process-local consumed set — keyed by arming, not digest alone — picks
 * the single winner among concurrent invocations; losers re-surface the
 * preview ask, and a fresh arming after a failed or policy-held send can be
 * confirmed again). A refusal clause anywhere in the reply cancels outright.
 * A mutated draft re-arms the CURRENT preview (fresh
 * digest, arming turn, and TTL) so the next bare "yes" answers what the user
 * last saw instead of dead-ending. Exactly one pending record exists per
 * actor+room — arming a new draft replaces it, so a later bare "yes" can only
 * ever authorize the most recently previewed draft, never one the planner
 * silently swaps in. Durable cross-process/restart idempotency is owned by
 * #24244 (delivery intents); the service-level in-flight map plus the draft's
 * `sent` flag are the second layer limiting duplicate provider calls.
 *
 * Consumed by `sendDraft.ts`; deliberately stricter than the generic
 * `requireConfirmation` helper, which binds neither room nor draft content and
 * accepts a prefix affirmative. The owner SendPolicy gate remains a separate,
 * independent gate that runs after this one.
 */
import crypto from "node:crypto";
import { logger } from "../../../../logger.ts";
import {
	CANONICAL_ROLE_RANK,
	checkSenderRole,
	getUnresolvedSenderRoleFloor,
} from "../../../../roles.ts";
import { unwrapUserMessageText } from "../../../../security/incoming-message-security.ts";
import type { IAgentRuntime, Memory } from "../../../../types/index.ts";
import type { DraftRecord } from "../types.ts";

/** How long a previewed send stays confirmable before it must be re-previewed. */
export const SEND_CONSENT_TTL_MS = 5 * 60_000;

const SEND_CONSENT_ACTION = "MESSAGE_SEND_DRAFT";

/**
 * Affirmative anchors: a confirming reply must contain at least one of these
 * on top of reducing to cue words only. Without the anchor requirement a
 * filler-only reply ("please", "now", "the draft") would authorize a send.
 */
const AFFIRMATIVE_ANCHORS = new Set([
	"yes",
	"yeah",
	"yep",
	"y",
	"ok",
	"okay",
	"sure",
	"confirm",
	"confirmed",
	"approve",
	"approved",
	"go",
	"proceed",
	"send",
	"sends",
	"sendt",
	"si",
	"sí",
	"oui",
	"ja",
	"hai",
	"はい",
	"确认",
	"確認",
	"확인",
	"네",
	"是",
	"好的",
	"envía",
	"envia",
	"manda",
	"发送",
	"发吧",
	"送信",
	"送って",
	"보내",
	"보내세요",
]);

/**
 * Bare-affirmation detector using the residue approach proven in the life
 * create-consent gate: strip send cues, draft references, politeness filler,
 * and punctuation; the reply counts as consent only when NOTHING substantive
 * survives AND at least one affirmative anchor survived. "yes", "ok, send
 * it.", and "Send that Gmail reply now." all qualify; "yes, but change the
 * subject", "send it to Bob instead", "ok but wait until tomorrow", and
 * filler-only replies like "please" or "the draft" do not.
 */
const SEND_CUE_WORDS = new Set([
	...AFFIRMATIVE_ANCHORS,
	// affirmation/timing particles that may accompany an anchor
	"sending",
	"sent",
	"ahead",
	"it",
	"out",
	"して",
	// politeness filler
	"please",
	"pls",
	"now",
	"just",
	"exactly",
	"thanks",
	"thank",
	"you",
	"merci",
	// generic draft references (the exact draft identity is bound by digest,
	// never re-parsed from the reply)
	"the",
	"a",
	"an",
	"that",
	"this",
	"those",
	"these",
	"one",
	"draft",
	"message",
	"reply",
	"email",
	"mail",
	"note",
	"im",
	"text",
	"sms",
	"dm",
	"gmail",
	"imessage",
	"whatsapp",
	"telegram",
	"discord",
	"slack",
]);
// NOTE (#27932 review): interrogative auxiliaries ("do", "did", "does") are
// deliberately NOT cue words. With "did" admitted, "did you send it?" reduced
// to cue words only with "send" as an anchor and authorized an irreversible
// send off a question about whether the send happened. A question is never an
// answer to the preview; the residue test below plus the question-mark check
// fail these closed.
// Any Unicode question-mark codepoint marks a question. The class is the
// complete set of codepoints whose Unicode name contains "QUESTION MARK"
// (including TAG QUESTION MARK U+E003F and MEDIEVAL QUESTION MARK U+2E54,
// Unicode 14) plus the interrobang family (⁇ ⁈ ⁉ ‽ ⸘) — question semantics
// per the Unicode names list. Derived from the Unicode data, not hand-picked,
// so no locale's question shape (Arabic ؟, Armenian ՞, Greek ;, Ethiopic ፧,
// Vai ꘏, Chakma 𑅃, inverted ¿, …) is missed. None is alphanumeric, so none
// participates in the residue filter below; a question always fails closed.
const QUESTION_MARK_RE = /[?¿;՞؟፧᥅⁇⁈⁉‽⸘❓❔⩻⩼⳺⳻⸮꘏꛷︖﹖？⹔𑅃𞥟🯄󠀿]/u;

function isBareSendAffirmation(text: string): boolean {
	const lowered = text.toLowerCase();
	// ANY question mark makes the reply a question about the send ("did you
	// send it?", "ok send it?"), not an answer to the preview — regardless of
	// trailing punctuation, quotes, or trailing words ("send it?!", "\"send
	// it?\"", "send it? please"). Checked before punctuation stripping
	// because the residue filter would otherwise erase the mark and turn the
	// question into a bare affirmative. Covers the Unicode question-mark
	// forms (full-width ？, Arabic ؟, small ﹖, presentation ︖, inverted ⸮,
	// interrobangs ⁇⁈⁉) so no locale's question shape survives stripping.
	// False positives (an affirmative that quotes a question) merely
	// re-prompt: fail-safe direction.
	if (QUESTION_MARK_RE.test(lowered)) return false;
	const residue = lowered.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
	if (residue.length === 0) return false;
	let sawAnchor = false;
	for (const word of residue.split(/\s+/)) {
		if (!SEND_CUE_WORDS.has(word)) return false;
		if (AFFIRMATIVE_ANCHORS.has(word)) sawAnchor = true;
	}
	return sawAnchor;
}

/**
 * Unambiguous refusals clear the pending record immediately. A refusal is
 * recognized anywhere in the reply — leading ("no"), trailing after an
 * affirmative ("yes please don't send"), or standalone ("ok, don't send
 * it") — because an affirmative that carries a refusal clause must never
 * count as consent, and leaving the record armed after the user said not to
 * send is both a UX bug and one careless later "yes" away from a wrong send.
 * The clause set stays English-only on purpose: it only ever CANCELS, so a
 * missed non-English refusal degrades to a re-preview ask, never to a send.
 */
const REFUSAL_RE =
	/(?:^|[\s,.!?;:…。！？、])(?:no|nope|nah|cancel|stop|don'?t|do not|never mind|nevermind|abort)\b/iu;

type SendConsentStatus =
	| { status: "pending"; preview: string }
	| { status: "confirmed" }
	| { status: "cancelled" }
	| { status: "stale"; preview: string };

interface PendingSendConsent {
	readonly actionName: string;
	readonly entityId: string;
	readonly roomId: string;
	readonly draftId: string;
	readonly digest: string;
	/** Identity of this arming: strictly increasing, so re-arms never collide in the consumed set. */
	readonly seq: number;
	/** Message id of the turn that armed this record; consent must arrive on a different, later turn. */
	readonly armedMessageId: string;
	/** Wall-clock `createdAt` of the arming turn; a confirming turn must not predate it. */
	readonly armedAtMs: number;
	readonly createdAt: number;
	readonly ttlMs: number;
}

/**
 * Canonical JSON: object keys sorted at every depth so key order can never
 * change the digest of otherwise-identical content.
 */
function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map((key) => [key, canonicalize(record[key])]),
		);
	}
	return value;
}

/**
 * SHA-256 digest of a canonical JSON encoding of every delivery-relevant
 * field in the immutable draft snapshot. JSON string encoding makes delimiter
 * collisions impossible (every field is unambiguously quoted/escaped), unlike
 * the earlier raw-field join. `preview` and bookkeeping (`sent`,
 * `sentExternalId`, `scheduledForMs`, `scheduledId`, `scheduleCommit`) are
 * excluded because they are derived or post-send state, not things the user
 * is consenting to.
 */
export function draftConsentDigest(record: DraftRecord): string {
	const payload = canonicalize({
		id: record.draftId,
		src: record.source,
		reply: record.inReplyToId ?? "",
		thread: record.threadId ?? "",
		world: record.worldId ?? "",
		channel: record.channelId ?? "",
		to: [...record.to]
			.map((r) => [r.identifier, r.displayName ?? ""] as const)
			// Sort by the complete canonical tuple: identifier-only sorting
			// lets reordered duplicate identifiers with different
			// displayNames change the digest, breaking the
			// recipient-order-canonicalization invariant (#25284 review r1).
			.sort(([ai, ad], [bi, bd]) =>
				ai < bi ? -1 : ai > bi ? 1 : ad < bd ? -1 : ad > bd ? 1 : 0,
			),
		subject: record.subject ?? "",
		body: record.body,
		meta: record.metadata === undefined ? "" : record.metadata,
	});
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(payload), "utf8")
		.digest("hex");
}

/**
 * One pending consent per actor+room (#25284 review round 2): a bare "yes"
 * can only ever authorize the newest previewed draft for that conversation —
 * the planner cannot keep several drafts armed and pick one after the fact.
 */
function cacheKey(entityId: string, roomId: string): string {
	return `send-consent:${SEND_CONSENT_ACTION}:${entityId}:${roomId}`;
}

function isFresh(pending: PendingSendConsent): boolean {
	return Date.now() - pending.createdAt <= pending.ttlMs;
}

/**
 * Monotonic arming sequence: every arming (fresh or re-arm) gets a strictly
 * increasing counter so two armings in the same millisecond remain distinct
 * consumed keys — a failed or policy-held send's re-arm must never collide
 * with the spent key of the arming that preceded it (#25284 r3). Kept
 * separate from `createdAt`, which stays a real epoch-ms freshness clock.
 */
let armingSeq = 0;
function nextArmingSeq(): number {
	armingSeq += 1;
	return armingSeq;
}

/**
 * Two-phase send-consent gate for one conversation (actor+room).
 *
 * Call on every send_draft invocation with the draft the planner wants to
 * send. The first call stashes the binding and returns `pending` — the caller
 * must surface the preview ask. On a later turn (different message id), an
 * unqualified affirmative carrying an affirmative anchor, with the armed
 * draft's digest still matching, returns `confirmed` exactly once per process
 * (the consumed set picks the single winner; losers re-arm the preview); a
 * refusal returns `cancelled`; anything else — the same turn re-invoking,
 * a different draft than the one armed, an edited draft, an expired record,
 * or qualified confirmation text — returns `stale` (or a fresh `pending` when
 * nothing was armed), and the caller re-arms the preview.
 */
export async function gateSendDraftConsent(args: {
	runtime: IAgentRuntime;
	message: Memory;
	draft: DraftRecord;
	ttlMs?: number;
}): Promise<SendConsentStatus> {
	const ttlMs =
		typeof args.ttlMs === "number" &&
		Number.isFinite(args.ttlMs) &&
		args.ttlMs > 0
			? args.ttlMs
			: SEND_CONSENT_TTL_MS;
	const entityId = String(args.message.entityId ?? "");
	const roomId = String(args.message.roomId ?? "");
	const messageId = String(args.message.id ?? "");
	const key = cacheKey(entityId, roomId);
	const digest = draftConsentDigest(args.draft);
	const userText = unwrapUserMessageText(args.message).trim();
	// Trusted message timestamp (ms epoch) used to prove the confirming turn
	// is subsequent to the arming turn. Connectors stamp `createdAt` server-
	// side from their ingest time; an unparsable value fails closed below.
	const messageCreatedAt = Number(args.message.createdAt);

	let existing: PendingSendConsent | undefined =
		await args.runtime.getCache<PendingSendConsent>(key);
	if (existing && !isFresh(existing)) {
		// Expired: clear it BEFORE arming the replacement so the fresh record
		// is never deleted out from under the preview we are about to return.
		await args.runtime.deleteCache(key).catch(() => {
			/* error-policy:J6 best-effort cleanup of the expired record */
		});
		existing = undefined;
	}

	if (!existing) {
		const pending: PendingSendConsent = {
			actionName: SEND_CONSENT_ACTION,
			entityId,
			roomId,
			draftId: args.draft.draftId,
			digest,
			armedMessageId: messageId,
			armedAtMs: Number.isFinite(messageCreatedAt)
				? messageCreatedAt
				: Date.now(),
			createdAt: Date.now(),
			seq: nextArmingSeq(),
			ttlMs,
		};
		await args.runtime.setCache(key, pending);
		return { status: "pending", preview: args.draft.preview };
	}

	// Same-turn re-invocation (planner re-calls send_draft while settling the
	// same message) can never confirm: consent must arrive on a LATER user
	// turn, proven by a different message id...
	if (messageId === existing.armedMessageId) {
		return { status: "stale", preview: args.draft.preview };
	}
	// ...AND by a turn that did not exist before the preview was armed. A
	// different id alone is replayable: an older affirmative (or one the
	// planner dug out of history) must never satisfy the gate. Unparsable or
	// missing createdAt fails closed — the turn cannot be proven subsequent.
	if (
		!Number.isFinite(messageCreatedAt) ||
		messageCreatedAt < existing.armedAtMs
	) {
		return { status: "stale", preview: args.draft.preview };
	}

	// A refusal clause anywhere in the reply cancels outright, before any
	// re-arming: the user said not to send, so no preview stays armed.
	if (REFUSAL_RE.test(userText)) {
		await args.runtime.deleteCache(key);
		return { status: "cancelled" };
	}

	// The planner is presenting a draft whose consent digest differs from
	// the armed one — a different draft, or a mutated version of it. Either
	// way the consent the user gave does not describe these bytes: replace
	// the binding with THIS draft (fresh digest, arming turn, and TTL) and
	// re-preview, so the next bare "yes" answers what the user last saw
	// instead of dead-ending or authorizing content they never saw.
	if (existing.digest !== digest) {
		const pending: PendingSendConsent = {
			actionName: SEND_CONSENT_ACTION,
			entityId,
			roomId,
			draftId: args.draft.draftId,
			digest,
			armedMessageId: messageId,
			armedAtMs: Number.isFinite(messageCreatedAt)
				? messageCreatedAt
				: Date.now(),
			createdAt: Date.now(),
			seq: nextArmingSeq(),
			ttlMs,
		};
		await args.runtime.setCache(key, pending);
		logger.warn(
			`[SendDraft] consent re-armed for draftId=${args.draft.draftId} (digest changed); re-preview`,
		);
		return { status: "pending", preview: args.draft.preview };
	}

	// A later turn whose text is not a bare affirmative keeps the unchanged
	// preview armed without consuming it.
	if (!isBareSendAffirmation(userText)) {
		return { status: "stale", preview: args.draft.preview };
	}

	// Single-winner consumption within this process: the consumed set decides
	// among concurrent invocations of the SAME arming; losers get `stale` and
	// re-surface the preview ask (the winner either delivered or hold/failed it —
	// either way this arming is spent; a NEW arming below gets a fresh consumed
	// key). The key is bound to the arming (`seq`), not just the digest, so
	// a later re-arm of the same content after a failed or policy-held send can
	// be confirmed again instead of colliding with the spent key. Cross-process
	// and cross-restart idempotency are owned by #24244 (delivery intents), and
	// the service-level in-flight map plus the draft's `sent` flag are the second
	// layer limiting duplicate provider calls.
	const consumedKey = `${key}:${existing.digest}:${existing.seq}`;
	if (consumedConsentKeys.has(consumedKey)) {
		return { status: "stale", preview: args.draft.preview };
	}
	consumedConsentKeys.add(consumedKey);
	noteConsumedKeyPrune();
	await args.runtime.deleteCache(key);
	return { status: "confirmed" };
}

/**
 * Consumed consent keys, process-local. Bounded by the TTL window: entries
 * are pruned opportunistically so the set cannot grow unboundedly in a
 * long-running process.
 */
const consumedConsentKeys = new Set<string>();
const CONSUMED_SET_MAX = 512;

function noteConsumedKeyPrune(): void {
	if (consumedConsentKeys.size <= CONSUMED_SET_MAX) return;
	const excess = consumedConsentKeys.size - CONSUMED_SET_MAX;
	let dropped = 0;
	for (const k of consumedConsentKeys) {
		consumedConsentKeys.delete(k);
		dropped += 1;
		if (dropped >= excess) break;
	}
}

/** Test hook: drop a pending consent record without resolving it. */
export async function clearSendDraftConsent(args: {
	runtime: IAgentRuntime;
	entityId: string;
	roomId: string;
}): Promise<void> {
	await args.runtime.deleteCache(cacheKey(args.entityId, args.roomId));
}

/** Test hook: forget consumed-consent markers so a new suite starts clean. */
export function __resetSendConsentStateForTests(): void {
	consumedConsentKeys.clear();
}

/**
 * Per-op principal admission for the MESSAGE send path (#25284): owned/
 * delegated delivery is a USER capability, so USER and above are admitted and
 * GUEST is denied. Mirrors `resolveToolCallUserRoles` in the tool-call
 * executor: the agent itself is OWNER; any other sender resolves through the
 * canonical role resolution; an unresolvable role ranks below every tier
 * (fail-closed) rather than silently authorizing a send. A role-resolution
 * FAILURE keeps the source-dependent unresolved-sender floor (roles.ts
 * convention): local/API senders keep their historical USER admission while
 * unresolved connector senders stay GUEST — never above their source's tier.
 */
export interface MessagePrincipalAdmission {
	readonly role: string;
	readonly rank: number;
}

export const PRINCIPAL_RANK_USER = CANONICAL_ROLE_RANK.USER;
export const PRINCIPAL_RANK_ADMIN = CANONICAL_ROLE_RANK.ADMIN;

function principalRank(role: string): number {
	// Unknown strings rank 0 — below GUEST — so unresolved principals can
	// never pass a floor. Lookup, not an identity assertion.
	return CANONICAL_ROLE_RANK[role as keyof typeof CANONICAL_ROLE_RANK] ?? 0;
}

export async function resolveMessagePrincipalRole(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<MessagePrincipalAdmission> {
	if (message.entityId === runtime.agentId) {
		return { role: "OWNER", rank: principalRank("OWNER") };
	}
	try {
		const result = await checkSenderRole(runtime, message);
		// No resolvable world/room: apply the shared local-sender floor so
		// local/API/harness traffic keeps its historical USER behavior while
		// unknown connector senders stay GUEST (roles.ts convention).
		const role = result?.role ?? getUnresolvedSenderRoleFloor(message);
		return { role, rank: principalRank(role) };
	} catch (error) {
		// error-policy:J4 A role-resolution FAILURE must surface as a visible
		// denial, never as a thrown error that could skip the gate or crash
		// the turn. Unlike a clean no-world lookup (which may keep the
		// trusted local-source floor), an exception means the authorization
		// system itself is unhealthy: fail closed to an unresolvable
		// principal ranked below every tier — never the local-sender USER
		// floor, which would authorize sends during an outage.
		logger.warn(
			`[SendConsent] principal role resolution failed: ${String(error)}`,
		);
		return { role: "UNRESOLVED", rank: principalRank("UNRESOLVED") };
	}
}
