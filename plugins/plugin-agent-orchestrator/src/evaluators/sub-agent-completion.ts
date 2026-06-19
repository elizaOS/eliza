import {
  type AgentContext,
  type Memory,
  type MessageHandlerResult,
  type ResponseHandlerEvaluator,
  SIMPLE_CONTEXT_ID,
} from "@elizaos/core";

const SUB_AGENT_SOURCE = "sub_agent";
const EMPTY_COMPLETION_PLACEHOLDER =
  "sub-agent reports task complete (no captured output).";
// When the evaluator routes back to TASKS_SEND_TO_AGENT or TASKS_SPAWN_AGENT,
// the active context must satisfy their contextGate. TASKS declares coding /
// automation / agent-internal contexts, so we set `automation` — picking a
// context outside that set causes
// `executePlannedToolCall` to reject with "Action TASKS_* is not allowed
// in the current context".
const ORCHESTRATOR_CONTEXT_ID = "automation" as AgentContext;
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'`)\]*]+/g;
const TOOL_OUTPUT_END_MARKER = "[/tool output]";
const TOOL_FAILURE_MARKER_RE =
  /\b(?:command not found|permission denied|no such file or directory|timed? out|timeout|exited with code|exit code [1-9]\d*|non[-\s]?zero exit|could not find|unable to find)\b/i;
const NO_RESULT_MARKER_RE =
  /\b(?:no files? found|no matching files?|no matches? found|found no files?|nothing found)\b/i;
const POSITIVE_QUANTITATIVE_EVIDENCE_RE =
  /\b(?:found|located|matched|identified|listed|returned|there (?:are|were)|total(?:ed)?|count(?:\s+is)?|contains?)\s+(?:[1-9]\d*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|[a-z]+(?:ty|teen))\b/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function contentRecord(message: Memory): Record<string, unknown> | undefined {
  return asRecord(message.content);
}

function metadataRecord(message: Memory): Record<string, unknown> | undefined {
  return asRecord(contentRecord(message)?.metadata);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArrayOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => textOf(entry))
    .filter((entry) => entry.length > 0);
}

function hasStrings(values: readonly string[] | undefined): boolean {
  return (
    Array.isArray(values) && values.some((value) => value.trim().length > 0)
  );
}

function normalizedActionHints(
  values: readonly string[] | undefined,
): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value.length > 0);
}

function hasOnlyStaleCompletionHints(values: readonly string[] | undefined) {
  const hints = normalizedActionHints(values);
  return (
    hints.length > 0 &&
    hints.every(
      (hint) =>
        hint === "TASKS" ||
        hint === "ATTACHMENT" ||
        hint === "SPAWN_AGENT" ||
        hint === "TASKS_SPAWN_AGENT",
    )
  );
}

function hasUrl(text: string): boolean {
  URL_IN_TEXT_RE.lastIndex = 0;
  return URL_IN_TEXT_RE.test(text);
}

function hasUserFacingUrl(text: string): boolean {
  URL_IN_TEXT_RE.lastIndex = 0;
  for (const match of text.matchAll(URL_IN_TEXT_RE)) {
    const url = parseUrl(match[0]);
    if (url && !isLoopbackHost(url.hostname)) return true;
  }
  return false;
}

function hasLoopbackUrl(text: string): boolean {
  URL_IN_TEXT_RE.lastIndex = 0;
  for (const match of text.matchAll(URL_IN_TEXT_RE)) {
    const url = parseUrl(match[0]);
    if (url && isLoopbackHost(url.hostname)) return true;
  }
  return false;
}

function isEmptyCompletionPlaceholder(text: string): boolean {
  return text.trim().toLowerCase() === EMPTY_COMPLETION_PLACEHOLDER;
}

function appendVerifiedUrl(reply: string, verifiedUrl: string): string {
  const trimmed = reply.trim();
  return trimmed ? `${trimmed}\n${verifiedUrl}` : verifiedUrl;
}

function cleanCompletionReply(reply: string | undefined): string | undefined {
  const trimmed = reply?.trim();
  if (!trimmed) return trimmed;
  const statusPrefixes = ["✅ ", "❌ ", "🚀 ", "💬 ", "⏳ ", "⚠️ "];
  const prefix = statusPrefixes.find((candidate) =>
    trimmed.startsWith(candidate),
  );
  return prefix ? trimmed.slice(prefix.length).trimStart() : trimmed;
}

