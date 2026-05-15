import {
  type AgentContext,
  type Memory,
  type MessageHandlerResult,
  type ResponseHandlerEvaluator,
  SIMPLE_CONTEXT_ID,
} from "@elizaos/core";

const SUB_AGENT_SOURCE = "sub_agent";
const GENERAL_CONTEXT_ID = "general" as AgentContext;
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'`)\]*]+/g;
const TOOL_OUTPUT_END_MARKER = "[/tool output]";

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
    try {
      if (!isLoopbackHost(new URL(match[0]).hostname)) return true;
    } catch {}
  }
  return false;
}

function looksLikeRawToolTranscript(text: string): boolean {
  return (
    text.includes("[tool output:") ||
    text.includes("[/tool output]") ||
    text.includes("Full output saved to:") ||
    /^\/[^\s]+/m.test(text)
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

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function looksLikeCapturedToolOutput(text: string): boolean {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const firstLine = lines[0]?.trim() ?? "";
  if (!firstLine.startsWith("[tool output:") || !firstLine.endsWith("]"))
    return false;
  if (lines.some((line) => line.trim() === TOOL_OUTPUT_END_MARKER)) {
    return capturedToolOutputBlocksOnly(lines);
  }
  const body = lines.slice(1).join("\n").trim();
  return body.length > 0;
}

function capturedToolOutputBlocksOnly(lines: string[]): boolean {
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
    if (insideToolOutput && trimmed === TOOL_OUTPUT_END_MARKER) {
      insideToolOutput = false;
      continue;
    }
    if (!insideToolOutput) {
      remainder.push(line);
    }
  }
  return (
    sawToolOutput && !insideToolOutput && remainder.join("\n").trim() === ""
  );
}

function userFacingCompletionBody(text: string): string {
  const body = stripRouterAnnotations(text);
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  if (!lines.some((line) => line.trim() === TOOL_OUTPUT_END_MARKER)) {
    return body;
  }
  let insideToolOutput = false;
  const remainder: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!insideToolOutput && trimmed.startsWith("[tool output:")) {
      insideToolOutput = true;
      continue;
    }
    if (insideToolOutput && trimmed === TOOL_OUTPUT_END_MARKER) {
      insideToolOutput = false;
      continue;
    }
    if (!insideToolOutput) remainder.push(line);
  }
  const userText = remainder.join("\n").trim();
  return userText || body;
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

function verifiedUrlsFromMetadata(message: Memory): string[] {
  return stringArrayOf(metadataRecord(message)?.subAgentVerifiedUrls);
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
) {
  const body = userFacingCompletionBody(completionText);
  const verifiedUrl = userFacingVerifiedUrl(verifiedUrls);
  const cleanBody = body && !looksLikeRawToolTranscript(body) ? body : "";
  if (!body && !verifiedUrl) return undefined;
  if (verifiedUrl && looksLikeRawToolTranscript(completionText)) {
    return verifiedUrl;
  }
  if (
    cleanBody &&
    !looksLikeCapturedToolOutput(cleanBody) &&
    hasUserFacingUrl(cleanBody)
  ) {
    return cleanBody;
  }
  if (verifiedUrl) return verifiedUrl;
  if (hasUrl(currentReply)) return currentReply;
  if (currentReply.length === 0) return cleanBody || body;
  if (!hasUrl(currentReply) && cleanBody && hasUrl(cleanBody)) return cleanBody;
  return cleanBody || body;
}

function hasVerifiedCompletionReply(
  currentReply: string,
  completionText: string,
  verifiedUrls: readonly string[] = [],
) {
  const body = userFacingCompletionBody(completionText);
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
    if (hasVerifiedCompletionReply(currentReply, completionText, verifiedUrls))
      return true;
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
    const reply = replyPatchFromCompletion(
      currentReply,
      completionText,
      verifiedUrls,
    );
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
        setContexts: [GENERAL_CONTEXT_ID],
        clearReply: true,
        addCandidateActions: ["TASKS_SEND_TO_AGENT"],
        addParentActionHints: ["TASKS"],
        debug: [
          "verified sub-agent completion only contains captured tool output; routing back through TASKS for follow-up",
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
