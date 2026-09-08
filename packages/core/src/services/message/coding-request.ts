/** Recognizes explicit coding and delegation requests while excluding literal snippets and creative-writing requests. */
import { looksLikeBareLinkShare } from "./direct-action-heuristics";

export function looksLikeActionExplanationRequest(text: string): boolean {
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

// Ask classes a coding delegation can never serve: an explicit "don't spawn",
// an explanation/teaching ask, or creative writing that isn't a coding task.
// Shared by looksLikeCodingWorkRequest (as its exclusion list) and the
// delegation-commitment gate in messageHandlerFromFieldResult.
export function looksLikeDelegationExcludedAsk(text: string): boolean {
	const normalized = text.toLowerCase();
	if (!normalized.trim()) {
		return false;
	}
	if (
		/\b(?:do not|don't|dont|without)\s+(?:spawn|delegate|use|start)\s+(?:a\s+)?(?:sub[- ]?agent|task[- ]?agent|coding agent|eliza[- ]?code|opencode|codex|claude)\b/iu.test(
			normalized,
		)
	) {
		return true;
	}
	// A shared link with no explicit work imperative is content to react to,
	// not a work order — even when the model itself proposed a spawn candidate
	// off the embed preview text (observed live: bare URL + embed title →
	// TASKS_SPAWN_AGENT with an empty derived task → doomed sub-agent).
	if (looksLikeBareLinkShare(normalized)) {
		return true;
	}
	if (looksLikeActionExplanationRequest(normalized)) {
		return true;
	}
	return (
		looksLikeCreativeWritingRequest(normalized) &&
		!looksLikeCreativeCodingWorkRequest(normalized)
	);
}

export const LEGACY_CODING_WORK_VERB_PATTERN =
	/\b(?:build|create|make|implement|write|scaffold|fix|edit|modify|update|verify)\b/giu;

// Add-family verbs are everyday mutation words ("add a reminder", "delete the
// weather app"), so they pair ONLY with strong code artifacts — never the
// legacy artifact set whose app/site/page tokens belong to view and app
// management asks. Live gap 2026-08-18: "yo can u add a lil one-line
// description to the readme in my <name> repo and put up a pr" carried
// repo+pr artifacts but no legacy verb; no deterministic coding candidate
// fired and Stage-1 answered ["simple"] from stale room history, fabricating
// "a PR is up".
export const ADD_FAMILY_CODING_VERB_PATTERN =
	/\b(?:add|append|insert|rename|remove|delete)\b/giu;

export const LEGACY_CODING_ARTIFACT_PATTERN =
	/\b(?:app|site|website|page|code|file|files|project|cli|script|backend|frontend|repo|feature|bug|url)\b/giu;

export const CODING_OPERATION_VERB_PATTERN =
	/\b(?:refactor|debug|deploy|patch|optimize|migrate|profile)\b/giu;

// Repo-submission verbs pair ONLY with the strong code artifacts: "put up a
// pr", "push a branch", "open a pull request". "open" lives here and NOT in
// the legacy verb set because anchored to pr/repo/branch it is unambiguous,
// while "open the app/page" is view navigation.
export const REPO_SUBMIT_VERB_PATTERN =
	/\b(?:put\s+up|open|submit|push|raise|file)\b/giu;

export const REVIEW_WORK_VERB_PATTERN =
	/\b(?:review|audit|investigate|analyze|inspect|test|trace|diagnose)\b/giu;

export const STRONG_CODE_ARTIFACT_PATTERN =
	/\b(?:code|cli|script|backend|frontend|repo|repository|bug|pr|pull request|commit|branch|stack trace|pipeline|ci|readme|changelog)\b/giu;

export const EXPANDED_WORK_ARTIFACT_PATTERN =
	/\b(?:app|site|website|page|code|file|files|project|cli|script|backend|frontend|repo|repository|feature|bug|url|pr|pull request|issue|commit|branch|build|test|error|stack trace|failure|log|docs|documentation|run|pipeline|ci)\b/giu;

export const HTTP_URL_PATTERN = /\bhttps?:\/\/[^\s<>()]+/iu;

export interface TextSpan {
	start: number;
	end: number;
}

export function collectTextSpans(text: string, pattern: RegExp): TextSpan[] {
	return Array.from(text.matchAll(pattern), (match) => ({
		start: match.index,
		end: match.index + match[0].length,
	}));
}

export function hasNearbyTerms(
	text: string,
	leftPattern: RegExp,
	rightPattern: RegExp,
	maxGap: number,
): boolean {
	const leftSpans = collectTextSpans(text, leftPattern);
	const rightSpans = collectTextSpans(text, rightPattern);
	return leftSpans.some((left) =>
		rightSpans.some((right) => {
			if (left.end <= right.start) return right.start - left.end <= maxGap;
			if (right.end <= left.start) return left.start - right.end <= maxGap;
			return true;
		}),
	);
}

export function looksLikeCodingWorkRequest(text: string): boolean {
	const normalized = text.toLowerCase();
	if (!normalized.trim()) {
		return false;
	}

	if (looksLikeDelegationExcludedAsk(normalized)) {
		return false;
	}

	const asksDelegation = looksLikeExplicitDelegationRequest(normalized);
	if (!asksDelegation && looksLikeInlineCodeSnippetRequest(normalized)) {
		return false;
	}
	const asksCodingWork =
		// Preserve the pre-#18108 construction/edit contract exactly.
		hasNearbyTerms(
			normalized,
			LEGACY_CODING_WORK_VERB_PATTERN,
			LEGACY_CODING_ARTIFACT_PATTERN,
			160,
		) ||
		// Coding-native operations can safely use the expanded artifact set.
		hasNearbyTerms(
			normalized,
			CODING_OPERATION_VERB_PATTERN,
			EXPANDED_WORK_ARTIFACT_PATTERN,
			160,
		) ||
		// Review-family verbs are common in health, finance, and personal work.
		// Promote them without a URL only when paired with a code-specific noun.
		hasNearbyTerms(
			normalized,
			REVIEW_WORK_VERB_PATTERN,
			STRONG_CODE_ARTIFACT_PATTERN,
			160,
		) ||
		// Submission verbs anchored to strong code artifacts: "put up a pr",
		// "push the branch", "open a pull request".
		hasNearbyTerms(
			normalized,
			REPO_SUBMIT_VERB_PATTERN,
			STRONG_CODE_ARTIFACT_PATTERN,
			160,
		) ||
		// Add-family mutations anchored to strong code artifacts: "add a line
		// to the readme", "rename the branch", "delete the stale commit".
		hasNearbyTerms(
			normalized,
			ADD_FAMILY_CODING_VERB_PATTERN,
			STRONG_CODE_ARTIFACT_PATTERN,
			160,
		) ||
		// A URL plus a nearby review-family verb and work artifact is the
		// deterministic work-order shape reported in #18108. Without the URL,
		// generic nouns such as issue, test, log, or documentation remain planner
		// decisions instead of being mislabeled as coding jobs.
		(HTTP_URL_PATTERN.test(normalized) &&
			hasNearbyTerms(
				normalized,
				REVIEW_WORK_VERB_PATTERN,
				EXPANDED_WORK_ARTIFACT_PATTERN,
				160,
			));
	return asksDelegation || asksCodingWork;
}

export function looksLikeExplicitDelegationRequest(text: string): boolean {
	const normalized = text.toLowerCase();
	return (
		/\b(?:spawn|delegate|use|start|ask|have)\b[\s\S]{0,80}\b(?:sub[- ]?agent|task[- ]?agent|coding agent|eliza[- ]?code|opencode|codex|claude)\b/iu.test(
			normalized,
		) ||
		/\b(?:sub[- ]?agent|task[- ]?agent|coding agent|eliza[- ]?code|opencode|codex|claude)\b[\s\S]{0,80}\b(?:build|create|make|implement|write|scaffold|fix|edit|modify|verify)\b/iu.test(
			normalized,
		)
	);
}

export const COMPUTED_OBJECT_RE =
	/[/\\:@]|https?:|\b(?:current|latest|live|today|now|price|prices|contents?|weather|time|date|random|primes?|fibonacci|under|between|from|of|in|at|each|every|all|list|first|last|largest|smallest|sum|count|number|result|output|value|api|file|url|env|variable|ip|address|size|length|temperature|stats?|status|usage|memory|disk|uptime|hostname|version|fetch(?:es|ed)?|read(?:s)?|calculat\w*|comput\w*)\b/iu;

/** The object of "just prints X" is a constant when it is a quoted literal,
 * a bare numeric literal, or a few bare words naming nothing computed. The
 * WHOLE object is scanned — a computed continuation after "and"/"then"
 * ("prints hello and then fetches the weather") is still a real program. */
export function isConstantPrintedObject(object: string): boolean {
	const trimmed = object.trim().replace(/[.!?]+$/u, "");
	if (!trimmed) return false;
	// A quoted constant must be the complete expression. Merely starting with a
	// quote is insufficient: `"hello" and then fetches the weather` still asks
	// for computed work. Accept escaped ASCII delimiters and paired typographic
	// delimiters, including a literal whose contents span lines.
	if (
		/^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|“[^”]*”|‘[^’]*’)$/su.test(
			trimmed,
		)
	) {
		return true;
	}
	const head =
		trimmed.split(/\s*(?:,|;|\band\b|\bthen\b|\bwhen\b|\bif\b)\s*/iu)[0] ?? "";
	// "just prints 42" is a constant, not a computation.
	if (/^(?:the\s+)?(?:number\s+)?\d+$/u.test(head)) {
		return !COMPUTED_OBJECT_RE.test(trimmed.replace(/\d+/gu, ""));
	}
	const words = head.split(/\s+/u).filter(Boolean);
	if (words.length === 0 || words.length > 4) return false;
	if (/\d/u.test(trimmed)) return false;
	return !COMPUTED_OBJECT_RE.test(trimmed);
}