function stripLoopbackUrlLines(reply: string, verifiedUrl: string): string {
  const retained = reply
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !hasLoopbackUrl(line));
  const cleaned = cleanCompletionReply(retained.join("\n")) ?? "";
  return hasUrl(cleaned) ? cleaned : appendVerifiedUrl(cleaned, verifiedUrl);
}

function bodyIsOnlyUrls(text: string): boolean {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.length > 0 &&
    lines.every((line) => {
      try {
        return new URL(line).toString().length > 0;
      } catch {
        return false;
      }
    })
  );
}

// Match absolute Unix paths under a well-known top-level directory. The
// anchored TLD set avoids false matches on URL paths (`/admin`), regex
// literals (`/^foo$/`), and bullets starting with `/` while still catching
// path leaks from Read/Bash/Edit tool transcripts.
const RAW_TOOL_PATH_RE =
  /^\/(?:Users|home|root|var|tmp|opt|etc|usr|private|mnt|srv)\/[^\s]+/m;

function looksLikeRawToolTranscript(text: string): boolean {
  return (
    text.includes("[tool output:") ||
    text.includes("[/tool output]") ||
    text.includes("Full output saved to:") ||
    RAW_TOOL_PATH_RE.test(text)
  );
}

function userFacingVerifiedUrl(urls: readonly string[]): string | undefined {
  const parsed = urls
    .map((url) => {
      try {
        return { url, parsed: new URL(url) };
      } catch {
        return undefined;
      }
    })
    .filter(
      (entry): entry is { url: string; parsed: URL } => entry !== undefined,
    );
  return (
    parsed.find((entry) => !isLoopbackHost(entry.parsed.hostname))?.url ??
    parsed[0]?.url
  );
}

function replyMentionsVerifiedUrl(reply: string, verifiedUrl: string): boolean {
  const trimmedReply = reply.trim();
  if (!trimmedReply) return false;
  if (trimmedReply.includes(verifiedUrl)) return true;
  const verified = parseUrl(verifiedUrl);
  if (!verified) return false;
  URL_IN_TEXT_RE.lastIndex = 0;
  for (const match of trimmedReply.matchAll(URL_IN_TEXT_RE)) {
    const candidate = parseUrl(match[0]);
    if (candidate?.toString() === verified.toString()) return true;
  }
  return false;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function looksLikeCapturedToolOutput(text: string): boolean {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const firstLine = lines[0]?.trim() ?? "";
  if (!firstLine.startsWith("[tool output:") || !firstLine.endsWith("]"))
    return false;
  if (lines.some((line) => line.trim().startsWith(TOOL_OUTPUT_END_MARKER))) {
    return capturedToolOutputBlocksOnly(lines);
  }
  const body = lines.slice(1).join("\n").trim();
  return body.length > 0;
}

function tailAfterEndMarker(line: string): string {
  const idx = line.indexOf(TOOL_OUTPUT_END_MARKER);
  return idx >= 0 ? line.slice(idx + TOOL_OUTPUT_END_MARKER.length).trim() : "";
}

function partitionToolOutputBlocks(lines: string[]): {
  remainder: string[];
  sawToolOutput: boolean;
  unclosed: boolean;
} {
  let insideToolOutput = false;
  let sawToolOutput = false;
  const remainder: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!insideToolOutput && trimmed.startsWith("[tool output:")) {
      insideToolOutput = true;
      sawToolOutput = true;
      continue;
    }
    if (insideToolOutput && trimmed.startsWith(TOOL_OUTPUT_END_MARKER)) {
      insideToolOutput = false;
      const after = tailAfterEndMarker(line);
      if (after) remainder.push(after);
      continue;
    }
    if (!insideToolOutput) remainder.push(line);
  }
  return { remainder, sawToolOutput, unclosed: insideToolOutput };
}

function capturedToolOutputBlocksOnly(lines: string[]): boolean {
  const { remainder, sawToolOutput, unclosed } =
    partitionToolOutputBlocks(lines);
  return sawToolOutput && !unclosed && remainder.join("\n").trim() === "";
}

