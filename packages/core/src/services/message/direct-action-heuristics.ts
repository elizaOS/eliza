/**
 * Pre-model heuristics that decide which registered actions a raw message should
 * directly trigger: local-shell inspection, web/live-info lookup, coding-task
 * delegation, and views/app navigation. Each detector fires on clear intent,
 * honors explicit negations ("don't run commands", "don't browse the web"), and
 * resolves action names structurally by canonical name, simile, or tag — so a
 * runtime missing a given backend action simply yields no candidate. Also derives
 * a concrete shell command or web-search query from the message text.
 */
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

export function looksLikeWebSearchRequest(text: string): boolean {
	const normalized = text.toLowerCase();
	if (!normalized.trim()) {
		return false;
	}

	if (
		/\b(?:do not|don't|dont|without)\s+(?:browse|search|google|look\s+up|use)\s+(?:the\s+)?(?:web|internet|live prices?|current prices?)\b/iu.test(
			normalized,
		)
	) {
		return false;
	}

	const explicitlyAsksSearch =
		/\b(?:search\s+(?:the\s+)?web|web\s+search|search\s+online|look\s+up|lookup|google|browse\s+(?:the\s+)?web|search\s+(?:the\s+)?internet)\b/iu.test(
			normalized,
		);
	const asksCurrentInfo =
		/\b(?:current|currently|latest|live|real[- ]?time|right now|today|now|rn|atm|up[- ]?to[- ]?date)\b/iu.test(
			normalized,
		);
	const mentionsMarketOrNews =
		/\b(?:price|prices|quote|btc|bitcoin|eth|ethereum|stock|stocks?|ticker|market|markets?|exchange rate|news|headline|headlines|weather)\b/iu.test(
			normalized,
		);
	return explicitlyAsksSearch || (asksCurrentInfo && mentionsMarketOrNews);
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

export function inferDirectCurrentRequestCandidateActions(
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
	messageText: string,
	hooks: DirectActionInferenceHooks = {},
): string[] {
	if (looksLikeLocalShellRequest(messageText)) {
		const shellAction = findAvailableActionName(actions, [
			"SHELL",
			"TERMINAL_SHELL",
			"RUN_IN_TERMINAL",
			"RUN_COMMAND",
			"EXECUTE_COMMAND",
			"TERMINAL",
			"RUN_SHELL",
			"EXEC",
		]);
		if (shellAction) return [shellAction];
	}
	if (hooks.looksLikeCodingWorkRequest?.(messageText)) {
		const codingAction = hooks.findCodingDelegationActionName?.(actions);
		if (codingAction) return [codingAction];
	}
	const viewShellAction = findViewShellActionName(actions, messageText);
	if (viewShellAction) {
		// A request that names the application surface itself ("show me the
		// apps", "list running apps", "launch the shopify app") is ambiguous
		// between the views/apps *page* (VIEWS) and the applications themselves
		// (the APP control action). Surface BOTH candidates and let the planner
		// arbitrate from the exposed routing hints; hinting only VIEWS answers
		// every installed-apps ask with the UI view catalog instead of the app
		// itself (#9950). Structurally anchored to a registered app-control
		// action, so runtimes without one are unaffected.
		const appControlAction = findAppControlActionNameForAppRequest(
			actions,
			messageText,
		);
		if (appControlAction && appControlAction !== viewShellAction) {
			return [viewShellAction, appControlAction];
		}
		return [viewShellAction];
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
	if (bareViewNavigationAction) return [bareViewNavigationAction];
	const viewCapabilityAction = findViewCapabilityActionName(
		actions,
		messageText,
	);
	if (viewCapabilityAction) return [viewCapabilityAction];
	if (looksLikeWebSearchRequest(messageText)) {
		const lookupActions = findWebLookupActionNames(actions);
		if (lookupActions.length > 0) return lookupActions;
	}
	return [];
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
	layout: [
		"ARRANGE",
		"BOTTOM",
		"HORIZONTAL",
		"LEFT",
		"LAYOUT",
		"RIGHT",
		"SPLIT",
		"TILE",
		"TOP",
		"VERTICAL",
	],
	pin: ["DOCK", "PIN"],
} as const;

const VIEW_REQUEST_OPERATION_TOKENS: ReadonlySet<string> = new Set<string>(
	Object.values(VIEW_REQUEST_OPERATION_GROUPS).flat(),
);

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

function findAppControlActionNameForAppRequest(
	actions: ReadonlyArray<Pick<Action, "name" | "similes">>,
	messageText: string,
): string | undefined {
	const tokens = tokenizeActionMetadata(messageText).map(
		normalizeSingularToken,
	);
	if (!tokens.some((token) => token === "APP" || token === "APPLICATION")) {
		return undefined;
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
	if (messageOperationGroups.size === 0) return undefined;

	const tokenSet = new Set(messageTokens);
	for (const token of VIEW_REQUEST_SURFACE_TOKENS) {
		if (tokenSet.has(token)) return viewActionName;
	}
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
	if (messageOperationGroups.size === 0) return undefined;

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
			const targetTokens = aliasTokens
				.map(normalizeSingularToken)
				.filter(
					(token) =>
						!VIEW_REQUEST_OPERATION_TOKENS.has(token) &&
						!VIEW_REQUEST_GENERIC_TOKENS.has(token),
				);
			if (targetTokens.length === 0) continue;
			if (targetTokens.every((token) => messageTokenSet.has(token))) {
				return viewActionName;
			}
		}
	}
	return undefined;
}

function looksLikeInstructionalViewQuestion(messageText: string): boolean {
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
	if (token.length > 3 && token.endsWith("S")) {
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
