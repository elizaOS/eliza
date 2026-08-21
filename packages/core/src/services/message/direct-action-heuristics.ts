/**
 * Pre-model heuristics that decide which registered actions a raw message should
 * directly trigger: local-shell inspection, web/live-info lookup, coding-task
 * delegation, settings writes, and views/app navigation. Each detector fires on
 * clear intent, honors explicit negations, and resolves action names structurally
 * by canonical name, simile, or tag — so a runtime missing a given backend action
 * simply yields no candidate. Also derives a concrete shell command or web-search
 * query from the message text.
 */
import { isReservedNonToolActionName } from "../../action-names";
import type { Action } from "../../types/components";

export interface DirectActionInferenceHooks {
	looksLikeCodingWorkRequest?: (text: string) => boolean;
	findCodingDelegationActionName?: (
		actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
	) => string | undefined;
}

function unwrapPlannerIdentifier(value: string): string {
	const safe = value.length > 10_000 ? value.slice(0, 10_000) : value;
	const trimmed = safe
		.trim()
		.replace(/^(?:[-*]|\d+[.)])\s+/, "")
		.replace(/^["'`]+|["'`]+$/g, "");
	if (!trimmed) {
		return "";
	}

	const tagMatch = trimmed.match(/^<([A-Z0-9_:-]+)>$/i);
	if (tagMatch) {
		return tagMatch[1];
	}

	return trimmed;
}

export function normalizeActionIdentifier(actionName: string): string {
	return unwrapPlannerIdentifier(actionName).toUpperCase().replace(/_/g, "");
}

function looksLikeActionExplanationRequest(text: string): boolean {
	const normalized = text.toLowerCase().replace(/\s+/gu, " ").trim();
	const asksForExplanation =
		/\b(?:explain|describe|teach|walk\s+me\s+through|what\s+does|what\s+is|how\s+(?:does|do|to)|why)\b/iu.test(
			normalized,
		) ||
		/\b(?:can\s+you\s+)?tell\s+me\s+(?:about|what|why|how)\b/iu.test(
			normalized,
		);
	if (!asksForExplanation) {
		return false;
	}

	const asksToExecuteAfterExplanation =
		/\b(?:and|then|also|after(?:wards)?|next)\s+(?:please\s+)?(?:run|execute)\b/iu.test(
			normalized,
		) ||
		/\b(?:run|execute)\b.*\b(?:after|once)\s+(?:you\s+)?(?:explain|describe|teach|walk\s+me\s+through)\b/iu.test(
			normalized,
		);

	return !asksToExecuteAfterExplanation;
}

export function looksLikeLocalShellRequest(text: string): boolean {
	const normalized = text.toLowerCase();
	if (!normalized.trim()) {
		return false;
	}

	if (
		/\b(?:do not|don't|dont|without)\s+(?:run|execute|use)\s+(?:commands?|shell|terminal)\b/iu.test(
			normalized,
		)
	) {
		return false;
	}

	if (looksLikeActionExplanationRequest(normalized)) {
		return false;
	}

	const mentionsCommand =
		/\b(?:git|df|du|ls|pwd|cat|sed|awk|rg|grep|curl|ps|systemctl|journalctl|docker|bun|npm|node|sqlite3|gh|submodules?|disk (?:space|usage)|storage usage|health endpoint|api\/health|ready status|plugins?|ram|memory|uptime|utc time|server time)\b/iu.test(
			normalized,
		);
	const asksToInspect =
		/\b(?:run|execute|check|inspect|show|list|print|tail|look(?:\s+at)?|read|verify)\b/iu.test(
			normalized,
		);
	const mentionsLocalSurface =
		/(?:^|\s)(?:\/home\/|~\/|\.\/|\.\.\/)/u.test(normalized) ||
		/\b(?:this vps|local(?:ly)?|server|workspace|worktree|repo|repository|branch|head|vendored|submodules?|origin\/(?:develop|main|master)|git status|disk (?:space|usage)|storage usage|health endpoint|api\/health|ready status|plugins?|ram|memory|uptime|utc time|server time|logs?|service|systemd)\b/iu.test(
			normalized,
		);
	const asksRepoStateQuestion =
		/\b(?:is|are|what|which|where)\b[^.?!\n]{0,80}\b(?:submodules?|commit|branch|head|checked\s+out|worktree|repo|repository)\b/iu.test(
			normalized,
		) &&
		/\b(?:local(?:ly)?|running|workspace|worktree|repo|repository|vendored|submodules?|checked\s+out)\b/iu.test(
			normalized,
		);
	const asksLocalStatusQuestion =
		/\b(?:check|inspect|show|summarize|what|how\s+much|is|are)\b[\s\S]{0,160}\b(?:health endpoint|api\/health|ready status|plugins?|ram|memory|uptime|utc time|server time)\b/iu.test(
			normalized,
		) &&
		/\b(?:local|server|bot|runtime|right now|current|ready)\b/iu.test(
			normalized,
		);
	const asksLocalSourceInspection =
		/\b(?:does|do|is|are|can|could|check|verify|inspect|show)\b[\s\S]{0,160}\b(?:local|vendored|workspace|worktree|repo|repository|submodules?)\b[\s\S]{0,160}\b(?:include|contain|have|support|implement|detect|use)\b/iu.test(
			normalized,
		) &&
		/\b(?:local|vendored|workspace|worktree|repo|repository|submodules?)\b/iu.test(
			normalized,
		);

	return (
		(mentionsCommand && asksToInspect && mentionsLocalSurface) ||
		asksRepoStateQuestion ||
		asksLocalStatusQuestion ||
		asksLocalSourceInspection
	);
}

const URL_TOKEN_PATTERN = /\bhttps?:\/\/[^\s<>()]+/giu;

/** Connector-appended link-preview blocks (Discord renders shared-link embeds
 * into the processed text as "Embed #N:\n  Title:…\n  Description:…"). Preview
 * text is DERIVED from the linked page — it is never a user instruction, so
 * intent detection must not read it as one. The header tail must stay on
 * `[ \t]*`: a `\s*` there greedily eats the newline plus the next line's
 * indent, so the indented Title/Description lines never match and page-derived
 * text leaks into the residue. */
const LINK_EMBED_BLOCK_PATTERN =
	/(?:^|\n)[ \t]*Embed #\d+:[ \t]*(?:\n[ \t]+[^\n]*)*/giu;

/** Explicitly conversational or reactive residue patterns — short commentary
 * that does NOT carry a work directive aimed at the agent. These are the ONLY
 * non-empty residue shapes that are passive link shares; any other non-empty
 * residue is treated as a potential work order. The set is deliberately narrow
 * and must not be extended with imperatives like "review" or "audit". */
const LINK_SHARE_CONVERSATIONAL_RESIDUE_PATTERN =
	/^(?:lol|lmao|nice|cool|wow|neat|huh|hmm|whoa|ok|okay|k|ty|thx|thanks|interesting|wowza|dope|sick|amazing|crazy|insane|funny|wild|fire|check this out|check it out|check this|look at this|look at this|look at that|thoughts|thoughts\?|any thoughts|any thoughts\?|thoughts on this|what do you think|wdyt|wdyt\?|see this|seen this|anyone seen this|thoughts on this one|fwd|fyi|tbh|imo|nvm|rip|omg|oh no|oof|rip|wtf|smh|gg|ngl)\s*[.!?]*$/iu;

/**
 * True when a message is essentially just a shared link: one or more URLs,
 * optionally with connector-derived embed preview text, and at most a short
 * remainder that is empty or explicitly conversational/reactive (no work
 * directive aimed at the agent).
 *
 * A shared link is content, not a work order (observed live: a bare URL whose
 * embed title happened to contain workflow-ish words spawned a coding
 * sub-agent with an empty derived task). Link shares route to the web-read
 * light path — fetch and react to the page, or acknowledge from the embed
 * metadata when the page is not readable — never to coding delegation.
 *
 * Detection is intentionally conservative: only empty or explicitly
 * conversational residue is a bare share. Any other non-empty residue —
 * including imperatives absent from any English allowlist (review, audit,
 * investigate) and non-English work orders — is left to ordinary routing.
 */
export function looksLikeBareLinkShare(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	const withoutEmbeds = trimmed.replace(LINK_EMBED_BLOCK_PATTERN, " ");
	const urls = withoutEmbeds.match(URL_TOKEN_PATTERN);
	if (!urls || urls.length === 0) return false;
	let residue = withoutEmbeds;
	for (const url of urls) {
		residue = residue.replace(url, " ");
	}
	residue = residue
		.replace(/[|<>*_~`"()'[\]{}.,:;!?@#-]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	// A substantial remainder means the user actually said something; ordinary
	// routing applies.
	if (residue.length > 120) return false;
	// Empty residue after removing URLs and embed previews: a bare link share.
	if (residue.length === 0) return true;
	// Short residue that is explicitly conversational/reactive (no directive
	// aimed at the agent): still a bare share.
	return LINK_SHARE_CONVERSATIONAL_RESIDUE_PATTERN.test(residue);
}

/**
 * The user's OWN words in a link-share message: connector-derived embed
 * preview blocks and the URLs themselves removed, original punctuation kept.
 * Lets delivery seams distinguish "here's a link" from "here's a link — does
 * it do X?" without re-deriving the connector text shape (a bare share and a
 * short question both route to the web-read light path, but they want
 * different answer styles).
 */
export function linkShareOwnText(text: string): string {
	return text
		.trim()
		.replace(LINK_EMBED_BLOCK_PATTERN, " ")
		.replace(URL_TOKEN_PATTERN, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

const WEB_SEARCH_NEGATION_PATTERN =
	/\b(?:(?:do\s+not|don['’]?t|never(?!\s+mind\b))\b[^.!?;]{0,64}\b(?:google\b|(?:browse|search|look\s+up|use)\s+(?:the\s+)?(?:(?:live|current)\s+)?(?:web|internet|prices?)\b)|without\b[^.!?;]{0,32}\b(?:brows(?:e|ing)|search(?:ing)?|look(?:ing)?\s+up|us(?:e|ing))\s+(?:the\s+)?(?:(?:live|current)\s+)?(?:web|internet|prices?)\b)/iu;
const EXPLICIT_WEB_SEARCH_PATTERN =
	/\b(?:search\s+(?:the\s+)?(?:live\s+)?web|web\s+search|search\s+online|look\s+up|lookup|google|browse\s+(?:the\s+)?(?:live\s+)?web|search\s+(?:the\s+)?internet)\b/iu;
const EXPLICIT_URL_FETCH_PATTERN =
	/\b(?:fetch|read|retrieve|load|open|visit|summari[sz]e)\b[^\n]{0,160}https:\/\/[^\s<>"']+/iu;
function intentClauses(text: string): string[] {
	const value = text.toLowerCase();
	const clauses: string[] = [];
	let start = 0;
	let cursor = 0;
	while (cursor < value.length) {
		let width = value[cursor] === ";" ? 1 : 0;
		if (width === 0) {
			for (const word of ["but", "however", "instead"]) {
				if (
					value.startsWith(word, cursor) &&
					(cursor === 0 || !/[a-z0-9_]/i.test(value[cursor - 1])) &&
					!/[a-z0-9_]/i.test(value[cursor + word.length] ?? "")
				) {
					width = word.length;
					break;
				}
			}
		}
		if (width === 0) {
			cursor += 1;
			continue;
		}
		const clause = value.slice(start, cursor).trim();
		if (clause) clauses.push(clause);
		start = cursor + width;
		cursor = start;
	}
	const tail = value.slice(start).trim();
	if (tail) clauses.push(tail);
	return clauses;
}

function quotedSpanContains(
	text: string,
	predicate: (span: string) => boolean,
): boolean {
	for (const [open, close] of [
		['"', '"'],
		["“", "”"],
		["‘", "’"],
	] as const) {
		let cursor = 0;
		while (cursor < text.length) {
			const start = text.indexOf(open, cursor);
			if (start < 0) break;
			const end = text.indexOf(close, start + open.length);
			if (end < 0) break;
			if (predicate(text.slice(start + open.length, end))) return true;
			cursor = end + close.length;
		}
	}
	let cursor = 0;
	while (cursor < text.length) {
		const start = text.indexOf("'", cursor);
		if (start < 0) break;
		const end = text.indexOf("'", start + 1);
		if (end < 0) break;
		const before = text[start - 1];
		const after = text[end + 1];
		if (
			(!before || !/[\p{L}\p{N}]/u.test(before)) &&
			(!after || !/[\p{L}\p{N}]/u.test(after)) &&
			predicate(text.slice(start + 1, end))
		) {
			return true;
		}
		// An apostrophe inside a contraction is not an opening quote. Advance one
		// delimiter so a later real opening quote is still considered.
		cursor = start + 1;
	}
	return false;
}

function explicitlyAsksWebSearch(text: string): boolean {
	return intentClauses(text).some(
		(clause) =>
			!WEB_SEARCH_NEGATION_PATTERN.test(clause) &&
			EXPLICIT_WEB_SEARCH_PATTERN.test(clause),
	);
}

export function looksLikeWebSearchRequest(text: string): boolean {
	const asksCurrentInfo =
		/\b(?:current|currently|latest|live|real[- ]?time|right now|today|now|rn|atm|up[- ]?to[- ]?date)\b/iu;
	const mentionsMarketOrNews =
		/\b(?:price|prices|quote|btc|bitcoin|eth|ethereum|stock|stocks?|ticker|market|markets?|exchange rate|news|headline|headlines|weather)\b/iu;
	return intentClauses(text).some(
		(clause) =>
			!WEB_SEARCH_NEGATION_PATTERN.test(clause) &&
			(EXPLICIT_WEB_SEARCH_PATTERN.test(clause) ||
				EXPLICIT_URL_FETCH_PATTERN.test(clause) ||
				(asksCurrentInfo.test(clause) && mentionsMarketOrNews.test(clause))),
	);
}

export function findAvailableActionName(
	actions: ReadonlyArray<Pick<Action, "name" | "similes">>,
	names: readonly string[],
): string | undefined {
	// Resolve in `names` PRIORITY order, not action-registration order: for each
	// wanted name in turn, return the first action whose name or simile matches.
	// The leading preference wins regardless of registration order.
	for (const want of names) {
		const wanted = normalizeActionIdentifier(want);
		const match = actions.find((action) => {
			if (normalizeActionIdentifier(action.name) === wanted) return true;
			const similes = Array.isArray(action.similes) ? action.similes : [];
			return similes.some(
				(simile) => normalizeActionIdentifier(String(simile)) === wanted,
			);
		});
		if (match) return match.name;
	}
	return undefined;
}

export const CODING_DELEGATION_ACTION_TAGS = [
	"domain:coding",
	"resource:agent-task",
	"capability:delegate",
] as const;

export const LEGACY_CODING_DELEGATION_ACTION_NAMES = [
	"TASKS",
	"TASKS_SPAWN_AGENT",
	"SPAWN_AGENT",
	"START_CODING_TASK",
	"CODE_TASK",
	"SPAWN_CODING_AGENT",
] as const;

// Declared-tag contract for the shell-direct behavior class: an action an owner
// plugin exposes to run a single explicit user-provided shell command directly
// (the SHELL/terminal action). Owner plugins should migrate to declaring these
// tags so the core message pipeline stops duck-typing shell-direct routing off
// a brittle hardcoded name list. Resolved tags-first, then the legacy name set
// below as a covered compatibility fallback — mirrors CODING_DELEGATION.
export const SHELL_DIRECT_ACTION_TAGS = [
	"domain:system",
	"resource:shell",
	"capability:execute",
] as const;

// Legacy name/simile fallback for shell-direct resolution. Kept ONLY as a
// covered compatibility path for owner actions that have not yet declared
// SHELL_DIRECT_ACTION_TAGS. Do not extend — add the tags to the owning action
// instead. Priority order: the canonical action name first, then similes.
export const LEGACY_SHELL_DIRECT_ACTION_NAMES = [
	"SHELL",
	"TERMINAL_SHELL",
	"RUN_IN_TERMINAL",
	"RUN_COMMAND",
	"EXECUTE_COMMAND",
	"TERMINAL",
	"RUN_SHELL",
	"EXEC",
] as const;

export function hasActionTags(
	action: Pick<Action, "tags">,
	requiredTags: readonly string[],
): boolean {
	const tags = new Set((action.tags ?? []).map((tag) => tag.toLowerCase()));
	return requiredTags.every((tag) => tags.has(tag));
}

export function findCodingDelegationActionName(
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
): string | undefined {
	return (
		actions.find((action) =>
			hasActionTags(action, CODING_DELEGATION_ACTION_TAGS),
		)?.name ??
		findAvailableActionName(actions, LEGACY_CODING_DELEGATION_ACTION_NAMES)
	);
}

// Resolve the registered shell-direct action, tags-first then legacy names — the
// single source of truth for shell-direct routing decisions in the message
// pipeline. Returns the resolved action's canonical name so callers can compare
// candidate lists against a live action rather than a hardcoded literal set.
export function findShellDirectActionName(
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
): string | undefined {
	return (
		actions.find((action) => hasActionTags(action, SHELL_DIRECT_ACTION_TAGS))
			?.name ??
		findAvailableActionName(actions, LEGACY_SHELL_DIRECT_ACTION_NAMES)
	);
}

// True when `actionName` is the shell-direct behavior class, resolved against the
// live action set: an action declaring SHELL_DIRECT_ACTION_TAGS, or (legacy
// fallback) one whose name/simile is in LEGACY_SHELL_DIRECT_ACTION_NAMES. When
// no action set is available, falls back to the legacy name membership so pure
// name-list call sites keep working during migration.
export function isShellDirectActionName(
	actionName: string,
	actions?: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
): boolean {
	const normalized = normalizeActionIdentifier(actionName);
	if (!normalized) return false;
	if (actions && actions.length > 0) {
		const shellActionName = findShellDirectActionName(actions);
		if (!shellActionName) return false;
		return normalizeActionIdentifier(shellActionName) === normalized;
	}
	return LEGACY_SHELL_DIRECT_ACTION_NAMES.some(
		(name) => normalizeActionIdentifier(name) === normalized,
	);
}

/**
 * Which detector produced a direct-current-request candidate inference. Lets
 * callers weigh the EVIDENCE STRENGTH of an inferred (never model-emitted)
 * candidate:
 * - "shell" / "coding" / "settings-write" / "web": explicit intent phrasing
 *   in the message.
 * - "owner-goals": concrete owner goal create/save/confirm phrasing.
 * - "owner-routines": habit/routine commitment phrasing, including recurring
 *   cadences ("3 times a day") — an owner mutation, never navigation.
 * - "owner-scheduled-admin": snooze/reschedule/skip verbs acting on an
 *   existing scheduled item — owner mutations that navigation cannot satisfy.
 * - "owner-reads": a possessive owner-data read ("list my personal todos",
 *   "what are my reminders") — the read-side mirror of the mutation rule
 *   above: data asks are owner-domain evidence, and VIEWS can only navigate,
 *   so a registered owner reader outranks the view-capability overlap.
 * - "view-surface": an operation verb PLUS an explicit UI-surface noun
 *   (view/window/panel/app/screen/ui) — strong navigation evidence.
 * - "view-navigation": the message is nothing but a bare registered surface
 *   name ("settings") — the voice-transcription navigation contract (#9950).
 * - "view-capability": a navigation-shaped message whose tokens cover a views
 *   action's tag/simile phrase ("get my screen time" covering screen-time).
 *   Still the weakest evidence — an earlier variant that matched partial
 *   phrases hijacked already-answered trivial chat turns into a required-tool
 *   planner deadlock (trajectories tj-501e594bfb23a7, tj-5d1c9601f33e8d).
 */
export type DirectCurrentRequestCandidateKind =
	| "shell"
	| "coding"
	| "settings-write"
	| "owner-goals"
	| "owner-routines"
	| "owner-reads"
	| "owner-scheduled-admin"
	| "owner-work-thread"
	| "media-generation"
	| "view-surface"
	| "view-navigation"
	| "view-capability"
	| "web";

export interface DirectCurrentRequestCandidateInference {
	names: string[];
	kind: DirectCurrentRequestCandidateKind | null;
}

const EMPTY_DIRECT_CANDIDATE_INFERENCE: DirectCurrentRequestCandidateInference =
	{ names: [], kind: null };

// Owner routine/habit surface, in preference order. Matches the personal
// assistant's OWNER_ROUTINES action by name or by its declared similes
// (findAvailableActionName matches either), so runtimes exposing only a
// legacy habit action still resolve.
const OWNER_ROUTINES_ACTION_NAMES = [
	"OWNER_ROUTINES",
	"ROUTINES",
	"ROUTINE",
	"TRACK_HABIT",
	"CREATE_ROUTINE",
	"CREATE_HABIT",
	"DAILY_HABIT",
	"HABITS",
	"HABIT",
	"RECURRING_TASK",
] as const;

const OWNER_GOALS_ACTION_NAMES = [
	"OWNER_GOALS",
	"GOALS",
	"GOAL",
	"CREATE_GOAL",
	"SAVE_GOAL",
	"SET_GOAL",
	"SAVINGS_GOAL",
	"CREATE_SAVINGS_PLAN",
	"SAVINGS_PLAN",
	"TRIP_SAVINGS_PLAN",
	"TRAVEL_SAVINGS_PLAN",
] as const;

const SETTINGS_WRITE_ACTION_NAMES = [
	"SETTINGS",
	"UPDATE_SETTINGS",
	"CHANGE_SETTING",
	"SETTINGS_WRITE",
	"VOICE_SETTINGS",
] as const;

/**
 * Detects explicit mutations of the app's voice preferences. This is a narrow
 * Stage-1 backstop for models that correctly understand the intent but invent a
 * candidate name such as UPDATE_VOICE_SETTINGS, or incorrectly classify the
 * request as simple chat. It deliberately excludes navigation, explanations,
 * and negated writes; the semantic SETTINGS action still parses and validates
 * the concrete section/key/value.
 */
function looksLikeVoiceSettingsWriteRequest(text: string): boolean {
	const normalized = text.toLowerCase().replace(/\s+/gu, " ").trim();
	if (!normalized || looksLikeActionExplanationRequest(normalized)) {
		return false;
	}
	if (
		/\b(?:do not|don't|dont|never|without)\s+(?:change|update|set|turn|enable|disable|switch|make)\b/iu.test(
			normalized,
		)
	) {
		return false;
	}

	const hasMutation =
		/\b(?:change|update|set|turn|enable|disable|switch|make)\b/iu.test(
			normalized,
		);
	const hasVoicePreference =
		/\b(?:voice\s+(?:setting|settings|preference|preferences|config|configuration|silence)|continuous\s+(?:voice\s+)?chat|always[- ]on\s+(?:voice\s+)?mode|hands[- ]free\s+voice|end[- ]of[- ]turn\s+silence|speech\s+rms\s+threshold|voice\s+vad|vad\s+(?:setting|settings|silence|threshold))\b/iu.test(
			normalized,
		);
	return hasMutation && hasVoicePreference;
}

function findSettingsWriteActionName(
	actions: ReadonlyArray<Pick<Action, "name" | "similes">>,
): string | undefined {
	return findAvailableActionName(actions, SETTINGS_WRITE_ACTION_NAMES);
}

function looksLikeLearningGoalStart(text: string): boolean {
	if (
		!/\bi\s+(?:want|would\s+like|need|am\s+trying|hope)\s+to\s+learn\b/iu.test(
			text,
		)
	) {
		return false;
	}
	if (/\blearn\s+about\b/iu.test(text)) {
		return false;
	}
	return (
		/\b(?:goal|save|track|plan|practice|progress|check[- ]?in|deadline|by\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2})|times?\s+(?:a|per)\s+week|without\s+switching\s+to\s+english)\b/iu.test(
			text,
		) ||
		/\b(?:make|turn|set|create|add)\b[\s\S]{0,80}\b(?:goal|learning\s+goal)\b/iu.test(
			text,
		)
	);
}

function looksLikeGoalDetailFollowup(text: string): boolean {
	const mentionsFrequency =
		/\b(?:\d+|one|two|three|four|five|six|seven)\s+times?\s+(?:a|per)\s+week\b/iu.test(
			text,
		);
	return (
		(/\bcount\s+it\s+if\b/iu.test(text) &&
			(mentionsFrequency ||
				/\bnext\s+\d+\s+weeks?\b/iu.test(text) ||
				/\bwalk\s+around\s+the\s+block\b/iu.test(text))) ||
		(/\b(?:let'?s\s+)?define\s+success\s+as\b/iu.test(text) &&
			(mentionsFrequency ||
				/\bby\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2})\b/iu.test(
					text,
				) ||
				/\bwithout\s+switching\s+to\s+english\b/iu.test(text)))
	);
}

function looksLikeGoalDraftConfirmation(text: string): boolean {
	return /\b(?:ok(?:ay)?|yes|yep|yeah|sure)?\s*(?:save|set|confirm|approve)\s+(?:that|this|it|that\s+one|this\s+one)(?:\s+goal)?\b/iu.test(
		text,
	);
}

function looksLikeOwnerGoalWriteRequest(text: string): boolean {
	const normalized = text.toLowerCase();
	if (!normalized.trim()) {
		return false;
	}
	if (
		looksLikeLearningGoalStart(normalized) ||
		looksLikeGoalDetailFollowup(normalized) ||
		looksLikeGoalDraftConfirmation(normalized)
	) {
		return true;
	}
	if (
		/\b(?:what|how|why|when|where)\b[\s\S]{0,80}\b(?:goal|goals|saving|savings|trip|fitness|learn|learning|sleep)\b/iu.test(
			normalized,
		) &&
		!/\b(?:set|create|add|save|track|make|turn|store)\b/iu.test(normalized)
	) {
		return false;
	}

	const explicitGoalWrite =
		/\b(?:set|create|add|save|track|make|turn|store)\b[\s\S]{0,120}\b(?:goal|goals|savings?\s+plan|trip\s+savings|travel\s+savings)\b/iu.test(
			normalized,
		) ||
		/\b(?:goal|goals|savings?\s+plan|trip\s+savings|travel\s+savings)\b[\s\S]{0,120}\b(?:set|create|add|save|track|make|store)\b/iu.test(
			normalized,
		);
	if (explicitGoalWrite) {
		return true;
	}

	const hasGoalDomain =
		/\b(?:goal|goals|save\s+money|saving|savings|trip|travel|fitness|5k|learn|learning|spanish|sleep)\b/iu.test(
			normalized,
		);
	const hasConcreteTarget =
		/(?:[$€£]\s?\d|\b\d+(?:,\d{3})*(?:\.\d+)?\s?(?:dollars?|usd|eur|gbp|miles?|km|kilometers?|hours?|minutes?)\b)/iu.test(
			normalized,
		);
	const hasDeadlineOrSupport =
		/\b(?:by|before|deadline|march|april|may|june|july|august|september|october|november|december|january|february|check[- ]?in|transfer|paycheck|fall behind|falling behind|progress)\b/iu.test(
			normalized,
		);
	const hasOwnerUpdateVerb =
		/\b(?:make|set|save|create|track|add|turn|store)\b/iu.test(normalized);

	return (
		hasGoalDomain &&
		hasOwnerUpdateVerb &&
		(hasConcreteTarget || hasDeadlineOrSupport)
	);
}

function findOwnerGoalsActionName(
	actions: ReadonlyArray<Pick<Action, "name" | "similes">>,
): string | undefined {
	return findAvailableActionName(actions, OWNER_GOALS_ACTION_NAMES);
}

/**
 * Detects an owner commitment to a recurring habit/routine — the phrasing that
 * live hijacked into a VIEWS catalog dump ("25 pushups, 3 times a day …",
 * #17028). Three legs: an explicit recurring cadence ("N times a day/week"),
 * a habit/routine noun coupled with a write verb, or a recurring reminder ask.
 * Advice questions ("how many times a day should I …") are excluded so the
 * detector never converts an information ask into a mutation candidate.
 */
function looksLikeOwnerRoutineWriteRequest(text: string): boolean {
	const normalized = text.toLowerCase().replace(/\s+/gu, " ").trim();
	if (!normalized) return false;
	// A leading question word marks an advice/lookup ask, not a commitment.
	// "can/could you …" polite imperatives are deliberately NOT excluded.
	if (
		/^\s*(?:what|whats|what's|how|why|when|where|is|are|does|should)\b/iu.test(
			normalized,
		)
	) {
		return false;
	}
	const hasRecurringCadence =
		/\b\d+\s+times?\s+(?:a|per|each|every)\s+(?:day|week|month)\b/iu.test(
			normalized,
		) ||
		/\b(?:every|each)\s+(?:day|morning|evening|night|week(?:day)?)\b/iu.test(
			normalized,
		) ||
		/\b(?:daily|weekly)\b/iu.test(normalized);
	if (
		/\b\d+\s+times?\s+(?:a|per|each|every)\s+(?:day|week|month)\b/iu.test(
			normalized,
		)
	) {
		return true;
	}
	const hasRoutineNoun = /\b(?:habit|routine)s?\b/iu.test(normalized);
	const hasWriteVerb =
		/\b(?:track|start|create|add|set\s+up|save|log|schedule|build|make)\b/iu.test(
			normalized,
		);
	if (hasRoutineNoun && hasWriteVerb) return true;
	if (
		/\bremind\s+me\b/iu.test(normalized) &&
		(hasRecurringCadence || hasRoutineNoun)
	) {
		return true;
	}
	return hasRecurringCadence && /\bschedule\b/iu.test(normalized);
}

function findOwnerRoutinesActionName(
	actions: ReadonlyArray<Pick<Action, "name" | "similes">>,
): string | undefined {
	return findAvailableActionName(actions, OWNER_ROUTINES_ACTION_NAMES);
}

type ScheduledAdminDomain =
	| "reminders"
	| "alarms"
	| "routines"
	| "scheduled-tasks"
	| "calendar-events";

const SCHEDULED_ADMIN_VERB_PATTERN =
	/(?:^|[^\p{L}\p{N}\p{M}])(?:snooze|reschedule|postpone|unsnooze|skip|delete|remove|cancel|clear|(?:get\s+rid\s+of)|(?:stop\s+tracking))(?=$|[^\p{L}\p{N}\p{M}])/iu;
const SCHEDULED_ADMIN_ALARM_PATTERN =
	/(?:^|[^\p{L}\p{N}\p{M}])alarms?(?=$|[^\p{L}\p{N}\p{M}])/iu;
const SCHEDULED_ADMIN_STRUCTURAL_PATTERN =
	/(?:^|[^\p{L}\p{N}\p{M}])(?:check[- ]?ins?|follow[- ]?ups?)(?=$|[^\p{L}\p{N}\p{M}])/iu;
const SCHEDULED_ADMIN_ROUTINE_PATTERN =
	/(?:^|[^\p{L}\p{N}\p{M}])(?:routines?|habits?)(?=$|[^\p{L}\p{N}\p{M}])/iu;
const SCHEDULED_ADMIN_RAW_TASK_PATTERN =
	/(?:^|[^\p{L}\p{N}\p{M}])scheduled\s+tasks?(?=$|[^\p{L}\p{N}\p{M}])/iu;
const SCHEDULED_ADMIN_TASK_PATTERN =
	/(?:^|[^\p{L}\p{N}\p{M}])tasks?(?=$|[^\p{L}\p{N}\p{M}])/iu;
const SCHEDULED_ADMIN_TEMPORAL_VERB_PATTERN =
	/(?:^|[^\p{L}\p{N}\p{M}])(?:snooze|reschedule|postpone|unsnooze)(?=$|[^\p{L}\p{N}\p{M}])/iu;
const SCHEDULED_ADMIN_REMINDER_PATTERN =
	/(?:^|[^\p{L}\p{N}\p{M}])reminders?(?=$|[^\p{L}\p{N}\p{M}])/iu;
// Calendar-event mutations also arrive as "move/push/bump/shift X to <time>",
// verbs the shared admin set deliberately omits (they are too ambiguous
// without a calendar noun anchoring them).
const SCHEDULED_ADMIN_CALENDAR_MOVE_VERB_PATTERN =
	/(?:^|[^\p{L}\p{N}\p{M}])(?:move|push|bump|shift)(?=$|[^\p{L}\p{N}\p{M}])/iu;
const SCHEDULED_ADMIN_CALENDAR_NOUN_PATTERN =
	/(?:^|[^\p{L}\p{N}\p{M}])(?:calendar|events?|meetings?|appointments?|lunch(?:es)?|dinners?|breakfasts?|brunch(?:es)?|coffees?|reservations?)(?=$|[^\p{L}\p{N}\p{M}])/iu;

const SCHEDULED_ADMIN_ACTION_NAMES_BY_DOMAIN: Record<
	ScheduledAdminDomain,
	readonly string[]
> = {
	reminders: ["OWNER_REMINDERS", "REMINDERS", "REMINDER"],
	alarms: ["OWNER_ALARMS", "ALARMS", "ALARM"],
	routines: OWNER_ROUTINES_ACTION_NAMES,
	"scheduled-tasks": ["SCHEDULED_TASKS"],
	"calendar-events": ["CALENDAR"],
};

/**
 * Detects admin operations on an existing scheduled item and preserves the
 * owning action boundary. Reminder, alarm, and routine definitions use their
 * owner surfaces; structural check-ins, follow-ups, and raw scheduled tasks use
 * SCHEDULED_TASKS. A bare "skip this task" remains ambiguous and yields no
 * deterministic candidate.
 */
function detectScheduledItemAdminDomain(
	text: string,
): ScheduledAdminDomain | null {
	const normalized = text.toLowerCase().replace(/\s+/gu, " ").trim();
	if (!normalized || looksLikeActionExplanationRequest(normalized)) {
		return null;
	}
	const sharedAdminVerb = SCHEDULED_ADMIN_VERB_PATTERN.test(normalized);
	// A calendar noun admits the move-verb family the shared set omits.
	// Live regression: "move the lunch with dana to friday 1pm" got NO
	// deterministic candidate, Stage-1 answered ["simple"] from stale room
	// history ("was never on the calendar" — no tool ran) and fabricated a
	// calendar-state claim. The mutation must reach the CALENDAR surface,
	// which reads real state before acting.
	const calendarMutation =
		SCHEDULED_ADMIN_CALENDAR_NOUN_PATTERN.test(normalized) &&
		(sharedAdminVerb ||
			SCHEDULED_ADMIN_CALENDAR_MOVE_VERB_PATTERN.test(normalized));
	if (!sharedAdminVerb && !calendarMutation) {
		return null;
	}
	if (SCHEDULED_ADMIN_ALARM_PATTERN.test(normalized)) return "alarms";
	if (SCHEDULED_ADMIN_STRUCTURAL_PATTERN.test(normalized)) {
		return "scheduled-tasks";
	}
	if (SCHEDULED_ADMIN_ROUTINE_PATTERN.test(normalized)) return "routines";
	if (SCHEDULED_ADMIN_RAW_TASK_PATTERN.test(normalized)) {
		return "scheduled-tasks";
	}
	if (
		SCHEDULED_ADMIN_TASK_PATTERN.test(normalized) &&
		SCHEDULED_ADMIN_TEMPORAL_VERB_PATTERN.test(normalized)
	) {
		return "scheduled-tasks";
	}
	if (SCHEDULED_ADMIN_REMINDER_PATTERN.test(normalized)) return "reminders";
	if (calendarMutation) return "calendar-events";
	return null;
}

function findScheduledAdminActionName(
	actions: ReadonlyArray<Pick<Action, "name" | "similes">>,
	domain: ScheduledAdminDomain,
): string | undefined {
	return findAvailableActionName(
		actions,
		SCHEDULED_ADMIN_ACTION_NAMES_BY_DOMAIN[domain],
	);
}

const MEDIA_GENERATION_ACTION_NAMES = [
	"GENERATE_MEDIA",
	"GENERATE_IMAGE",
	"CREATE_IMAGE",
] as const;

/**
 * Detects an explicit media-generation ask ("make me a pixel-art castle
 * image", "generate a picture of a lighthouse"). Live regression (matrix
 * F35, tj-fcf8c1c21be91f): Stage-1 classified a styled image ask as
 * ["simple"] with no candidates, the planner ran with HANDLE_RESPONSE only,
 * and the model declared "I don't have an image generator" — an hour after
 * the same runtime generated and delivered one. Capability self-belief
 * follows tool exposure, so the deterministic candidate is what keeps the
 * answer consistent. Generation verbs must pair with a visual-artifact noun:
 * "create a todo" and "draw up a plan" never match.
 */
function looksLikeMediaGenerationRequest(text: string): boolean {
	const normalized = text.toLowerCase().replace(/\s+/gu, " ").trim();
	if (!normalized || looksLikeActionExplanationRequest(normalized)) {
		return false;
	}
	return /\b(?:generate|make|draw|create|render|paint|produce)\b[^.!?]{0,60}\b(?:image|picture|photo|art(?:work)?|illustration|logo|sticker|wallpaper|drawing|painting|meme|gif)s?\b/iu.test(
		normalized,
	);
}

function findMediaGenerationActionName(
	actions: ReadonlyArray<Pick<Action, "name" | "similes">>,
): string | undefined {
	return findAvailableActionName(actions, MEDIA_GENERATION_ACTION_NAMES);
}

const WORK_THREAD_ACTION_NAMES = [
	"WORK_THREAD",
	"OWNER_TASKS",
	"WORK_THREADS",
] as const;

/**
 * Detects an explicit work-thread lifecycle ask ("start a work thread: plan
 * the garage cleanout", "resume the kitchen reno work thread"). Live
 * regression (matrix F27, tj-ee16a14fea597e): Stage-1 classified the ask as
 * bare ["general"] with no candidates, the planner ran with HANDLE_RESPONSE
 * only, and the model composed a fictional surface refusal ("can't do that
 * here — dm me") — the same drift class as the owner-item delete leg. The
 * phrase "work thread" is the surface's own vocabulary, so the deterministic
 * candidate is precise.
 */
function looksLikeWorkThreadRequest(text: string): boolean {
	const normalized = text.toLowerCase().replace(/\s+/gu, " ").trim();
	if (!normalized || looksLikeActionExplanationRequest(normalized)) {
		return false;
	}
	return /\b(?:start|open|kick ?off|begin|resume|continue|pick (?:up|back up))\b[^.!?]{0,40}\bwork[- ]threads?\b/iu.test(
		normalized,
	);
}

function findWorkThreadActionName(
	actions: ReadonlyArray<Pick<Action, "name" | "similes">>,
): string | undefined {
	return findAvailableActionName(actions, WORK_THREAD_ACTION_NAMES);
}

/**
 * Detects a destructive owner-item operation ("delete the reminder named
 * water the ficus", "cancel the call marco reminder", "remove my dentist
 * alarm") and names the owning domain. Live regression (matrix F31,
 * tj-f02205ae366226 family): Stage-1 classified exact-name reminder deletes
 * as ["simple"] with no candidates, the turn planned with HANDLE_RESPONSE
 * only, and the model composed a fictional surface refusal ("can't delete
 * reminders here — dm me") that then self-reinforced through conversation
 * history. Deletes are owner mutations on existing data — the same
 * owner-domain-evidence rule as the other mutation legs — resolved
 * per-domain through the same preference lists the read leg uses.
 */
function detectOwnerItemDeleteDomain(text: string): OwnerLifeReadDomain | null {
	const normalized = text.toLowerCase().replace(/\s+/gu, " ").trim();
	if (!normalized || looksLikeActionExplanationRequest(normalized)) {
		return null;
	}
	// Surface-noun asks stay with the navigation legs ("close the reminders
	// tab" is view work, not a data mutation).
	if (
		/\b(?:view|views|page|screen|tab|panel|window|ui|dashboard|app)\b/iu.test(
			normalized,
		)
	) {
		return null;
	}
	if (
		!/\b(?:delete|remove|cancel|clear|get\s+rid\s+of|stop\s+tracking)\b/iu.test(
			normalized,
		)
	) {
		return null;
	}
	for (const [domain, noun] of OWNER_READ_DOMAIN_NOUNS) {
		// Finance records have no named-item delete surface; "clear my
		// spending" is not an item deletion.
		if (domain === "finances") continue;
		if (noun.test(normalized)) return domain;
	}
	return null;
}

/**
 * Owner-life domains with a possessive read shape. Each maps to its reader
 * surface in preference order: the personal-assistant umbrella first, then the
 * standalone domain plugin's action names, so lean stacks (one todo owner per
 * deployment) resolve their reader too.
 */
type OwnerLifeReadDomain =
	| "todos"
	| "goals"
	| "reminders"
	| "routines"
	| "alarms"
	| "finances";

const BLOCKED_OWNER_LIFE_READ = Symbol("blocked-owner-life-read");

const OWNER_READ_ACTION_NAMES_BY_DOMAIN: Record<
	OwnerLifeReadDomain,
	readonly string[]
> = {
	todos: ["OWNER_TODOS", "TODOS", "TODO", "TODO_LIST", "LIST_TODOS"],
	goals: OWNER_GOALS_ACTION_NAMES,
	reminders: ["OWNER_REMINDERS", "REMINDERS", "REMINDER", "LIST_REMINDERS"],
	routines: OWNER_ROUTINES_ACTION_NAMES,
	alarms: ["OWNER_ALARMS", "ALARMS", "ALARM"],
	finances: ["OWNER_FINANCES", "FINANCES"],
};

const OWNER_READ_DOMAIN_NOUNS: ReadonlyArray<[OwnerLifeReadDomain, RegExp]> = [
	["todos", /\b(?:todos?|to[- ]dos?|todo\s+list|task\s+list)\b/iu],
	["goals", /\bgoals?\b/iu],
	["reminders", /\breminders?\b/iu],
	["routines", /\b(?:routines?|habits?)\b/iu],
	["alarms", /\balarms?\b/iu],
	["finances", /\b(?:finances|budget|spending|expenses)\b/iu],
];

function ownerLifeReadDomainsInPossessiveScopes(
	normalized: string,
): Set<OwnerLifeReadDomain> {
	const domains = new Set<OwnerLifeReadDomain>();
	for (const match of normalized.matchAll(/\b(?:my|our)\b([^,;.!?]*)/giu)) {
		const rawScope = match[1] ?? "";
		const scope =
			rawScope.split(
				/\b(?:about|concerning|regarding|for|due|from|on|in|with|where|that|which|because)\b/iu,
				1,
			)[0] ?? "";
		// "Spending habits" names finance data; treating the trailing generic
		// habit noun as a routine would make registry order decide the surface.
		const domainScope = scope.replace(
			/\b(?:finance|financial|spending|expenses?)\s+habits?\b/giu,
			"finances",
		);
		for (const [domain, noun] of OWNER_READ_DOMAIN_NOUNS) {
			if (!noun.test(domainScope)) continue;
			// A noun-modified "budget" ("my keyboard budget", "my trip budget")
			// names a conversational figure the user told the agent, not the
			// owner finance ledger. Treating it as a finance read injected
			// OWNER_FINANCES on a group turn, its privacy rejection made the
			// whole turn a "private surface" denial, and a plain memory
			// question died (observed live: "whats my keyboard budget" →
			// denial while the $150 fact sat in room facts). Only an
			// unmodified budget mention — bare or with a finance-ish adjective
			// ("monthly", "overall") — counts as the finances domain.
			if (
				domain === "finances" &&
				/\b(?!(?:monthly|weekly|annual|yearly|overall|total|current|entire|whole|full|remaining)\b)[a-z][a-z-]*\s+budget\b/iu.test(
					domainScope,
				) &&
				!/\b(?:finances|spending|expenses)\b/iu.test(domainScope)
			) {
				continue;
			}
			domains.add(domain);
		}
	}
	return domains;
}

/**
 * Detects a possessive owner-data READ ("list my personal todos", "what are
 * my reminders for today") — the read-side mirror of the owner-mutation rule
 * (#17028 / fead478cfa): a data ask is owner-domain evidence, and VIEWS can
 * only navigate, so it must never degrade into the view-capability overlap
 * (live: "list my personal todos" routed to VIEWS view-disambiguation, then
 * failed on an undeclared get-todos capability). Explicit UI-surface nouns
 * stay with the navigation legs, and advice/organizing questions stay chat.
 */
function detectOwnerLifeReadDomain(
	text: string,
): OwnerLifeReadDomain | typeof BLOCKED_OWNER_LIFE_READ | null {
	const normalized = text.toLowerCase().replace(/\s+/gu, " ").trim();
	if (!normalized) return null;
	// Surface-noun asks are navigation, owned by the earlier view legs.
	if (
		/\b(?:view|views|page|screen|tab|panel|window|ui|dashboard|app)\b/iu.test(
			normalized,
		)
	) {
		return null;
	}
	// Quoted examples and metalinguistic discussion are not requests to open the
	// owner's finance ledger. This guard must run before the non-possessive money
	// detector because those examples intentionally contain its whole phrase.
	if (
		/\b(?:when|if)\s+(?:i|we)\s+say\b/iu.test(normalized) ||
		/\b(?:the\s+)?(?:phrase|sentence|wording|utterance|quote|quoted)\b/iu.test(
			normalized,
		) ||
		quotedSpanContains(normalized, (span) =>
			/\b(?:how much|what)\b/u.test(span),
		)
	) {
		return BLOCKED_OWNER_LIFE_READ;
	}
	// Money-spend questions are finance reads even without a possessive scope:
	// "how much did i spend this month" / "what did i spend on groceries" /
	// "how much have i spent" / "how much do i owe" all route to the finances
	// reader (observed live: "how much did i spend this month" mis-routed to
	// OWNER_GOALS and returned a life summary). Anchored to money-spend phrasing
	// to first-person amount/expense questions; common time, attention, and
	// obligation idioms remain conversational instead of opening private data.
	const moneyQuestion =
		/\b(?:how much(?: money)?|what) (?:did|have|do) i (spend|spent|pay|paid|owe)\b/iu.exec(
			normalized,
		);
	if (moneyQuestion) {
		const verb = moneyQuestion[1]?.toLowerCase();
		const tail = normalized.slice(
			(moneyQuestion.index ?? 0) + moneyQuestion[0].length,
		);
		const nonFinancialSpend =
			(verb === "spend" || verb === "spent") &&
			/^\s+(?:time|effort|energy)\b/iu.test(tail);
		const nonFinancialPay =
			(verb === "pay" || verb === "paid") &&
			/^\s+(?:attention|tribute|homage|respects?|heed)\b/iu.test(tail);
		const nonFinancialOwe =
			verb === "owe" &&
			/^\s+(?:(?:you|him|her|them|someone)\s+)?(?:an?\s+)?(?:apology|explanation|favor)\b/iu.test(
				tail,
			);
		if (!nonFinancialSpend && !nonFinancialPay && !nonFinancialOwe) {
			return "finances";
		}
	}
	const domains = ownerLifeReadDomainsInPossessiveScopes(normalized);
	if (domains.size === 0) return null;
	// Mutation shapes belong to the write detectors above (or the model);
	// "check off"/"mark ... done" are completions, not reads.
	if (
		/\b(?:add|create|set|save|track|make|store|delete|remove|cancel|clear|update|edit|rename|complete|finish|snooze|reschedule)\b/iu.test(
			normalized,
		) ||
		/\bcheck(?:ed)?\s+off\b/iu.test(normalized) ||
		/\bmark\b[\s\S]{0,40}\b(?:done|complete|off)\b/iu.test(normalized)
	) {
		return BLOCKED_OWNER_LIFE_READ;
	}
	// Advice, quoted examples, negated commands, and metalinguistic discussion
	// mention owner nouns without requesting the underlying private records.
	if (
		/\b(?:advice|tips?|suggestions?|recommendations?)\b/iu.test(normalized) ||
		/\bhow\s+to\b/iu.test(normalized) ||
		/\bhow\s+(?:do|can|could|should|would)\s+(?:i|we)\b/iu.test(normalized) ||
		/\b(?:how(?:\s+(?:do|can|could|should|would))?(?:\s+(?:i|we))?|ways?|methods?|approaches?|strategies?)\b[^.!?]{0,80}\b(?:organize|manage|track|plan|improve|handle|structure|prioritize|budget)\w*\b/iu.test(
			normalized,
		) ||
		/\b(?:what|which)\s+should\s+(?:i|we)\b/iu.test(normalized) ||
		/\b(?:help|teach|guide)\s+(?:me|us)\b/iu.test(normalized) ||
		/\b(?:when|if)\s+i\s+say\b/iu.test(normalized) ||
		/\b(?:the\s+)?(?:phrase|sentence|wording|utterance|quote|quoted)\b/iu.test(
			normalized,
		) ||
		quotedSpanContains(normalized, (span) => /\b(?:my|our)\b/u.test(span)) ||
		/\b(?:do\s+not|don['’]?t|never(?!\s+mind\b))\b(?:(?!\b(?:but|however|instead)\b)[^.!?;]){0,96}\b(?:list|show|tell|give|read|check|see|look|review|go\s+over)\b/iu.test(
			normalized,
		)
	) {
		return BLOCKED_OWNER_LIFE_READ;
	}
	const hasReadShape =
		/\b(?:list|show|what(?:'s|s| is| are)(?:\s+(?:on|in))?|do i have|have i got|any(?:thing)?\s+(?:on|in|left|due)|tell me|give me|read(?:\s+(?:me|out))?|check|see|look at|go over|review)\b/iu.test(
			normalized,
		);
	if (!hasReadShape) return null;
	if (domains.size !== 1) return BLOCKED_OWNER_LIFE_READ;
	return domains.values().next().value ?? null;
}

function findOwnerLifeReadActionName(
	actions: ReadonlyArray<Pick<Action, "name" | "similes">>,
	domain: OwnerLifeReadDomain,
): string | undefined {
	return findAvailableActionName(
		actions,
		OWNER_READ_ACTION_NAMES_BY_DOMAIN[domain],
	);
}

export function inferDirectCurrentRequestCandidateActions(
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
	messageText: string,
	hooks: DirectActionInferenceHooks = {},
): string[] {
	return inferDirectCurrentRequestCandidateInference(
		actions,
		messageText,
		hooks,
	).names;
}

export function inferDirectCurrentRequestCandidateInference(
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
	messageText: string,
	hooks: DirectActionInferenceHooks = {},
): DirectCurrentRequestCandidateInference {
	if (looksLikeLocalShellRequest(messageText)) {
		const shellAction = findShellDirectActionName(actions);
		if (shellAction) return { names: [shellAction], kind: "shell" };
	}
	if (hooks.looksLikeCodingWorkRequest?.(messageText)) {
		const codingAction = hooks.findCodingDelegationActionName?.(actions);
		if (codingAction) return { names: [codingAction], kind: "coding" };
	}
	// A bare link share routes to the web-read light path before any view/verb
	// token in the DERIVED embed preview text can hijack the turn: read the
	// page and react to it (degrading to the embed metadata already present in
	// the message when the page is not publicly fetchable) — never spawn work.
	if (looksLikeBareLinkShare(messageText)) {
		const lookupActions = findWebLookupActionNames(actions);
		if (lookupActions.length > 0) return { names: lookupActions, kind: "web" };
	}
	if (looksLikeVoiceSettingsWriteRequest(messageText)) {
		const settingsAction = findSettingsWriteActionName(actions);
		if (settingsAction) {
			return { names: [settingsAction], kind: "settings-write" };
		}
	}
	const viewShellAction = findViewShellActionName(actions, messageText);
	if (viewShellAction) {
		// A request that names the application surface itself ("show me the
		// apps", "list running apps", "launch the shopify app") is ambiguous
		// between the views/apps *page* (VIEWS) and the applications themselves.
		// Surface BOTH candidates and let the planner arbitrate from the exposed
		// routing hints; hinting only VIEWS answers every installed-apps ask
		// with the UI view catalog instead of the app itself (#9950). The app
		// slot resolves to the local app-control action, or to the cloud-apps
		// action when the message pins the ask to hosted Eliza Cloud apps (see
		// findAppActionNameForAppRequest). Structurally anchored to a registered
		// app action, so runtimes without one are unaffected.
		const appAction = findAppActionNameForAppRequest(actions, messageText);
		if (appAction && appAction !== viewShellAction) {
			return {
				names: [viewShellAction, appAction],
				kind: "view-surface",
			};
		}
		return { names: [viewShellAction], kind: "view-surface" };
	}
	// Voice-transcription contract: a message that is nothing but a bare
	// surface name ("settings", "wallet", "inbox") is a navigation command, not
	// small talk — a voice pass emits exactly the transcribed noun. Stage-1
	// models routinely answer it with a clarifying question instead, so this
	// deterministic backstop keeps the turn on the planning path where the
	// views action can navigate (#9950). Structurally anchored to a registered
	// VIEWS/VIEW_CAPABILITY action's OWN tag/simile vocabulary, so it is inert
	// for agents without one and never fires on words the views surface does
	// not itself claim.
	const bareViewNavigationAction = findBareViewNavigationActionName(
		actions,
		messageText,
	);
	if (bareViewNavigationAction) {
		return { names: [bareViewNavigationAction], kind: "view-navigation" };
	}
	// Owner mutations outrank navigation: a commitment to create/track/schedule
	// something must never degrade into a view-catalog dump because a domain
	// word incidentally overlaps a views tag (#17028). When the phrasing is an
	// owner mutation but no owner surface is registered, the turn deliberately
	// yields NO deterministic candidate — the model handles it and the
	// unresolvable-capability path declines explicitly — instead of falling
	// through to the weak view-capability overlap below.
	if (looksLikeOwnerRoutineWriteRequest(messageText)) {
		const ownerRoutinesAction = findOwnerRoutinesActionName(actions);
		if (ownerRoutinesAction) {
			return { names: [ownerRoutinesAction], kind: "owner-routines" };
		}
		return EMPTY_DIRECT_CANDIDATE_INFERENCE;
	}
	if (looksLikeOwnerGoalWriteRequest(messageText)) {
		const ownerGoalsAction = findOwnerGoalsActionName(actions);
		if (ownerGoalsAction) {
			return { names: [ownerGoalsAction], kind: "owner-goals" };
		}
		return EMPTY_DIRECT_CANDIDATE_INFERENCE;
	}
	// Scheduled-item admin verbs are mutations on an existing owner record.
	// Resolve the noun's owning surface first so a co-registered reminders
	// umbrella cannot steal alarms, routines, check-ins, or raw scheduled tasks.
	const scheduledAdminDomain = detectScheduledItemAdminDomain(messageText);
	if (scheduledAdminDomain) {
		const scheduledAdminAction = findScheduledAdminActionName(
			actions,
			scheduledAdminDomain,
		);
		if (scheduledAdminAction) {
			return { names: [scheduledAdminAction], kind: "owner-scheduled-admin" };
		}
		return EMPTY_DIRECT_CANDIDATE_INFERENCE;
	}
	// Destructive owner-item operations are owner mutations on existing data.
	// Stage-1 drift can classify an exact-name delete as simple chat (matrix
	// F31); the deterministic candidate keeps the turn on the planning path
	// where the owning umbrella can act, ask, or fail closed on its own
	// surface. Same no-candidate-on-missing-surface rule as the legs above.
	const ownerDeleteDomain = detectOwnerItemDeleteDomain(messageText);
	if (ownerDeleteDomain) {
		const ownerDeleteAction = findOwnerLifeReadActionName(
			actions,
			ownerDeleteDomain,
		);
		if (ownerDeleteAction) {
			return { names: [ownerDeleteAction], kind: "owner-scheduled-admin" };
		}
		return EMPTY_DIRECT_CANDIDATE_INFERENCE;
	}
	// Work-thread lifecycle asks name the surface's own vocabulary; without a
	// deterministic candidate Stage-1 drift leaves the turn tool-less and the
	// model invents a surface refusal (matrix F27). Same
	// no-candidate-on-missing-surface rule as the legs above.
	if (looksLikeWorkThreadRequest(messageText)) {
		const workThreadAction = findWorkThreadActionName(actions);
		if (workThreadAction) {
			return { names: [workThreadAction], kind: "owner-work-thread" };
		}
		return EMPTY_DIRECT_CANDIDATE_INFERENCE;
	}
	// Media-generation asks: capability self-belief follows tool exposure, so
	// a Stage-1 drift that leaves the turn tool-less makes the model deny a
	// capability it demonstrably has (matrix F35). Unlike the owner legs, a
	// missing surface yields no candidate AND no forced escalation — an agent
	// genuinely without a generator should answer honestly from chat.
	if (looksLikeMediaGenerationRequest(messageText)) {
		const mediaAction = findMediaGenerationActionName(actions);
		if (mediaAction) {
			return { names: [mediaAction], kind: "media-generation" };
		}
		return EMPTY_DIRECT_CANDIDATE_INFERENCE;
	}
	// Owner reads outrank the view-capability overlap for the same reason the
	// mutations above do (read-side of fead478cfa): "list my personal todos"
	// wants the data, and VIEWS can only navigate. With no registered owner
	// reader the turn yields NO deterministic candidate rather than degrading
	// into the view catalog.
	const webLookupActions = looksLikeWebSearchRequest(messageText)
		? findWebLookupActionNames(actions)
		: [];
	const ownerReadDomain = detectOwnerLifeReadDomain(messageText);
	if (ownerReadDomain === BLOCKED_OWNER_LIFE_READ) {
		if (explicitlyAsksWebSearch(messageText) && webLookupActions.length > 0) {
			return { names: webLookupActions, kind: "web" };
		}
		return EMPTY_DIRECT_CANDIDATE_INFERENCE;
	}
	if (ownerReadDomain) {
		const ownerReadAction = findOwnerLifeReadActionName(
			actions,
			ownerReadDomain,
		);
		if (ownerReadAction) {
			return { names: [ownerReadAction], kind: "owner-reads" };
		}
		return EMPTY_DIRECT_CANDIDATE_INFERENCE;
	}
	const viewCapabilityAction = findViewCapabilityActionName(
		actions,
		messageText,
	);
	if (viewCapabilityAction) {
		return { names: [viewCapabilityAction], kind: "view-capability" };
	}
	if (webLookupActions.length > 0) {
		return { names: webLookupActions, kind: "web" };
	}
	return EMPTY_DIRECT_CANDIDATE_INFERENCE;
}

// Specific web-tool action names, split by capability. A bare "SEARCH" must NOT
// appear in either list: it loosely matches MESSAGE_SEARCH / CONTACT_SEARCH /
// LOGS_SEARCH via their "search" simile (findAvailableActionName matches name OR
// simile) and would resolve a non-web action.
const WEB_FETCH_ACTION_NAMES = [
	"WEB_FETCH",
	"LOOKUP_WEB",
	"WEB_LOOKUP",
	"FETCH_URL",
] as const;
const WEB_SEARCH_ACTION_NAMES = [
	"WEB_SEARCH",
	"SEARCH_WEB",
	"BRAVE_SEARCH",
	"INTERNET_SEARCH",
	"SEARCH_INTERNET",
	"GOOGLE",
] as const;

/**
 * Resolve ONE web/live-info lookup action, or undefined when the runtime has no
 * web backend. Prefers WEB_SEARCH — the general fallback used by the
 * rescue/existence checks, where a broad search satisfies any query without
 * needing a constructible URL. The planner-surfacing path uses
 * findWebLookupActionNames (WEB_FETCH-first) instead.
 */
export function findWebLookupActionName(
	actions: ReadonlyArray<Pick<Action, "name" | "similes">>,
): string | undefined {
	return (
		findAvailableActionName(actions, WEB_SEARCH_ACTION_NAMES) ??
		findAvailableActionName(actions, WEB_FETCH_ACTION_NAMES)
	);
}

/**
 * Resolve EVERY web/live-info lookup action the runtime exposes, in planner
 * preference order: WEB_FETCH first (a constructible live API/URL — e.g.
 * coingecko or wttr.in — returns deterministic JSON the planner can use inline),
 * then WEB_SEARCH (open-ended discovery). Surfacing BOTH lets the planner fetch
 * a live source itself instead of settling for a stale search result or spawning
 * a sub-agent just to webfetch a URL it already knows.
 */
export function findWebLookupActionNames(
	actions: ReadonlyArray<Pick<Action, "name" | "similes">>,
): string[] {
	const fetchAction = findAvailableActionName(actions, WEB_FETCH_ACTION_NAMES);
	const searchAction = findAvailableActionName(
		actions,
		WEB_SEARCH_ACTION_NAMES,
	);
	const names: string[] = [];
	if (fetchAction) names.push(fetchAction);
	if (searchAction && searchAction !== fetchAction) names.push(searchAction);
	return names;
}

const VIEW_REQUEST_OPERATION_GROUPS = {
	create: ["ADD", "CREATE", "MAKE", "NEW"],
	read: ["FIND", "GET", "LIST", "READ", "SHOW", "WHAT", "WHICH"],
	update: ["CHANGE", "EDIT", "MODIFY", "RENAME", "UPDATE"],
	delete: ["DELETE", "REMOVE"],
	open: ["GO", "NAVIGATE", "OPEN", "SWITCH"],
	close: ["CLOSE", "DISMISS", "HIDE"],
	layout: ["ARRANGE", "HORIZONTAL", "LAYOUT", "SPLIT", "TILE", "VERTICAL"],
	pin: ["DOCK", "PIN"],
} as const;

// Directional words qualify a layout operation ("split it right") but are not
// operations on their own: in ordinary speech they are overwhelmingly
// non-spatial ("right now", "left the meeting", "top of my head"), so counting
// them as layout evidence hijacked live-info asks like "whats btc at right
// now" (RIGHT read as a layout op, NOW as a layout follow-up) into a VIEWS
// candidate that demoted WEB_FETCH off the planner surface. A direction still
// counts as operation evidence when the message names an explicit UI surface
// ("move it to the left of the screen").
const VIEW_LAYOUT_DIRECTION_TOKENS: ReadonlySet<string> = new Set<string>([
	"BOTTOM",
	"LEFT",
	"RIGHT",
	"TOP",
]);

/** True when any token is a bare direction (singular-normalized on the way in). */
function hasLayoutDirectionToken(tokens: readonly string[]): boolean {
	return tokens.some((token) =>
		VIEW_LAYOUT_DIRECTION_TOKENS.has(normalizeSingularToken(token)),
	);
}

const VIEW_REQUEST_OPERATION_TOKENS: ReadonlySet<string> = new Set<string>(
	Object.values(VIEW_REQUEST_OPERATION_GROUPS).flat(),
);

// Operation groups that read as navigation over the view surface. The
// mutation groups (create/update/delete) are deliberately absent: VIEWS can
// only navigate, so a mutation verb is owner-domain evidence (#17028).
const VIEW_NAVIGATION_OPERATION_GROUP_NAMES = [
	"read",
	"open",
	"close",
	"layout",
	"pin",
] as const;

const VIEW_REQUEST_GENERIC_TOKENS: ReadonlySet<string> = new Set<string>([
	"ACTION",
	"ACTIONS",
	"APP",
	"APPS",
	"APPLICATION",
	"APPLICATIONS",
	"BROADCAST",
	"CALL",
	"CAPABILITY",
	"CAPABILITIES",
	"CURRENT",
	"EVENT",
	"EVENTS",
	"INVOKE",
	"LAYOUT",
	"MANAGER",
	"MODE",
	"NOTIFY",
	"PANEL",
	"PANELS",
	"PIN",
	"PLUGIN",
	"PLUGINS",
	"SCREEN",
	"SIGNAL",
	"UI",
	"USE",
	"VIEW",
	"VIEWS",
	"WINDOW",
	"WINDOWS",
	"WITH",
]);

const VIEW_REQUEST_SURFACE_TOKENS: ReadonlySet<string> = new Set<string>([
	"APP",
	"APPLICATION",
	"MANAGER",
	"PANEL",
	"SCREEN",
	"UI",
	"VIEW",
	"WINDOW",
]);

const VIEW_LAYOUT_FOLLOWUP_TOKENS: ReadonlySet<string> = new Set<string>([
	"AGAIN",
	"ALSO",
	"HORIZONTAL",
	"INSTEAD",
	"NOW",
	"TOO",
	"VERTICAL",
]);

const VIEW_PLUGIN_SURFACE_TOKENS: ReadonlySet<string> = new Set<string>([
	"BROWSER",
	"CATALOG",
	"MANAGER",
	"MARKETPLACE",
]);

function findViewsActionName(
	actions: ReadonlyArray<Pick<Action, "name" | "tags">>,
): string | undefined {
	return actions.find((action) => {
		if (normalizeActionIdentifier(action.name) === "VIEWS") return true;
		return (action.tags ?? []).some(
			(tag) => normalizedMetadataPhrase(tag) === "VIEW_CAPABILITY",
		);
	})?.name;
}

function collectViewActionMetadataEntries(
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
	viewActionName: string,
): Array<Pick<Action, "name" | "similes" | "tags">> {
	const normalizedViewActionName = normalizeActionIdentifier(viewActionName);
	return actions.filter((action) => {
		if (normalizeActionIdentifier(action.name) === normalizedViewActionName) {
			return true;
		}
		return (action.tags ?? []).some(
			(tag) => normalizedMetadataPhrase(tag) === "VIEW_CAPABILITY",
		);
	});
}

// Navigation-verb prefixes that mark a views-action simile as a navigation
// alias (OPEN_SETTINGS, SHOW_WALLET, GO_TO_SETTINGS, …). Compared in the
// singular-normalized phrase space of normalizedMetadataPhrase.
const BARE_VIEW_NAVIGATION_SIMILE_PREFIXES = [
	"OPEN",
	"SHOW",
	"GO",
	"GO_TO",
	"NAVIGATE",
	"NAVIGATE_TO",
	"SWITCH",
	"SWITCH_TO",
] as const;

function findBareViewNavigationActionName(
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
	messageText: string,
): string | undefined {
	const tokens = tokenizeActionMetadata(messageText);
	if (tokens.length !== 1) return undefined;
	const bare = normalizeSingularToken(tokens[0]);
	if (
		!bare ||
		VIEW_REQUEST_OPERATION_TOKENS.has(bare) ||
		VIEW_REQUEST_GENERIC_TOKENS.has(bare)
	) {
		return undefined;
	}
	const viewActionName = findViewsActionName(actions);
	if (!viewActionName) return undefined;
	for (const entry of collectViewActionMetadataEntries(
		actions,
		viewActionName,
	)) {
		for (const tag of entry.tags ?? []) {
			if (normalizedMetadataPhrase(String(tag)) === bare) {
				return entry.name;
			}
		}
		for (const simile of entry.similes ?? []) {
			const phrase = normalizedMetadataPhrase(String(simile));
			for (const prefix of BARE_VIEW_NAVIGATION_SIMILE_PREFIXES) {
				if (phrase === `${prefix}_${bare}`) {
					return entry.name;
				}
			}
		}
	}
	return undefined;
}

// App-control action names/similes, in preference order. Consulted only when
// the message names the application surface itself (an APP/APPLICATION token),
// so agents without an app-control action are unaffected.
const APP_CONTROL_ACTION_NAMES = [
	"APP",
	"APP_CONTROL",
	"MANAGE_APPS",
	"LIST_APPS",
	"LAUNCH_APP",
] as const;

// Cloud-apps action names/similes, in preference order. Mirrors the cloud-apps
// action's own simile vocabulary (plugin-cloud-apps LIST_CLOUD_APPS); consulted
// only when an app-shaped message carries a cloud qualifier token below, so
// agents without a cloud-apps action are unaffected.
const CLOUD_APPS_ACTION_NAMES = [
	"LIST_CLOUD_APPS",
	"MY_CLOUD_APPS",
	"CLOUD_APPS",
] as const;

// Tokens that pin an app-shaped message to the user's HOSTED Eliza Cloud apps
// ("list my cloud apps", "my deployed apps") rather than apps installed or
// running on this device. Compared in singular-normalized token space.
const CLOUD_APP_QUALIFIER_TOKENS: ReadonlySet<string> = new Set<string>([
	"CLOUD",
	"DEPLOYED",
	"HOSTED",
]);

// Resolve the app action an app-shaped message targets. A cloud qualifier next
// to the APP token pins the ask to the user's hosted Eliza Cloud apps, where
// the local app-control action is wrong by its own routing contract — without
// this the cloud-apps action is never on the planner surface and the local APP
// action wins by forfeit. Falls back to the local app-control surface when no
// cloud-apps action is registered, so those runtimes keep their previous
// candidates.
function findAppActionNameForAppRequest(
	actions: ReadonlyArray<Pick<Action, "name" | "similes">>,
	messageText: string,
): string | undefined {
	const tokens = tokenizeActionMetadata(messageText).map(
		normalizeSingularToken,
	);
	if (!tokens.some((token) => token === "APP" || token === "APPLICATION")) {
		return undefined;
	}
	if (tokens.some((token) => CLOUD_APP_QUALIFIER_TOKENS.has(token))) {
		const cloudAppsAction = findAvailableActionName(
			actions,
			CLOUD_APPS_ACTION_NAMES,
		);
		if (cloudAppsAction) return cloudAppsAction;
	}
	return findAvailableActionName(actions, APP_CONTROL_ACTION_NAMES);
}

function findViewShellActionName(
	actions: ReadonlyArray<Pick<Action, "name" | "tags">>,
	messageText: string,
): string | undefined {
	if (looksLikeInstructionalViewQuestion(messageText)) return undefined;
	const viewActionName = findViewsActionName(actions);
	if (!viewActionName) return undefined;

	const messageTokens = tokenizeActionMetadata(messageText).map(
		normalizeSingularToken,
	);
	const messageOperationGroups = operationGroupsForTokens(messageTokens);
	const tokenSet = new Set(messageTokens);
	if (
		messageOperationGroups.size === 0 &&
		!hasLayoutDirectionToken(messageTokens)
	) {
		return undefined;
	}

	// Surface-noun leg: an explicit UI surface plus any operation OR
	// directional evidence ("move it to the left of the screen").
	for (const token of VIEW_REQUEST_SURFACE_TOKENS) {
		if (tokenSet.has(token)) return viewActionName;
	}

	// The remaining legs have no surface anchor, so they need a real
	// operation — a bare direction is not enough.
	if (messageOperationGroups.size === 0) return undefined;
	if (
		(tokenSet.has("PLUGIN") || tokenSet.has("PLUGINS")) &&
		messageTokens.some((token) => VIEW_PLUGIN_SURFACE_TOKENS.has(token))
	) {
		return viewActionName;
	}
	if (
		messageOperationGroups.has("layout") &&
		messageTokens.some((token) => VIEW_LAYOUT_FOLLOWUP_TOKENS.has(token))
	) {
		return viewActionName;
	}
	return undefined;
}

function findViewCapabilityActionName(
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
	messageText: string,
): string | undefined {
	if (looksLikeInstructionalViewQuestion(messageText)) return undefined;
	const viewActionName = findViewsActionName(actions);
	if (!viewActionName) return undefined;
	const viewActions = collectViewActionMetadataEntries(actions, viewActionName);
	if (viewActions.length === 0) return undefined;

	const messageTokens = tokenizeActionMetadata(messageText);
	const messageTokenSet = new Set(messageTokens.map(normalizeSingularToken));
	const messageOperationGroups = operationGroupsForTokens(messageTokens);
	// A direction counts as operation evidence here just as in the view-shell
	// detector ("move the calendar to the right" — MOVE is in no group), since
	// this detector still demands a concrete capability-token match below.
	if (
		messageOperationGroups.size === 0 &&
		!hasLayoutDirectionToken(messageTokens)
	) {
		return undefined;
	}
	// VIEWS can only NAVIGATE. Mutation verbs alone (create/update/delete) are
	// owner-domain evidence, not view evidence — "add a savings goal" must not
	// select the view catalog just because a "goals" tag exists (#17028). The
	// capability leg needs navigation-shaped intent: a read/open/close/layout/
	// pin operation, a directional qualifier, or an explicit UI-surface noun.
	const hasNavigationOperation = VIEW_NAVIGATION_OPERATION_GROUP_NAMES.some(
		(group) => messageOperationGroups.has(group),
	);
	if (
		!hasNavigationOperation &&
		!hasLayoutDirectionToken(messageTokens) &&
		![...VIEW_REQUEST_SURFACE_TOKENS].some((token) =>
			messageTokenSet.has(token),
		)
	) {
		return undefined;
	}

	for (const viewAction of viewActions) {
		for (const alias of [
			viewAction.name,
			...(viewAction.similes ?? []),
			...(viewAction.tags ?? []),
		]) {
			const aliasTokens = tokenizeActionMetadata(String(alias));
			if (aliasTokens.length === 0) continue;
			const aliasOperationGroups = operationGroupsForTokens(aliasTokens);
			if (
				aliasOperationGroups.size > 0 &&
				!setsIntersect(aliasOperationGroups, messageOperationGroups)
			) {
				continue;
			}
			// Multiword capability tags are PHRASES: every non-operation token —
			// generic ones like SCREEN included — must appear in the message.
			// Filtering generics out let "screen-time" collapse to the bare TIME
			// token, so "whats 17 times 23" and "3 times a day" matched a
			// screen-time capability (#17028, tj-501e594bfb23a7). At least one
			// concrete (non-generic) token is still required so purely generic
			// aliases ("view-capability") never match on their own vocabulary.
			const singularAliasTokens = aliasTokens.map(normalizeSingularToken);
			const requiredTokens = singularAliasTokens.filter(
				(token) => !VIEW_REQUEST_OPERATION_TOKENS.has(token),
			);
			const concreteTokens = requiredTokens.filter(
				(token) => !VIEW_REQUEST_GENERIC_TOKENS.has(token),
			);
			if (concreteTokens.length === 0) continue;
			if (requiredTokens.every((token) => messageTokenSet.has(token))) {
				return viewActionName;
			}
		}
	}
	return undefined;
}

function looksLikeInstructionalViewQuestion(messageText: string): boolean {
	// Deliberately does NOT match the colloquial "whats": genuine view-data asks
	// ("whats my screen time") lean on that spelling slipping through so they
	// keep promoting to the views surface (fenced in
	// message-routing-live-regression.test.ts).
	return /^\s*(?:explain|describe|teach|what\s+(?:is|are)|how\s+(?:do|can|to)\b)/iu.test(
		messageText,
	);
}

function tokenizeActionMetadata(value: string): string[] {
	const matches = value
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.toUpperCase()
		.match(/[A-Z0-9]+/g);
	return matches ?? [];
}

function normalizedMetadataPhrase(value: string): string {
	return tokenizeActionMetadata(value).map(normalizeSingularToken).join("_");
}

function normalizeSingularToken(token: string): string {
	if (token === "CALENDER") return "CALENDAR";
	if (token.length > 3 && token.endsWith("IES")) {
		return `${token.slice(0, -3)}Y`;
	}
	if (token.length > 3 && token.endsWith("S") && !token.endsWith("SS")) {
		return token.slice(0, -1);
	}
	return token;
}

function operationGroupsForTokens(tokens: readonly string[]): Set<string> {
	const groups = new Set<string>();
	for (const token of tokens.map(normalizeSingularToken)) {
		for (const [group, groupTokens] of Object.entries(
			VIEW_REQUEST_OPERATION_GROUPS,
		)) {
			if ((groupTokens as readonly string[]).includes(token)) {
				groups.add(group);
			}
		}
	}
	return groups;
}

function setsIntersect<T>(
	left: ReadonlySet<T>,
	right: ReadonlySet<T>,
): boolean {
	for (const entry of left) {
		if (right.has(entry)) return true;
	}
	return false;
}

function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function extractLocalShellPath(text: string): string | null {
	const match = text.match(
		/(?:^|[\s`'"])(\/(?:home|Users|workspace|workspaces|tmp|var\/tmp|opt|srv)\/[A-Za-z0-9._~+/@:-]+)/u,
	);
	if (!match?.[1]) {
		return null;
	}
	return match[1].replace(/[),.;:]+$/u, "");
}

export function inferLocalShellCommandFromMessageText(
	messageText: string,
): string | null {
	const text = messageText.toLowerCase();
	if (!looksLikeLocalShellRequest(messageText)) {
		return null;
	}

	if (/\bdf\s+-h\b/iu.test(messageText) || /\bdisk space\b/iu.test(text)) {
		return "df -h";
	}

	if (/\bgit\b/iu.test(text)) {
		const localPath = extractLocalShellPath(messageText);
		if (!localPath) {
			if (/\bgit\s+status\b/iu.test(messageText)) {
				return "git status --short --branch";
			}
			return null;
		}
		const repo = quoteShellArg(localPath);
		const commands = [`git -C ${repo} status --short --branch`];
		if (
			/\b(?:branch|head|sha|origin\/(?:develop|main|master)|latest|author config|commit author|user\.name|user\.email)\b/iu.test(
				messageText,
			)
		) {
			commands.push(
				`git -C ${repo} branch --show-current`,
				`git -C ${repo} rev-parse --short HEAD`,
				`(git -C ${repo} rev-parse --short origin/develop 2>/dev/null || git -C ${repo} rev-parse --short origin/main 2>/dev/null || true)`,
				`git -C ${repo} config user.name`,
				`git -C ${repo} config user.email`,
			);
		}
		return commands.join(" && ");
	}

	return null;
}

export function inferWebSearchQueryFromMessageText(
	messageText: string,
): string | null {
	if (!looksLikeWebSearchRequest(messageText)) {
		return null;
	}

	const query = messageText
		.replace(/<@!?\d+>/gu, " ")
		.replace(
			/\banswer\s+(?:briefly|in\s+one\s+short\s+sentence|with\s+the\s+price\s+only)\b.*$/iu,
			" ",
		)
		.replace(
			/\band\s+mention\s+if\s+you\s+cannot\s+browse\s+live\s+prices\b.*$/iu,
			" ",
		)
		.replace(
			/\b(?:search\s+(?:the\s+)?web\s+(?:for|about)?|web\s+search|search\s+online|look\s+up|lookup|google|browse\s+(?:the\s+)?web|search\s+(?:the\s+)?internet)\b/iu,
			" ",
		)
		.replace(/\bwhat\s+is\s+the\b/iu, " ")
		.replace(/[?.!]+/gu, " ")
		.trim()
		.replace(/\s+/gu, " ");

	return query.length > 0 ? query : messageText.trim();
}

/**
 * Minimal structural view of a recent-message memory used by continuation
 * resolution. Kept local so the heuristics module stays free of the full
 * Memory type; callers pass provider-shaped rows (state RECENT_MESSAGES data).
 */
export type ContinuationDialogueEntry = {
	id?: string;
	entityId?: string;
	createdAt?: number;
	content?: {
		text?: unknown;
		type?: unknown;
		source?: unknown;
		actions?: unknown;
		actionCallbackHistory?: unknown;
		metadata?: unknown;
	};
};

/**
 * Identifies assistant text derived from a tool execution rather than ordinary
 * dialogue. Planner context and continuation resolution share this predicate
 * so either persisted provenance shape closes the completed-action replay path.
 * Envelope membership comes from `isReservedNonToolActionName` so STOP stays
 * a planner terminal, not a delivered tool, and new
 * `NON_EXECUTABLE_RESPONSE_ACTION_NAMES` members cannot silently drift.
 */
export function isToolDerivedAssistantContent(
	content: ContinuationDialogueEntry["content"],
): boolean {
	if (!content || typeof content !== "object") return false;
	if (
		Array.isArray(content.actionCallbackHistory) &&
		content.actionCallbackHistory.length > 0
	) {
		return true;
	}
	if (!Array.isArray(content.actions)) return false;
	return content.actions.some((action) => {
		if (typeof action !== "string") return false;
		const normalized = normalizeActionIdentifier(action);
		return normalized.length > 0 && !isReservedNonToolActionName(normalized);
	});
}

const CONTINUATION_LEAD_IN =
	"(?:ok(?:ay)?|yes|yep|yeah|sure|alright|great|perfect)?[,.!]?\\s*(?:please\\s+)?";

// Directive continuations explicitly tell the agent to keep working; they are
// contentless by construction (no domain nouns survive the anchored match), so
// substituting the resolved prior request for candidate inference cannot mask
// a fresh ask.
const CONTINUATION_DIRECTIVE_RE = new RegExp(
	`^${CONTINUATION_LEAD_IN}(?:(?:finish|complete|continue|resume)(?:\\s+(?:up|it|that|this|(?:my|the|that|this)\\s+(?:request|task|work|job)|what\\s+you\\s+were\\s+doing|where\\s+you\\s+left\\s+off))?|go\\s+ahead|do\\s+it|proceed|keep\\s+going|carry\\s+on|make\\s+it\\s+so)(?:\\s+(?:please|then|now))?$`,
	"iu",
);

// Approval continuations accept a pending question/preview ("that is good",
// bare "yes"). They only resolve when the agent's latest visible turn still
// looks pending — an ack or a question — so praise after a delivered result
// does not re-trigger the finished request.
const CONTINUATION_APPROVAL_BASES = new Set([
	"yes",
	"yep",
	"yeah",
	...(["that", "this", "it"] as const).flatMap((subject) =>
		["good", "great", "perfect", "fine", "right", "correct"].flatMap(
			(adjective) => [
				`${subject}'s ${adjective}`,
				`${subject} is ${adjective}`,
			],
		),
	),
	"that works",
	"this works",
	"it works",
	"sounds good",
	"looks good",
]);

function isApprovalBaseWithOptionalTail(value: string): boolean {
	if (CONTINUATION_APPROVAL_BASES.has(value)) return true;
	for (const tail of [
		"go ahead",
		"do it",
		"proceed",
		"finish",
		"finish it",
		"continue",
		"thank",
		"thanks",
		"thank you",
	]) {
		if (!value.endsWith(` ${tail}`)) continue;
		let base = value.slice(0, -tail.length).trimEnd();
		if (base.endsWith(" please")) base = base.slice(0, -" please".length);
		base = base.trimEnd();
		if (",.!".includes(base[base.length - 1] ?? ""))
			base = base.slice(0, -1).trimEnd();
		if (CONTINUATION_APPROVAL_BASES.has(base)) return true;
	}
	return false;
}

function stripContinuationLeadIn(value: string): string {
	let cursor = 0;
	while (cursor < value.length && /[a-z]/.test(value[cursor])) cursor += 1;
	const word = value.slice(0, cursor);
	if (
		![
			"ok",
			"okay",
			"yes",
			"yep",
			"yeah",
			"sure",
			"alright",
			"great",
			"perfect",
		].includes(word)
	) {
		cursor = 0;
	} else if (",.!".includes(value[cursor] ?? "")) {
		cursor += 1;
	}
	while (/\s/u.test(value[cursor] ?? "")) cursor += 1;
	if (value.startsWith("please", cursor)) {
		const end = cursor + "please".length;
		if (/\s/u.test(value[end] ?? "")) {
			cursor = end;
			while (/\s/u.test(value[cursor] ?? "")) cursor += 1;
		}
	}
	return value.slice(cursor);
}

function isContinuationApproval(value: string): boolean {
	return (
		isApprovalBaseWithOptionalTail(value) ||
		isApprovalBaseWithOptionalTail(stripContinuationLeadIn(value))
	);
}

function normalizeContinuationText(text: string): string {
	return text
		.trim()
		.replace(/[.!…]+$/u, "")
		.replace(/\s+/gu, " ");
}

export type ExplicitContinuationKind = "directive" | "approval";

/**
 * Classifies a turn that carries no request of its own and only tells the
 * agent to proceed with (or approves) earlier work. Anchored whole-message
 * matches with a short length cap keep ordinary chat ("that is a good
 * question", topic switches) out.
 */
export function classifyExplicitContinuationTurn(
	text: string,
): ExplicitContinuationKind | null {
	const normalized = normalizeContinuationText(text);
	if (normalized.length === 0 || normalized.length > 60) return null;
	if (normalized.includes("?")) return null;
	if (CONTINUATION_DIRECTIVE_RE.test(normalized)) return "directive";
	if (isContinuationApproval(normalized.toLowerCase())) return "approval";
	return null;
}

export function looksLikeExplicitContinuationTurn(text: string): boolean {
	return classifyExplicitContinuationTurn(text) !== null;
}

function continuationEntryText(entry: ContinuationDialogueEntry): string {
	return typeof entry.content?.text === "string"
		? entry.content.text.trim()
		: "";
}

function isContinuationDialogueArtifact(
	entry: ContinuationDialogueEntry,
): boolean {
	const content = entry.content;
	if (!content || typeof content !== "object") return true;
	if (content.type === "action_result") return true;
	if (isToolDerivedAssistantContent(content)) return true;
	if (
		typeof content.source === "string" &&
		content.source.includes("sub-agent")
	) {
		return true;
	}
	const metadata = content.metadata;
	if (
		metadata &&
		typeof metadata === "object" &&
		(metadata as { subAgent?: unknown }).subAgent === true
	) {
		return true;
	}
	return false;
}

const CONTINUATION_LOOKBACK_ENTRIES = 12;
const PENDING_ASSISTANT_TURN_MAX_CHARS = 160;

function looksLikePendingAssistantTurn(text: string): boolean {
	if (text.endsWith("?")) return true;
	if (text.length > PENDING_ASSISTANT_TURN_MAX_CHARS) return false;
	return /^(?:(?:ok(?:ay)?|sure|great)[,.!]?\s+)?(?:on it|working on it|ready (?:to proceed|when you are)|(?:i\s+(?:can|could|will)|i['’]ll)\b)/iu.test(
		text,
	);
}

/**
 * Resolves an explicit continuation turn ("finish my request", "that is
 * good") to the nearest prior user request so candidate inference can rerun
 * on the request the user is actually referring to. Deterministic and
 * conservative: non-continuation turns resolve to nothing (topic switches are
 * untouched), approval turns additionally require the agent's latest visible
 * reply to still look pending (a question or a short ack without tool-result
 * callbacks), and the resolved text is the single nearest prior request from
 * the current speaker — shared-room requests from other participants are never
 * selected or concatenated onto the current turn.
 */
export function resolveExplicitContinuationRequestText(
	currentText: string,
	recentMessages: ReadonlyArray<ContinuationDialogueEntry>,
	agentId: string,
	requesterEntityId: string,
	currentMessageId?: string,
): string | null {
	if (!requesterEntityId || requesterEntityId === agentId) return null;
	const kind = classifyExplicitContinuationTurn(currentText);
	if (!kind) return null;
	const ordered = [...recentMessages]
		.filter((entry) => {
			if (!entry || typeof entry !== "object") return false;
			if (currentMessageId && entry.id === currentMessageId) return false;
			return continuationEntryText(entry).length > 0;
		})
		.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
		.slice(-CONTINUATION_LOOKBACK_ENTRIES);

	if (kind === "approval") {
		// Approval must answer the immediately preceding visible assistant turn.
		// Looking farther back can authorize a newer user request that the agent
		// never previewed or asked permission to execute.
		const lastAssistant = ordered.at(-1);
		if (
			!lastAssistant ||
			lastAssistant.entityId !== agentId ||
			isContinuationDialogueArtifact(lastAssistant)
		) {
			return null;
		}
		const callbacks = lastAssistant.content?.actionCallbackHistory;
		if (Array.isArray(callbacks) && callbacks.length > 0) return null;
		const lastText = continuationEntryText(lastAssistant);
		if (!looksLikePendingAssistantTurn(lastText)) return null;
	}

	for (let index = ordered.length - 1; index >= 0; index--) {
		const entry = ordered[index];
		if (!entry || entry.entityId !== requesterEntityId) continue;
		if (isContinuationDialogueArtifact(entry)) continue;
		const text = continuationEntryText(entry);
		if (text.length === 0) continue;
		if (classifyExplicitContinuationTurn(text) !== null) continue;
		if (
			normalizeContinuationText(text) === normalizeContinuationText(currentText)
		) {
			continue;
		}
		return text;
	}
	return null;
}