function userFacingCompletionBody(text: string): string {
  const body = stripRouterAnnotations(text);
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  if (!lines.some((line) => line.trim().startsWith(TOOL_OUTPUT_END_MARKER))) {
    return body;
  }
  const { remainder } = partitionToolOutputBlocks(lines);
  const userText = remainder.join("\n").trim();
  return userText || body;
}

function hasCleanFinalProseAfterToolOutput(text: string): boolean {
  const body = stripRouterAnnotations(text);
  if (
    !body.includes("[tool output:") ||
    !body.includes(TOOL_OUTPUT_END_MARKER)
  ) {
    return false;
  }
  const userText = userFacingCompletionBody(text);
  return (
    userText.length > 0 &&
    !isEmptyCompletionPlaceholder(userText) &&
    !looksLikeRawToolTranscript(userText)
  );
}

function stripRouterAnnotations(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const body =
    lines[0]?.startsWith("[sub-agent:") === true ? lines.slice(1) : lines;
  const annotationIndex = body.findIndex((line) =>
    line.startsWith("[verification:"),
  );
  return (annotationIndex >= 0 ? body.slice(0, annotationIndex) : body)
    .join("\n")
    .trim();
}

function completionHasVerificationFailure(text: string): boolean {
  return (
    text.includes("[verification:") ||
    text.includes("NOT reachable") ||
    text.includes("do NOT tell the user the app is live")
  );
}

function completionHasFailureMarkerWithoutPositiveEvidence(
  text: string,
  verifiedUrls: readonly string[] = [],
): boolean {
  const body = userFacingCompletionBody(text);
  const fullText = stripRouterAnnotations(text);
  const searchable = [body, fullText].filter(Boolean).join("\n");
  if (verifiedUrls.length > 0 || hasUserFacingUrl(searchable)) return false;
  if (POSITIVE_QUANTITATIVE_EVIDENCE_RE.test(searchable)) return false;
  if (TOOL_FAILURE_MARKER_RE.test(searchable)) return true;
  return NO_RESULT_MARKER_RE.test(fullText) && !NO_RESULT_MARKER_RE.test(body);
}

function verifiedUrlsFromMetadata(message: Memory): string[] {
  return stringArrayOf(metadataRecord(message)?.subAgentVerifiedUrls);
}

function deliverableFromMetadata(message: Memory): string | undefined {
  const value = textOf(metadataRecord(message)?.subAgentDeliverable);
  return value.length > 0 ? value : undefined;
}

function isSuccessfulSubAgentCompletion(message: Memory): boolean {
  const content = contentRecord(message);
  const metadata = metadataRecord(message);
  if (!content || !metadata) return false;
  const source = textOf(content.source).toLowerCase();
  if (source !== SUB_AGENT_SOURCE && metadata.subAgent !== true) return false;
  if (textOf(metadata.subAgentEvent) !== "task_complete") return false;
  if (metadata.subAgentCapExceeded === true) return false;
  return !completionHasVerificationFailure(textOf(content.text));
}

