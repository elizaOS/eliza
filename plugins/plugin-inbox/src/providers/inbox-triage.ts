import { hasOwnerAccess } from "@elizaos/agent";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { InboxRepository } from "../inbox/repository.ts";
import type { TriageEntry } from "../inbox/types.ts";

const EMPTY: ProviderResult = {
  text: "",
  values: { inboxUnresolved: 0, inboxUrgent: 0 },
  data: {},
};

/**
 * inboxTriage provider — injects pending inbox triage items into owner context.
 *
 * Owner-only (`roleGate.minRole: OWNER` + the `hasOwnerAccess` gate below).
 * Because it only ever runs for the owner, the LifeOps egress redaction it used
 * is always a pass-through, so the ported provider surfaces the owner's full
 * triage snippets and deep links — observably identical to the LifeOps version.
 */
export const inboxTriageProvider: Provider = {
  name: "inboxTriage",
  description:
    "Injects pending inbox triage items into owner context. Shows urgent messages, " +
    "items needing reply, and recent auto-replies across all channels including email. " +
    "Use MESSAGE action=triage/list_inbox/search_inbox/respond/draft_reply/send_draft for cross-channel triage, digest, respond, Gmail search/read, and Gmail draft/send reply workflows. " +
    "If the request is Gmail-only, MESSAGE should use source=gmail; if it is just 'my inbox', MESSAGE should use the cross-channel path.",
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

    let repo: InboxRepository;
    try {
      repo = new InboxRepository(runtime);
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
        lines.push(formatEntry(item));
      }
    }

    if (needsReply.length > 0) {
      lines.push("\n## Needs Reply");
      for (const item of needsReply.slice(0, 5)) {
        lines.push(formatEntry(item));
      }
    }

    if (recentAutoReplies.length > 0) {
      lines.push("\n## Recent Auto-Replies");
      for (const item of recentAutoReplies) {
        const draftPreview = item.draftResponse
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
        urgentItems: urgent,
        needsReplyItems: needsReply,
        recentAutoReplies,
      },
    };
  },
};

function formatEntry(entry: TriageEntry): string {
  const senderInfo = entry.senderName ? ` from ${entry.senderName}` : "";
  const link = entry.deepLink ? `\n  ${entry.deepLink}` : "";
  const snippet = entry.snippet.slice(0, 80);
  return `- **${entry.channelName}**${senderInfo} (${entry.source}): "${snippet}"${link}`;
}

export default inboxTriageProvider;
