/**
 * Provider that injects operational context for a page-scoped dashboard chat —
 * the per-view chat surfaces (Browser, Character, Apps, Connectors, Plugins,
 * Settings, Automations, Wallet, and the automation-draft room). For the
 * conversation's scope it emits a static "brief" describing that view's action
 * vocabulary and guardrails, appends live state pulled from the local agent API
 * (running apps, wallet balances, browser tabs/bridge, character summary,
 * automation tasks), and a short tail of the originating main-chat conversation.
 * Gated to OWNER (enforced by applyPluginRoleGating). Subsection and
 * provider-boundary failures degrade gracefully and are routed to reportError so
 * they still surface through the RECENT_ERRORS provider.
 */
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  UUID,
} from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import {
  extractConversationMetadataFromRoom,
  isPageScopedConversationMetadata,
} from "../api/conversation-metadata.ts";
import type { ConversationScope } from "../api/server-types.ts";
import {
  formatRelativeTimestamp,
  formatSpeakerLabel,
} from "../shared/conversation-format.ts";
import { renderLiveStateForScope } from "./page-scoped-live-state.ts";

const SOURCE_TAIL_LIMIT = 6;
const SOURCE_TAIL_MIN_FOR_INCLUSION = 2;
const SOURCE_TAIL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const EMPTY_RESULT: ProviderResult = { text: "", values: {}, data: {} };

