/**
 * Classifies compact non-JSON model control records that must not reach a
 * user-visible channel. The recognizer stays deliberately narrow so ordinary
 * prose that mentions actions or tools is preserved.
 */

export type CompactUserVisibleControlEnvelope = "action" | "planner";
export type CompactUserVisibleControlStreamDecision =
	| "control"
	| "prose"
	| "undecided";

const TOOL_ACTION_NAME = /^(?:functions\.)?[A-Z][A-Z0-9_.:-]*$/u;
const LEADING_TOOL_FIELD_RE =
	/^(?:[-+]\s+)?(?:[{[(]\s*)?["'`*_]*(action|function|tool|name)["'`*_]*\s*[:=]\s*["'`]*((?:functions\.)?[A-Z][A-Z0-9_.:-]*)["'`]*/iu;
const ARGUMENT_FIELD_RE =
	/(?:^|[,;]\s*|\s+)["'`*_]*(?:parameters|params|arguments|args|input)["'`*_]*\s*[:=]\s*(?=\{|\[|"|'|[A-Za-z0-9_-])/iu;

/**
 * Identify a compact tool/action record by its leading field and runtime-style
 * uppercase action name. A terminal record or a second argument field is
 * required to avoid classifying prose headings such as `Action: BROWSER ...`.
 */
export function classifyCompactUserVisibleControlDialect(
	text: string,
): CompactUserVisibleControlEnvelope | undefined {
	const candidate = text.trim();
	if (!candidate || candidate.length > 20_000 || /\r?\n/u.test(candidate)) {
		return undefined;
	}
	const toolField = LEADING_TOOL_FIELD_RE.exec(candidate);
	const toolName = toolField?.[2] ?? "";
	if (!toolField || !TOOL_ACTION_NAME.test(toolName)) return undefined;

	const tail = candidate.slice(toolField[0].length).trim();
	const closesRecord = /^(?:[}\])]+\s*)?$/u.test(tail);
	if (!closesRecord && !ARGUMENT_FIELD_RE.test(tail)) return undefined;
	return toolField[1]?.toLowerCase() === "action" ? "action" : "planner";
}
const CONTROL_FIELD_NAMES = ["action", "function", "tool", "name"] as const;
const CONTROL_DECORATOR_RE = /["'`*_]/u;
const TOOL_TOKEN_CHAR_RE = /[A-Za-z0-9_.:-]/u;

/**
 * Decide whether a streamed plain-text prefix is definitely prose, already a
 * compact control record, or still ambiguous. Ambiguous bytes must stay held:
 * emitting them and rejecting only the terminal value leaks tool/action
 * syntax to chat and speech. Once a valid uppercase tool name is present we
 * conservatively hold the rest of that single line until an argument field,
 * newline, or terminal flush resolves it.
 */
export function classifyCompactUserVisibleControlStreamPrefix(
	text: string,
	final = false,
): CompactUserVisibleControlStreamDecision {
	const candidate = text.trimStart();
	if (!candidate) return final ? "prose" : "undecided";
	if (candidate.length > 20_000 || /\r?\n/u.test(candidate)) return "prose";

	let index = 0;
	if (
		(candidate[index] === "-" || candidate[index] === "+") &&
		/\s/u.test(candidate[index + 1] ?? "")
	) {
		index += 2;
		while (/\s/u.test(candidate[index] ?? "")) index += 1;
	}
	if (candidate[index] && "{[(".includes(candidate[index])) {
		index += 1;
		while (/\s/u.test(candidate[index] ?? "")) index += 1;
	}
	while (CONTROL_DECORATOR_RE.test(candidate[index] ?? "")) index += 1;

	const fieldStart = index;
	while (/[A-Za-z]/u.test(candidate[index] ?? "")) index += 1;
	const field = candidate.slice(fieldStart, index).toLowerCase();
	const possibleFields = CONTROL_FIELD_NAMES.filter((name) =>
		name.startsWith(field),
	);
	if (!field || possibleFields.length === 0) return "prose";
	if (
		!CONTROL_FIELD_NAMES.includes(field as (typeof CONTROL_FIELD_NAMES)[number])
	) {
		return index === candidate.length && !final ? "undecided" : "prose";
	}

	while (
		CONTROL_DECORATOR_RE.test(candidate[index] ?? "") ||
		/\s/u.test(candidate[index] ?? "")
	) {
		index += 1;
	}
	if (index === candidate.length) return final ? "prose" : "undecided";
	if (candidate[index] !== ":" && candidate[index] !== "=") return "prose";
	index += 1;
	while (
		CONTROL_DECORATOR_RE.test(candidate[index] ?? "") ||
		/\s/u.test(candidate[index] ?? "")
	) {
		index += 1;
	}
	if (index === candidate.length) return final ? "prose" : "undecided";

	const toolStart = index;
	while (TOOL_TOKEN_CHAR_RE.test(candidate[index] ?? "")) index += 1;
	const toolName = candidate.slice(toolStart, index);
	if (!toolName) return "prose";
	if (!TOOL_ACTION_NAME.test(toolName)) {
		const couldBecomeFunctionsPrefix =
			index === candidate.length && "functions.".startsWith(toolName);
		return !final && couldBecomeFunctionsPrefix ? "undecided" : "prose";
	}

	// A chunk ending exactly after the action name is not terminal: the next
	// chunk may append `, parameters: ...`. Hold until flush rather than
	// misclassifying an arbitrary token boundary as a complete record.
	if (index === candidate.length) {
		return final ? "control" : "undecided";
	}
	if (classifyCompactUserVisibleControlDialect(candidate)) return "control";
	return final ? "prose" : "undecided";
}