function replyPatchFromCompletion(
  currentReply: string,
  completionText: string,
  verifiedUrls: readonly string[] = [],
  preferCurrentReplyForUrlOnlyCompletion = false,
) {
  const body = userFacingCompletionBody(completionText);
  const verifiedUrl = userFacingVerifiedUrl(verifiedUrls);
  const cleanBody = body && !looksLikeRawToolTranscript(body) ? body : "";
  const cleanCurrentReply = !looksLikeRawToolTranscript(currentReply)
    ? currentReply
    : "";
  if (!body && !verifiedUrl) return undefined;
  if (isEmptyCompletionPlaceholder(body)) return verifiedUrl;
  if (verifiedUrl && cleanCurrentReply && hasLoopbackUrl(cleanCurrentReply)) {
    const bodyWithoutLoopback =
      cleanBody && !bodyIsOnlyUrls(cleanBody) && hasLoopbackUrl(cleanBody)
        ? stripLoopbackUrlLines(cleanBody, verifiedUrl)
        : undefined;
    return (
      bodyWithoutLoopback ??
      stripLoopbackUrlLines(cleanCurrentReply, verifiedUrl)
    );
  }
  if (
    verifiedUrl &&
    cleanBody &&
    !bodyIsOnlyUrls(cleanBody) &&
    hasLoopbackUrl(cleanBody)
  ) {
    return stripLoopbackUrlLines(cleanBody, verifiedUrl);
  }
  if (
    verifiedUrl &&
    cleanCurrentReply &&
    !bodyIsOnlyUrls(cleanCurrentReply) &&
    replyMentionsVerifiedUrl(cleanCurrentReply, verifiedUrl)
  ) {
    return cleanCurrentReply;
  }
  if (
    verifiedUrl &&
    preferCurrentReplyForUrlOnlyCompletion &&
    cleanCurrentReply &&
    !hasUrl(cleanCurrentReply) &&
    bodyIsOnlyUrls(cleanBody)
  ) {
    return appendVerifiedUrl(cleanCurrentReply, verifiedUrl);
  }
  if (verifiedUrl && looksLikeRawToolTranscript(completionText)) {
    if (
      cleanBody &&
      !looksLikeCapturedToolOutput(cleanBody) &&
      !looksLikeRawToolTranscript(cleanBody) &&
      hasUserFacingUrl(cleanBody)
    ) {
      return cleanBody;
    }
    return verifiedUrl;
  }
  if (verifiedUrl && bodyIsOnlyUrls(cleanBody)) return verifiedUrl;
  if (
    cleanBody &&
    !looksLikeCapturedToolOutput(cleanBody) &&
    hasUserFacingUrl(cleanBody)
  ) {
    return cleanBody;
  }
  if (verifiedUrl) return verifiedUrl;
  if (hasUrl(cleanCurrentReply)) return cleanCurrentReply;
  if (cleanCurrentReply.length === 0) return cleanBody || body;
  if (!hasUrl(currentReply) && cleanBody && hasUrl(cleanBody)) return cleanBody;
  return cleanBody || body;
}

function hasVerifiedCompletionReply(
  currentReply: string,
  completionText: string,
  verifiedUrls: readonly string[] = [],
) {
  const body = userFacingCompletionBody(completionText);
  if (isEmptyCompletionPlaceholder(body)) {
    return (
      hasUrl(currentReply) || userFacingVerifiedUrl(verifiedUrls) !== undefined
    );
  }
  return (
    hasUrl(currentReply) ||
    hasUrl(body) ||
    userFacingVerifiedUrl(verifiedUrls) !== undefined
  );
}

function respondIfNeeded(messageHandler: MessageHandlerResult) {
  return messageHandler.processMessage === "RESPOND"
    ? {}
    : { processMessage: "RESPOND" as const };
}

