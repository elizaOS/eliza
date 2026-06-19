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
      // entity lookup is best-effort
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

function formatEntry(entry: TriageEntry): string {
  const when = entry.createdAt
    ? new Date(entry.createdAt).toLocaleDateString()
    : "recently";
  const snippet = entry.snippet.slice(0, 80);
  const tag = entry.classification === "urgent" ? " ⚠️" : "";
  return `- **${entry.channelName}** (${entry.source}, ${when})${tag}: "${snippet}"`;
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
    if (!(await hasOwnerAccess(runtime, message))) return EMPTY;

    const { entityId, name } = await resolveSenderLabel(runtime, message);
    if (!entityId && !name) return EMPTY;

    const currentSource =
      typeof (message.content as { source?: string })?.source === "string"
        ? (message.content as { source: string }).source
        : "";

    let repo: InboxRepository;
    try {
      repo = new InboxRepository(runtime);
    } catch {
      return EMPTY;
    }

    let entries: TriageEntry[];
    try {
      entries = await repo.getUnresolved({ limit: 200 });
    } catch (error) {
      logger.debug("[cross-channel-context] DB query failed:", String(error));
      return EMPTY;
    }

    const matched = entries
      .filter((e) => matchesSender(e, entityId, name, currentSource))
      .slice(0, MAX_ENTRIES);

    if (matched.length === 0) return EMPTY;

    const senderLabel = name ?? entityId ?? "this sender";
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