const PAGE_SCOPE_BRIEF: Record<string, string> = {
  "page-browser":
    "The user is in the Browser view. Tabs are grouped into User Tabs, Agent Tabs, and App Tabs. User Tabs are writable: the user can open them, navigate URLs, refresh pages, capture snapshots, show or hide tabs, and close tabs there. Agent Tabs and App Tabs are read-only context: inspect and explain them, but do not navigate, click, type into, refresh, close, or otherwise mutate them. Action vocabulary the agent can rely on includes openBrowserWorkspaceTab, navigateBrowserWorkspaceTab, snapshotBrowserWorkspaceTab, showBrowserWorkspaceTab, hideBrowserWorkspaceTab, closeBrowserWorkspaceTab. When the user asks what to do, explain the available browser actions, recommend the next action from live tab and bridge state, and offer to answer questions about tabs, forms, current pages, or setup. Do not invent tabs or URLs.",
  "page-character":
    "The user is in the Character view. The Character hub is organized into Overview, Personality, Knowledge, Experience, and Relationships. Name, voice, and system prompt live in Settings > Identity; Personality focuses on bio, style rules, message examples, and evolution history; Knowledge holds uploaded and learned knowledge; Experience surfaces durable learnings the agent recorded; Relationships shows the full relationship graph, facts, memories, and user-scoped personality preferences. When the user asks what to do, explain the relevant hub section, recommend the next improvement from live state, and offer to draft exact copy. Guide the user to the relevant section rather than fabricate a generic setter action.",
  "page-automations":
    "The user is in the Automations view. They can create scheduled or event-driven workflows; set cron or interval schedules; configure wake mode (inject_now / schedule_at / interval), max-runs, and enabled state; browse templates; inspect existing automations; and troubleshoot failed runs. Workflows and triggers are the unified model — a 'task' (just-respond-to-an-event) is a single-node workflow whose trigger fires it. Action vocabulary: WORKFLOW (op-based dispatch — create/modify/activate/deactivate/toggle_active/delete/executions) and TRIGGER (op-based dispatch — create/update/delete/run/toggle). When the user asks what to do, recommend a workflow shape (DAG vs single-instruction) and the appropriate trigger schedule based on the event and desired result. Workflows and triggers already in the system are listed in live state below; reference them by display name when answering.",
  "page-apps":
    "The user is in the Apps view. They can browse and compare catalog apps, launch apps, stop running apps, open attached live viewers, inspect run health and summaries, and manage favorites or recent apps. Action vocabulary: APP with mode launch, relaunch, list, load_from_directory, or create. When the user asks what to do, recommend an app or run-management action from the live catalog and running app state. Refer to apps by display name and never invent app names.",
  "page-connectors":
    "The user is in the Connectors view. They can inspect connector availability, authentication state, setup requirements, webhook readiness, and integration health. Action vocabulary: LIST_CONNECTORS, TOGGLE_CONNECTOR, SAVE_CONNECTOR_CONFIG, DISCONNECT_CONNECTOR. When the user asks what to do, recommend the smallest connector setup or troubleshooting action that fits the visible state. Never invent connected accounts, permissions, webhook state, or delivery results.",
  "page-phone":
    "The user is in the Android Phone view. They can place calls through Android Telecom, open the dialer, send SMS through Android SMS, review recent calls, browse contacts, import vCards, and save call transcripts or summaries. Action vocabulary may include MESSAGE with operation=send/read_channel/search, VOICE_CALL, ADD_CONTACT, UPDATE_CONTACT, GET_CONTACT, and SEARCH_CONTACTS when the relevant plugins are enabled. Confirm the target number/contact and message content before calls or SMS. Ground discussion in visible phone state when present and never invent call logs, contacts, message bodies, transcripts, or delivery results.",
  "page-plugins":
    "The user is in the Plugins view. They can inspect installed plugins, registry plugins, configuration readiness, plugin health, and runtime capability gaps. Action vocabulary: PLUGIN with modes install, eject, sync, reinject, list, search, core_status, or create. When the user asks what to do, recommend the smallest plugin setup or troubleshooting action that fits the visible state. Never invent installed plugins, credentials, or enabled capabilities.",
  "page-settings":
    "The user is in the Settings view. They can tune models, providers, permissions, connectors, wallet RPC, cloud account state, appearance, updates, and feature toggles. Action vocabulary: UPDATE_IDENTITY, UPDATE_AI_PROVIDER, TOGGLE_CAPABILITY, and TOGGLE_AUTO_TRAINING. When the user asks what to do, recommend the smallest concrete settings change that fits the visible section. Ask before changes that affect security, spending, or external accounts. Never invent provider status, account state, or permission grants.",
  "page-wallet":
    "The user is in the Wallet view. They can inspect token inventory, NFTs, LP position status, current balance, P&L, activity, EVM/Solana addresses, RPC/provider readiness, wallet/RPC settings, and native Hyperliquid and Polymarket readiness. There are no chain filters in this surface. When the user asks what to do, recommend the smallest concrete wallet action and confirm asset/market, amount, destination/outcome, slippage/risk limits, and execution path before invoking any available action. If the user asks about Hyperliquid or Polymarket, prefer native app surfaces for reads/status. Never invent balances, positions, fills, markets, odds, or execution support.",
  "page-knowledge":
    "The user is in the Knowledge view. This surface lists knowledge records, including chat attachments ingested by room, sender, sender role, and media format (image, audio, video, pdf, text, transcript, file). Owner/DM-chat knowledge is owner-private and never surfaces into public rooms; public/community-room attachments are scoped to their sender. The user can browse, search, retag, rescope (owner-only), and delete knowledge items; deleting the sole referent of a media file makes those bytes garbage-collectible. When the user asks what to do, ground answers in the live knowledge state below (recent-attachment counts by source and format) and recommend the smallest concrete filing, retag, rescope, or cleanup action. Never invent knowledge records, media, tags, or scopes.",
  "page-transcripts":
    "The user is in the Transcripts view. This surface lists recorded voice transcripts they can play, scrub, and read with word-level sync. The user can review a transcript, ask for a summary or action items, or search across recordings. When the user asks what to do, ground answers in the live transcript state below (recent-transcript count and recency) and offer to summarize or extract action items from the most recent recording. Never invent transcripts, speakers, or contents.",
  "automation-draft":
    "This is an automation-creation room. The user wants to create exactly one automation. Decide the right shape based on their description and call the matching action exactly once:\n" +
    '- Recurring prompt or scheduled instruction (e.g. "every morning summarize my inbox") → TRIGGER with op="create" specifying displayName, instructions, and schedule (interval/once/cron). The agent transparently materializes a single-node workflow that runs the instructions when the trigger fires.\n' +
    '- Goal to work toward until done (e.g. "figure out the first-run refactor") → START_CODING_TASK with name and description.\n' +
    '- Deterministic pipeline of integration steps (e.g. "when a Slack message matches X, post to Discord") → WORKFLOW with op="create" and a clear seedPrompt describing the pipeline.\n' +
    "Ask one short clarifying question only if the shape is genuinely ambiguous; otherwise create immediately. After creation, briefly confirm what you made and how to run it.",
};

interface SourceTailEntry {
  speaker: string;
  text: string;
  ageLabel: string;
  role: "user" | "assistant" | "unknown";
}

function inferRole(memory: Memory, agentId: UUID): "user" | "assistant" {
  return memory.entityId === agentId ? "assistant" : "user";
}

