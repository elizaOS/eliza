import {
  type Memory,
  type ResponseHandlerEvaluator,
  SIMPLE_CONTEXT_ID,
} from "@elizaos/core";

const SUB_AGENT_SOURCE = "sub_agent";
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'`)\]*]+/g;

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

function hasStrings(values: readonly string[] | undefined): boolean {
  return (
    Array.isArray(values) && values.some((value) => value.trim().length > 0)
  );
}

function hasUrl(text: string): boolean {
  URL_IN_TEXT_RE.lastIndex = 0;
  return URL_IN_TEXT_RE.test(text);
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
) {
  const body = stripRouterAnnotations(completionText);
  if (!body) return undefined;
  if (currentReply.length === 0) return body;
  if (!hasUrl(currentReply) && hasUrl(body)) return body;
  return undefined;
}

export const subAgentCompletionResponseEvaluator: ResponseHandlerEvaluator = {
  name: "agent-orchestrator.sub-agent-completion",
  description:
    "Routes verified sub-agent task_complete messages to direct replies when Stage 1 did not request a concrete follow-up action.",
  priority: 10,
  shouldRun: ({ message, messageHandler }) => {
    if (!isSuccessfulSubAgentCompletion(message)) return false;
    if (messageHandler.processMessage !== "RESPOND") return false;
    if (hasStrings(messageHandler.plan.candidateActions)) return false;
    if (hasStrings(messageHandler.plan.parentActionHints)) return false;
    return true;
  },
  evaluate: ({ message, messageHandler }) => {
    const currentReply = textOf(messageHandler.plan.reply);
    const completionText = textOf(contentRecord(message)?.text);
    const reply = replyPatchFromCompletion(currentReply, completionText);
    return {
      requiresTool: false,
      setContexts: [SIMPLE_CONTEXT_ID],
      ...(reply ? { reply } : {}),
      debug: [
        "verified sub-agent completion has no requested follow-up action; using direct reply",
      ],
    };
  },
};
