import { hasOwnerAccess } from "@elizaos/agent/security/access";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { InboxTriageRepository } from "../inbox/repository.js";
import type { TriageEntry } from "../inbox/types.js";
import {
  canEgress,
  createLifeOpsEgressContext,
  type LifeOpsEgressContext,
  redactTextForEgress,
  redactUrlForEgress,
} from "../lifeops/privacy-egress.js";

const EMPTY: ProviderResult = {
  text: "",
  values: { inboxUnresolved: 0, inboxUrgent: 0 },
  data: {},
};

export const inboxTriageProvider: Provider = {
  name: "inboxTriage",
  description:
    "Injects pending inbox triage items into owner context. Shows urgent messages, " +
    "items needing reply, and recent auto-replies across all channels including email. " +
    "Use TRIAGE_MESSAGES for cross-channel triage, digest, respond, Gmail search/read, and Gmail draft/send reply workflows. " +
    "If the request is Gmail-only, TRIAGE_MESSAGES should use channel=gmail; if it is just 'my inbox', TRIAGE_MESSAGES should use the cross-channel path.",
  descriptionCompressed:
    "Pending inbox triage items across all channels incl email.",
  dynamic: true,
  position: 14, // after lifeops (12), before escalation (15)
  contexts: ["email", "messaging", "tasks"],
  contextGate: { anyOf: ["email", "messaging", "tasks"] },
  cacheScope: "turn",
  roleGate: { minRole: "OWNER" },

  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    if (!(await hasOwnerAccess(runtime, message))) {
      return EMPTY;
    }
    const egressContext = createLifeOpsEgressContext({
      isOwner: true,
      agentId: runtime.agentId,
      entityId: message.entityId,
    });

    let repo: InboxTriageRepository;
    try {
      repo = new InboxTriageRepository(runtime);
    } catch {
      return EMPTY;
    }

    let urgent: TriageEntry[];
    let needsReply: TriageEntry[];
    let recentAutoReplies: TriageEntry[];

    try {
      [urgent, needsReply, recentAutoReplies] = await Promise.all([
        repo.getByClassification("urgent", { limit: 5 }),
        repo.getByClassification("needs_reply", { limit: 10 }),
        repo.getRecentAutoReplies(5),
      ]);
    } catch (error) {
      logger.debug(
        "[inbox-triage-provider] DB query failed (schema may not exist yet):",
        String(error),
      );
      return EMPTY;
    }

    const unresolved = urgent.length + needsReply.length;
    if (unresolved === 0 && recentAutoReplies.length === 0) {
      return EMPTY;
    }

    const lines: string[] = [`# Inbox: ${unresolved} items pending`];

    if (urgent.length > 0) {
      lines.push("\n## Urgent");
      for (const item of urgent.slice(0, 3)) {
        lines.push(formatEntry(item, egressContext));
      }
    }

    if (needsReply.length > 0) {
      lines.push("\n## Needs Reply");
      for (const item of needsReply.slice(0, 5)) {
        lines.push(formatEntry(item, egressContext));
      }
    }

    if (recentAutoReplies.length > 0) {
      lines.push("\n## Recent Auto-Replies");
      for (const item of recentAutoReplies) {
        const draftPreview =
          canEgress(egressContext, "drafts") && item.draftResponse
            ? `"${item.draftResponse.slice(0, 60)}..."`
            : "(no draft)";
        lines.push(`- Sent to ${item.channelName}: ${draftPreview}`);
      }
    }

    lines.push("\nSay 'respond to [name/channel]' to draft and send replies.");

    return {
      text: lines.join("\n"),
      values: {
        inboxUnresolved: unresolved,
        inboxUrgent: urgent.length,
        inboxNeedsReply: needsReply.length,
      },
      data: {
        urgentItems: urgent.map((entry) =>
          filterTriageEntryForEgress(entry, egressContext),
        ),
        needsReplyItems: needsReply.map((entry) =>
          filterTriageEntryForEgress(entry, egressContext),
        ),
        recentAutoReplies: recentAutoReplies.map((entry) =>
          filterTriageEntryForEgress(entry, egressContext),
        ),
      },
    };
  },
};

function formatEntry(
  entry: TriageEntry,
  egressContext: LifeOpsEgressContext,
): string {
  const senderInfo = entry.senderName ? ` from ${entry.senderName}` : "";
  const deepLink = redactUrlForEgress(entry.deepLink, {
    context: egressContext,
  });
  const link = deepLink ? `\n  ${deepLink}` : "";
  const snippet = redactTextForEgress(entry.snippet.slice(0, 80), {
    context: egressContext,
    dataClass: "snippet",
  });
  return (
    `- **${entry.channelName}**${senderInfo} (${entry.source}): "${snippet}"` +
    link
  );
}

function filterTriageEntryForEgress(
  entry: TriageEntry,
  egressContext: LifeOpsEgressContext,
): TriageEntry {
  return {
    ...entry,
    deepLink: redactUrlForEgress(entry.deepLink, {
      context: egressContext,
    }),
    snippet: redactTextForEgress(entry.snippet, {
      context: egressContext,
      dataClass: "snippet",
    }),
    threadContext: canEgress(egressContext, "body")
      ? entry.threadContext
      : null,
    suggestedResponse: canEgress(egressContext, "drafts")
      ? entry.suggestedResponse
      : null,
    draftResponse: canEgress(egressContext, "drafts")
      ? entry.draftResponse
      : null,
  };
}
