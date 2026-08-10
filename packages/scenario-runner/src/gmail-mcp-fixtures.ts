/**
 * Deterministic fixture builders for the official Gmail MCP tool boundary,
 * shared by the messaging.gmail corpus and the personal-assistant scenario
 * suites. The curated tool union and write-tool list derive from the shared
 * Google Workspace MCP contract, so fixtures cannot drift from the catalog.
 * Fixtures model curated tool results only and intentionally expose no send,
 * spam, trash, permanent-delete, or batch-mutation operation; per-suite
 * message datasets stay with their suites — only types and builders live here.
 */

import type { ScenarioSeedStep } from "@elizaos/scenario-runner/schema";
import { GOOGLE_WORKSPACE_MCP_RESOURCES } from "@elizaos/shared/contracts";

export type GmailMcpMessage = {
  id: string;
  threadId: string;
  subject: string;
  sender: string;
  toRecipients: string[];
  ccRecipients?: string[];
  snippet: string;
  date: string;
  labelIds: string[];
  plaintextBody: string;
  attachments?: Array<{
    id: string;
    filename: string;
    mimeType: string;
  }>;
};

const GMAIL_TOOL_CAPABILITIES = GOOGLE_WORKSPACE_MCP_RESOURCES.gmail.tools;

/** A curated official Gmail MCP tool name, from the shared contract catalog. */
export type GmailCuratedTool = keyof typeof GMAIL_TOOL_CAPABILITIES;

/** Curated Gmail tools that mutate mailbox state (capability beyond gmail.read). */
export const GMAIL_MCP_WRITE_TOOLS: string[] = Object.entries(
  GMAIL_TOOL_CAPABILITIES,
)
  .filter(([, capability]) => capability !== "gmail.read")
  .map(([tool]) => tool);

export function gmailMcpFixture(args: {
  tool: GmailCuratedTool;
  arguments?: Record<string, unknown>;
  structuredContent?: Record<string, unknown>;
  contentText?: string;
  isError?: boolean;
  repeat?: boolean;
  clearLedger?: boolean;
  name?: string;
}): ScenarioSeedStep {
  return {
    type: "mcpFixture",
    provider: "google",
    resource: "gmail",
    tool: args.tool,
    ...(args.arguments ? { arguments: args.arguments } : {}),
    result: {
      ...(args.structuredContent
        ? { structuredContent: args.structuredContent }
        : {}),
      ...(args.contentText
        ? { content: [{ type: "text" as const, text: args.contentText }] }
        : {}),
      ...(args.isError !== undefined ? { isError: args.isError } : {}),
    },
    ...(args.repeat ? { repeat: true } : {}),
    ...(args.clearLedger !== undefined
      ? { clearLedger: args.clearLedger }
      : {}),
    ...(args.name ? { name: args.name } : {}),
  };
}

export function gmailSearchFixture(
  messages: GmailMcpMessage[],
  args?: {
    query?: string;
    repeat?: boolean;
    clearLedger?: boolean;
    name?: string;
  },
): ScenarioSeedStep {
  const threads = new Map<
    string,
    { id: string; messages: GmailMcpMessage[] }
  >();
  for (const message of messages) {
    const thread = threads.get(message.threadId) ?? {
      id: message.threadId,
      messages: [],
    };
    thread.messages.push(message);
    threads.set(message.threadId, thread);
  }
  return gmailMcpFixture({
    tool: "search_threads",
    ...(args?.query ? { arguments: { query: args.query } } : {}),
    structuredContent: { threads: [...threads.values()] },
    ...(args?.repeat ? { repeat: true } : {}),
    ...(args?.clearLedger !== undefined
      ? { clearLedger: args.clearLedger }
      : {}),
    ...(args?.name ? { name: args.name } : {}),
  });
}

export function gmailThreadFixture(
  messages: GmailMcpMessage[],
): ScenarioSeedStep {
  const threadId = messages[0]?.threadId;
  if (!threadId || messages.some((message) => message.threadId !== threadId)) {
    throw new Error("Gmail thread fixtures require one non-empty thread");
  }
  return gmailMcpFixture({
    tool: "get_thread",
    arguments: { threadId },
    structuredContent: { thread: { id: threadId, messages } },
    repeat: true,
  });
}

export function gmailGetMessageFixture(
  message: GmailMcpMessage,
  args?: { repeat?: boolean; clearLedger?: boolean; name?: string },
): ScenarioSeedStep {
  return gmailMcpFixture({
    tool: "get_message",
    arguments: { messageId: message.id },
    structuredContent: { message },
    ...(args?.repeat ? { repeat: true } : {}),
    ...(args?.clearLedger !== undefined
      ? { clearLedger: args.clearLedger }
      : {}),
    ...(args?.name ? { name: args.name } : {}),
  });
}

export function gmailCreateDraftFixture(args?: {
  arguments?: Record<string, unknown>;
  draftId?: string;
  threadId?: string;
  repeat?: boolean;
  clearLedger?: boolean;
  name?: string;
}): ScenarioSeedStep {
  return gmailMcpFixture({
    tool: "create_draft",
    ...(args?.arguments ? { arguments: args.arguments } : {}),
    structuredContent: {
      draft: {
        id: args?.draftId ?? "draft-scenario",
        threadId: args?.threadId ?? "thread-scenario-draft",
      },
    },
    ...(args?.repeat ? { repeat: true } : {}),
    ...(args?.clearLedger !== undefined
      ? { clearLedger: args.clearLedger }
      : {}),
    ...(args?.name ? { name: args.name } : {}),
  });
}
