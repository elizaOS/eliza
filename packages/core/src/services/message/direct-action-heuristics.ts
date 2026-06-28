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

function normalizeActionIdentifier(actionName: string): string {
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
	// The leading preference wins — e.g. WEB_SEARCH (listed ahead of WEB_FETCH)
	// is chosen for a web lookup even though WEB_FETCH registers first.
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

const WEB_LOOKUP_ACTION_NAMES = [
	"SEARCH",
	"WEB_SEARCH",
	"SEARCH_WEB",
	"BRAVE_SEARCH",
	"INTERNET_SEARCH",
	"SEARCH_INTERNET",
	"LOOKUP_WEB",
	"WEB_FETCH",
	"GOOGLE",
] as const;

export function inferDirectCurrentRequestCandidateActions(
	actions: ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>,
	messageText: string,
	hooks: DirectActionInferenceHooks = {},
): string[] {
	if (looksLikeLocalShellRequest(messageText)) {
		const shellAction = findAvailableActionName(actions, [
			"SHELL",
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
	if (viewShellAction) return [viewShellAction];
	const viewCapabilityAction = findViewCapabilityActionName(
		actions,
		messageText,
	);
	if (viewCapabilityAction) return [viewCapabilityAction];
	if (looksLikeWebSearchRequest(messageText)) {
		const lookupAction = findWebLookupActionName(actions);
		if (lookupAction) return [lookupAction];
	}
	return [];
}

/**
 * Resolve the action that satisfies a web / live-info lookup, or undefined when
 * the runtime has no real search backend registered.
 */
export function findWebLookupActionName(
	actions: ReadonlyArray<Pick<Action, "name" | "similes">>,
): string | undefined {
	return findWebLookupActionNames(actions)[0];
}

export function findWebLookupActionNames(
	actions: ReadonlyArray<Pick<Action, "name" | "similes">>,
): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const want of WEB_LOOKUP_ACTION_NAMES) {
		const wanted = normalizeActionIdentifier(want);
		for (const action of actions) {
			const actionKey = normalizeActionIdentifier(action.name);
			if (seen.has(actionKey)) continue;
			const similes = Array.isArray(action.similes) ? action.similes : [];
			const matches =
				actionKey === wanted ||
				similes.some(
					(simile) => normalizeActionIdentifier(String(simile)) === wanted,
				);
			if (!matches) continue;
			seen.add(actionKey);
			result.push(action.name);
		}
	}
	return result;
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
