/**
 * Classify compact, non-JSON model control records that are unsafe to display.
 *
 * Some OpenAI-compatible models collapse the planner dialect onto one line
 * (`action: BROWSER, parameters: {...}`) or use assignment separators. The
 * structured JSON parser cannot see those records, while treating arbitrary
 * prose containing the word "action" as control would be too broad. This
 * helper therefore requires a record-shaped leading tool key, an uppercase
 * runtime action name, and either a terminal scalar or a second argument key.
 */

export type CompactUserVisibleControlEnvelope = "action" | "planner";

const TOOL_ACTION_NAME = /^(?:functions\.)?[A-Z][A-Z0-9_.:-]*$/u;
const LEADING_TOOL_FIELD_RE =
	/^(?:[{[(]\s*)?["'`*_]*(action|function|tool|name)["'`*_]*\s*[:=]\s*["'`]*((?:functions\.)?[A-Z][A-Z0-9_.:-]*)["'`]*/iu;
const ARGUMENT_FIELD_RE =
	/(?:^|[,;]\s*|\s+)["'`*_]*(?:parameters|params|arguments|args|input)["'`*_]*\s*[:=]\s*(?=\{|\[|"|'|[A-Za-z0-9_-])/iu;

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