export function looksLikeInlineCodeSnippetRequest(text: string): boolean {
	const normalized = text.toLowerCase();
	if (
		/\b(?:file|files|repo|repository|project|app|site|page|backend|frontend|deploy|build|run|execute|install|test|verify|fix|edit|modify|save|write\s+(?:to|in)\s+(?:\/|\.\/|[a-z]:\\))\b/iu.test(
			normalized,
		)
	) {
		return false;
	}
	// A script whose whole body is one constant statement ("a python script
	// that just prints nubs") is a snippet the reply can carry inline; routing
	// it through a coding sub-agent spent a 27s build and the user never saw
	// the one line (live 2026-08-22). Scoped by the just/only/simply marker so
	// computed deliverables ("prints a random card") still get built and run.
	// The printed OBJECT must itself be constant: a quoted literal, or a few
	// bare words with no path, URL, number or computed noun ("the current
	// bitcoin price", "the contents of /etc/hosts", "the primes under a
	// million" are real programs however the ask is phrased).
	// The printed object is captured to the END of the request — a capped
	// capture (formerly 80 chars) let a computed tail ("… and then fetches the
	// current bitcoin price") hide beyond the window, while a line-bounded
	// capture let the same tail hide after a newline. isConstantPrintedObject
	// scans the whole expression it receives.
	const constantOutputMatch =
		/\b(?:script|program)\b[\s\S]{0,40}\b(?:just|only|simply)\s+(?:prints?|says?|outputs?|echo(?:es)?|displays?|returns?)\s+([\s\S]*)/iu.exec(
			normalized,
		);
	const constantOutputScript =
		constantOutputMatch !== null &&
		isConstantPrintedObject(constantOutputMatch[1] ?? "");
	// The explicit just/only/simply form is eligible for inline handling only
	// when its complete object is constant. Do not let generic words such as
	// "simple" or "example" override a computed tail.
	if (constantOutputMatch !== null && !constantOutputScript) return false;
	const asksForSnippet =
		constantOutputScript ||
		/\b(?:write|give me|show me|generate|provide|create|make)\b[\s\S]{0,80}\b(?:code block|snippet|function|class|method|example|program|one[- ]?liner|hello world|fibonacci)\b/iu.test(
			normalized,
		) ||
		/\b(?:code block|snippet|function|class|method|example|program|one[- ]?liner|hello world|fibonacci)\b[\s\S]{0,80}\b(?:in|using|for)\s+(?:python|javascript|typescript|java|go|rust|ruby|bash|shell|c\+\+|c#|c\b|php|swift|kotlin)\b/iu.test(
			normalized,
		);
	const hasSmallScope =
		constantOutputScript ||
		/\b(?:hello world|fibonacci|fib|single|simple|short|small|tiny|example|snippet|function|code block|one[- ]?liner|\d+\s*[- ]?line)\b/iu.test(
			normalized,
		);
	return asksForSnippet && hasSmallScope;
}