export const subAgentCompletionResponseEvaluator: ResponseHandlerEvaluator = {
  name: "agent-orchestrator.sub-agent-completion",
  description:
    "Routes verified sub-agent task_complete messages to direct replies unless Stage 1 requested a concrete follow-up action.",
  priority: 10,
  shouldRun: ({ message, messageHandler }) => {
    if (!isSuccessfulSubAgentCompletion(message)) return false;
    if (messageHandler.processMessage === "STOP") return false;
    const currentReply = textOf(messageHandler.plan.reply);
    const completionText = textOf(contentRecord(message)?.text);
    const verifiedUrls = verifiedUrlsFromMetadata(message);
    if (
      completionHasFailureMarkerWithoutPositiveEvidence(
        completionText,
        verifiedUrls,
      )
    ) {
      return true;
    }
    if (deliverableFromMetadata(message) !== undefined) return true;
    if (hasVerifiedCompletionReply(currentReply, completionText, verifiedUrls))
      return true;
    if (hasCleanFinalProseAfterToolOutput(completionText)) return true;
    const hasConcreteFollowUp =
      hasStrings(messageHandler.plan.candidateActions) &&
      !hasOnlyStaleCompletionHints(messageHandler.plan.candidateActions);
    const hasConcreteParentHint =
      hasStrings(messageHandler.plan.parentActionHints) &&
      !hasOnlyStaleCompletionHints(messageHandler.plan.parentActionHints);
    if (hasConcreteFollowUp || hasConcreteParentHint) return false;
    return true;
  },
  evaluate: ({ message, messageHandler }) => {
    const currentReply = textOf(messageHandler.plan.reply);
    const completionText = textOf(contentRecord(message)?.text);
    const verifiedUrls = verifiedUrlsFromMetadata(message);
    // The deliverable IS the sub-agent's printed/tool output (short, single
    // block; the router stripped it from the narration). Relay it verbatim
    // rather than letting the parent model re-summarize or truncate it.
    const deliverable = deliverableFromMetadata(message);
    if (deliverable !== undefined) {
      return {
        ...respondIfNeeded(messageHandler),
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply: deliverable,
        debug: [
          "verified sub-agent completion carries a captured deliverable; relaying it verbatim",
        ],
      };
    }
    if (
      completionHasFailureMarkerWithoutPositiveEvidence(
        completionText,
        verifiedUrls,
      )
    ) {
      return {
        ...respondIfNeeded(messageHandler),
        requiresTool: true,
        setContexts: [ORCHESTRATOR_CONTEXT_ID],
        clearReply: true,
        addCandidateActions: ["TASKS_SEND_TO_AGENT"],
        addParentActionHints: ["TASKS"],
        debug: [
          "sub-agent completion contains failure markers without clear positive evidence; routing back through TASKS for grounded follow-up",
        ],
      };
    }
    const reply = cleanCompletionReply(
      replyPatchFromCompletion(
        currentReply,
        completionText,
        verifiedUrls,
        messageHandler.plan.requiresTool === false &&
          !hasStrings(messageHandler.plan.candidateActions) &&
          !hasStrings(messageHandler.plan.parentActionHints),
      ),
    );
    if (
      isEmptyCompletionPlaceholder(userFacingCompletionBody(completionText))
    ) {
      if (!reply && !hasUrl(currentReply)) {
        return {
          processMessage: "IGNORE",
          requiresTool: false,
          clearReply: true,
          clearCandidateActions: true,
          clearParentActionHints: true,
          debug: [
            "verified sub-agent completion had no captured output; suppressing empty reply",
          ],
        };
      }
    }
    if (reply && hasUrl(reply)) {
      return {
        ...respondIfNeeded(messageHandler),
        requiresTool: false,
        setContexts: [SIMPLE_CONTEXT_ID],
        clearCandidateActions: true,
        clearParentActionHints: true,
        reply,
        debug: [
          "verified sub-agent completion has no concrete follow-up action; using direct reply",
        ],
      };
    }
    const completionBody = stripRouterAnnotations(completionText);
    if (looksLikeCapturedToolOutput(completionBody)) {
      return {
        ...respondIfNeeded(messageHandler),
        requiresTool: true,
        setContexts: [ORCHESTRATOR_CONTEXT_ID],
        clearReply: true,
        addCandidateActions: ["TASKS_SEND_TO_AGENT"],
        addParentActionHints: ["TASKS"],
        debug: [
          "verified sub-agent completion only contains captured tool output; routing back through TASKS for follow-up",
        ],
      };
    }
    // Prose-and-tool-output mixed: looksLikeCapturedToolOutput requires the
    // body to start with `[tool output:` but real sub-agents intersperse
    // tool blocks with prose ("Site located at X. Now reading...
    // [tool output: ...] ..."). Check `looksLikeRawToolTranscript` against
    // the user-facing body (tool output blocks stripped) — if that still
    // contains raw transcript markers (e.g. "Full output saved to:" line
    // or an absolute path leak outside any tool block), route through
    // TASKS_SEND_TO_AGENT for a clean summary. When the stripped body is
    // clean prose, the final block of the previous `if` falls through to
    // the direct-reply branch below.
    const userFacingBody = userFacingCompletionBody(completionText);
    if (looksLikeRawToolTranscript(userFacingBody)) {
      return {
        ...respondIfNeeded(messageHandler),
        requiresTool: true,
        setContexts: [ORCHESTRATOR_CONTEXT_ID],
        clearReply: true,
        addCandidateActions: ["TASKS_SEND_TO_AGENT"],
        addParentActionHints: ["TASKS"],
        debug: [
          "verified sub-agent completion contains raw tool transcript markers; routing back through TASKS for summarization",
        ],
      };
    }
    return {
      ...respondIfNeeded(messageHandler),
      requiresTool: false,
      setContexts: [SIMPLE_CONTEXT_ID],
      clearCandidateActions: true,
      clearParentActionHints: true,
      ...(reply ? { reply } : {}),
      debug: [
        "verified sub-agent completion has no concrete follow-up action; using direct reply",
      ],
    };
  },
};
