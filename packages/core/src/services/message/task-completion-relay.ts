/** Recognizes structured sub-agent completion relays and preserves their reported result text. */
import { toWellFormedUnicode } from "../../utils/well-formed";

/**
 * The completed-result body of a sub-agent `task_complete` relay message, or
 * undefined when the text is not such a relay or carries no body. The relay
 * format is `[sub-agent: … — task_complete — …]\n<result body>` (see
 * plugin-agent-orchestrator's sub-agent-router): the bracketed first segment
 * is a planner-only directive and never user-facing; the body below it is the
 * sub-agent's finished result, already composed for user delivery. Lets a
 * failed relay turn deliver the completed result instead of discarding it for
 * the generic failed-tool fallback (#18208).
 */
export function subAgentCompletionRelayBody(
	text: string | undefined,
): string | undefined {
	const parsed = parseSubAgentTaskCompleteRelay(text);
	if (!parsed) return undefined;
	const { trimmed, headerEnd } = parsed;
	const body = trimmed.slice(headerEnd + 1).trim();
	if (!body) return undefined;
	return toWellFormedUnicode(body);
}

/**
 * Parses the complete bracketed status header emitted by the sub-agent router.
 * Status matching stays inside that header and requires either the compact
 * legacy form or the router's delimited status field; task text and result
 * bodies are untrusted prose and cannot classify a relay as complete.
 */
export function parseSubAgentTaskCompleteRelay(
	text: string | undefined,
): { trimmed: string; headerEnd: number } | undefined {
	if (!text) return undefined;
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("[sub-agent:")) return undefined;
	const compactHeader = "[sub-agent:task_complete]";
	if (trimmed.startsWith(compactHeader)) {
		return { trimmed, headerEnd: compactHeader.length - 1 };
	}
	const lineEnd = trimmed.indexOf("\n");
	if (lineEnd < 0) return undefined;
	const headerLine = trimmed.slice(0, lineEnd).trimEnd();
	if (!headerLine.endsWith("]")) return undefined;
	const headerEnd = headerLine.length - 1;
	const header = trimmed.slice(0, headerEnd + 1);
	const inner = header.slice("[sub-agent:".length, -1).trim();
	const routeDelimiters = [...inner.matchAll(/\([^()\r\n]+\)\s—\s*/gu)];
	const finalDelimiter = routeDelimiters.at(-1);
	if (finalDelimiter?.index === undefined) return undefined;
	const routedStatus = inner.slice(
		finalDelimiter.index + finalDelimiter[0].length,
	);
	return /^task_complete(?:\s—|$)/iu.test(routedStatus)
		? { trimmed, headerEnd }
		: undefined;
}