function pruneMainChatTail(
  memories: Memory[],
  agentId: UUID,
  now: number,
): Memory[] {
  const ordered = [...memories]
    .filter((entry) => (entry.content.text ?? "").trim().length > 0)
    .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));

  // Trim trailing assistant-only run (an assistant message that the user never replied to).
  while (ordered.length > 0) {
    const last = ordered[ordered.length - 1];
    if (last && inferRole(last, agentId) === "assistant") {
      const lastUserBefore = ordered
        .slice(0, -1)
        .some((entry) => inferRole(entry, agentId) === "user");
      if (!lastUserBefore) {
        ordered.pop();
        continue;
      }
    }
    break;
  }

  // Require at least one user message somewhere, else there's no real signal.
  const hasUser = ordered.some((entry) => inferRole(entry, agentId) === "user");
  if (!hasUser) {
    return [];
  }

  // Drop the whole tail if the last user message is stale.
  const lastUser = [...ordered]
    .reverse()
    .find((entry) => inferRole(entry, agentId) === "user");
  const lastUserAt = lastUser?.createdAt ?? 0;
  if (now - lastUserAt > SOURCE_TAIL_MAX_AGE_MS) {
    return [];
  }

  return ordered.slice(-SOURCE_TAIL_LIMIT);
}

async function fetchSourceTail(
  runtime: IAgentRuntime,
  sourceConversationId: string,
  ownRoomId: UUID,
): Promise<SourceTailEntry[]> {
  const sourceRoomId = stringToUuid(`web-conv-${sourceConversationId}`) as UUID;
  if (sourceRoomId === ownRoomId) {
    return [];
  }
  const memories = await runtime.getMemories({
    roomId: sourceRoomId,
    tableName: "messages",
    limit: SOURCE_TAIL_LIMIT * 2,
  });
  const pruned = pruneMainChatTail(memories, runtime.agentId, Date.now());
  if (pruned.length < SOURCE_TAIL_MIN_FOR_INCLUSION) {
    return [];
  }
  return pruned.map((mem) => ({
    speaker: formatSpeakerLabel(runtime, mem),
    text: (mem.content.text ?? "").slice(0, 280),
    ageLabel: formatRelativeTimestamp(mem.createdAt),
    role: inferRole(mem, runtime.agentId),
  }));
}

function formatSourceTail(entries: SourceTailEntry[]): string {
  const lines: string[] = ["Recent main-chat tail:"];
  for (const entry of entries) {
    lines.push(`(${entry.ageLabel}) ${entry.speaker}: ${entry.text}`);
  }
  return lines.join("\n");
}

export const pageScopedContextProvider: Provider = {
  name: "page-scoped-context",
  description:
    "Operational context for the current page-scoped chat (Browser, Character, Apps, Connectors, Plugins, Settings, Automations, Wallet).",
  dynamic: false,
  position: 5,
  contexts: [
    "browser",
    "finance",
    "payments",
    "wallet",
    "crypto",
    "media",
    "automation",
    "connectors",
    "settings",
    "messaging",
    "agent_internal",
  ],
  contextGate: {
    anyOf: [
      "browser",
      "finance",
      "payments",
      "wallet",
      "crypto",
      "media",
      "automation",
      "connectors",
      "settings",
      "messaging",
      "agent_internal",
    ],
  },
  cacheStable: false,
  cacheScope: "turn",
  // roleGate OWNER is enforced by applyPluginRoleGating (#12087 Item 14); the
  // declared gate is authoritative, not the handler body.
  roleGate: { minRole: "OWNER" },

  async get(runtime: IAgentRuntime, message: Memory): Promise<ProviderResult> {
    try {
      const room = await runtime.getRoom(message.roomId);
      const metadata = extractConversationMetadataFromRoom(room);
      const scope = metadata?.scope as ConversationScope | undefined;
      const isPageScoped = isPageScopedConversationMetadata(metadata);
      const acceptedScope = isPageScoped || scope === "automation-draft";
      if (!acceptedScope || !scope) {
        return EMPTY_RESULT;
      }
      const brief = PAGE_SCOPE_BRIEF[scope];
      if (!brief) {
        return EMPTY_RESULT;
      }

      const sections: string[] = [brief];

      const liveState = await renderLiveStateForScope(runtime, scope);
      if (liveState && liveState.trim().length > 0) {
        sections.push(liveState);
      }

      let sourceTailIncluded = false;
      if (metadata?.sourceConversationId) {
        const tail = await fetchSourceTail(
          runtime,
          metadata.sourceConversationId,
          message.roomId,
        );
        if (tail.length > 0) {
          sections.push(formatSourceTail(tail));
          sourceTailIncluded = true;
        }
      }

      return {
        text: sections.join("\n\n"),
        values: {
          pageScope: scope,
          sourceTailIncluded,
        },
        data: {
          scope,
          sourceConversationId: metadata?.sourceConversationId ?? null,
          sourceTailIncluded,
        },
      };
    } catch (error) {
      // error-policy:J1 provider boundary — the outermost handler for this
      // provider degrades to an empty context section (a provider throwing
      // would abort the whole turn), and reports the failure so it reaches the
      // RECENT_ERRORS provider and the owner-escalation threshold, not just logs.
      runtime.reportError("page-scoped-context", error, {
        roomId: message.roomId,
      });
      return EMPTY_RESULT;
    }
  },
};
