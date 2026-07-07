/**
 * CROSS_CHANNEL_CONTEXT provider.
 *
 * When the owner is in a conversation, this injects any recent triage entries
 * from the same sender across *other* channels — so if someone DM'd on Discord
 * and also emailed, both threads surface in the same planner turn.
 *
 * Resolution order:
 *   1. Match triage entries by entityId (most precise — UUID identity).
 *   2. Fall back to case-insensitive senderName substring match.
 *
 * Owner-only (same gate as inboxTriage). Silently returns empty when:
 *   - the caller is not the owner,
 *   - the runtime DB is unavailable,
 *   - no sender can be resolved from the current message,
 *   - or no cross-channel entries exist for that sender.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { hasRoleAccess } from "@elizaos/core";
import { InboxRepository } from "../inbox/repository.ts";
import type { TriageEntry } from "../inbox/types.ts";

const EMPTY: ProviderResult = { text: "", values: {}, data: {} };

const MAX_ENTRIES = 8;

async function resolveSenderLabel(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<{ entityId: string | null; name: string | null }> {
  const entityId =
    typeof message.entityId === "string" && message.entityId.length > 0
      ? message.entityId
      : null;

  let name: string | null = null;
  if (entityId) {
    try {
      const entity = await runtime.getEntityById?.(entityId);
      const metaName = entity?.metadata?.name;
      name =
        entity?.names?.[0] ?? (typeof metaName === "string" ? metaName : null);
    } catch {
      // error-policy:J4 explicit user-facing degrade — sender display-name
      // enrichment is optional; on failure we proceed with the raw entityId.
    }
  }

  return { entityId, name };
}

function matchesSender(
  entry: TriageEntry,
  entityId: string | null,
  name: string | null,
  currentSource: string,
): boolean {
  // Skip entries from the same source — the planner already sees this channel.
  if (entry.source === currentSource) return false;

  if (entityId && entry.sourceEntityId === entityId) return true;

  if (name && entry.senderName) {
    const needle = name.toLowerCase();
    const haystack = entry.senderName.toLowerCase();
    return haystack.includes(needle) || needle.includes(haystack);
  }

  return false;
}

function escapeMarkdownText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)")
    .replaceAll("#", "\\#")
    .replaceAll(">", "\\>")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

function formatEntry(entry: TriageEntry): string {
  const when = entry.createdAt
    ? new Date(entry.createdAt).toISOString().slice(0, 10)
    : "recently";
  const channelName = escapeMarkdownText(entry.channelName);
  const source = escapeMarkdownText(entry.source);
  const snippet = escapeMarkdownText(entry.snippet.slice(0, 80));
  const tag = entry.classification === "urgent" ? " ⚠️" : "";
  return `- **${channelName}** (${source}, ${when})${tag}: "${snippet}"`;
}

export const crossChannelContextProvider: Provider = {
  name: "inboxCrossChannelContext",
  description:
    "Injects recent triage entries from the current message sender across other channels. " +
    "Use when the owner asks about a person or thread — surfaces cross-channel history automatically.",
  descriptionCompressed:
    "Current sender's cross-channel triage history (other channels).",
  dynamic: true,
  position: -3,
  contexts: ["messaging", "email", "inbox"],
  contextGate: { anyOf: ["messaging", "email", "inbox"] },
  cacheScope: "turn",
  roleGate: { minRole: "OWNER" },

  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    if (!(await hasRoleAccess(runtime, message, "OWNER"))) return EMPTY;

    const { entityId, name } = await resolveSenderLabel(runtime, message);
    if (!entityId && !name) return EMPTY;

    const currentSource =
      typeof (message.content as { source?: string })?.source === "string"
        ? (message.content as { source: string }).source
        : "";

    let repo: InboxRepository;
    try {
      repo = new InboxRepository(runtime);
    } catch (error) {
      // error-policy:J4 explicit user-facing degrade — if the inbox store is
      // unavailable this provider omits cross-channel context (empty, never a
      // fabricated "no related messages"); reportError makes the failure
      // observable in RECENT_ERRORS instead of being silently swallowed.
      runtime.reportError?.("cross-channel-context.provider", error);
      return EMPTY;
    }

    let entries: TriageEntry[];
    try {
      entries = await repo.getUnresolvedForSender({
        sourceEntityId: entityId,
        senderName: name,
        excludeSource: currentSource,
        limit: MAX_ENTRIES,
      });
    } catch (error) {
      // error-policy:J4 explicit user-facing degrade — a store-read failure
      // omits cross-channel context (empty, never a fabricated "no related
      // messages"); reportError surfaces it observably in RECENT_ERRORS.
      runtime.reportError?.("cross-channel-context.provider", error);
      return EMPTY;
    }

    const matched = entries.filter((e) =>
      matchesSender(e, entityId, name, currentSource),
    );

    if (matched.length === 0) return EMPTY;

    const senderLabel = escapeMarkdownText(name ?? entityId ?? "this sender");
    const lines: string[] = [
      `# ${senderLabel} — cross-channel activity (${matched.length} threads)`,
    ];
    for (const entry of matched) {
      lines.push(formatEntry(entry));
    }

    return {
      text: lines.join("\n"),
      values: { crossChannelCount: matched.length },
      data: { entries: matched },
    };
  },
};

export default crossChannelContextProvider;