export function looksLikeCreativeWritingRequest(text: string): boolean {
	const normalized = text.toLowerCase();
	if (!normalized.trim()) return false;
	const creativeObject =
		/\b(?:poem|haiku|sonnet|verse|story|joke|caption|tweet|post|song|lyrics|blurb|tagline)\b/iu.test(
			normalized,
		);
	if (!creativeObject) return false;
	return /\b(?:write|compose|draft|make|create|give me|generate)\b/iu.test(
		normalized,
	);
}

export function looksLikeCreativeCodingWorkRequest(text: string): boolean {
	const normalized = text.toLowerCase();
	if (
		/\b(?:poem|haiku|sonnet|verse|story|joke|song|lyrics)\b[\s\S]{0,80}\b(?:about|on|how|that|where|involving)\b[\s\S]{0,80}\b(?:app|site|page|project)\b/iu.test(
			normalized,
		)
	) {
		return false;
	}
	const codingObject =
		/\b(?:app|site|page|code|project|frontend|backend|cli|script)\b/iu;
	const codingVerb =
		/\b(?:build|code|implement|scaffold|program|develop|create|make|write|generate)\b/iu;
	return (
		(codingVerb.test(normalized) && codingObject.test(normalized)) ||
		/\b(?:app|site|page|project)\b[\s\S]{0,160}\b(?:that|which|where|with|for)\b/iu.test(
			normalized,
		)
	);
}
