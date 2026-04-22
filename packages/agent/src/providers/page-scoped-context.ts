import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  UUID,
} from "@elizaos/core";
import { logger, stringToUuid } from "@elizaos/core";
import {
  extractConversationMetadataFromRoom,
  isPageScopedConversationMetadata,
} from "../api/conversation-metadata.js";
import type { ConversationScope } from "../api/server-types.js";
import {
  formatRelativeTimestamp,
  formatSpeakerLabel,
} from "./conversation-utils.js";

const SOURCE_TAIL_LIMIT = 6;
const SOURCE_TAIL_MIN_FOR_INCLUSION = 2;
const SOURCE_TAIL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const EMPTY_RESULT: ProviderResult = { text: "", values: {}, data: {} };

const PAGE_SCOPE_BRIEF: Record<string, string> = {
  "page-browser":
    "The user is in the Browser view. Surface vocabulary: the embedded browser companion can open tabs, navigate to URLs, capture page snapshots, show or hide tabs, and close them. Action vocabulary the agent can rely on includes openBrowserWorkspaceTab, navigateBrowserWorkspaceTab, snapshotBrowserWorkspaceTab, showBrowserWorkspaceTab, hideBrowserWorkspaceTab, closeBrowserWorkspaceTab. When the user asks how to do something here, ground answers in real tabs and the bridge mode reported in live state. Do not invent tabs or URLs.",
  "page-character":
    "The user is in the Character view. They can edit the agent's name, description, bio, lore, message examples, voice provider and voice id, avatar, and greeting animation, and upload knowledge documents. Most edits are UI-driven through CharacterIdentityPanel, voice config UI, CharacterStylePanel, CharacterExamplesPanel, and KnowledgeView. The agent should guide the user to the relevant panel rather than fabricate a setter action — there is no general 'change my voice' action.",
  "page-automations":
    "The user is in the Automations view. They can create coordinator-text triggers and n8n workflows, set cron or interval schedules, configure wake mode (inject_now / schedule_at / interval), set max-runs, and enable or disable triggers. Action vocabulary: createTriggerTaskAction, manageTasksAction. Triggers and workflows already in the system are listed in live state below; reference them by display name when answering.",
  "page-apps":
    "The user is in the Apps view. They can browse the catalog, launch apps, stop running apps, view running app instances and their health, and favorite apps. Action vocabulary: launchAppAction, stopAppAction. The app catalog and running runs are surfaced via the Apps API; refer to apps by display name and never invent app names.",
  "page-wallet":
    "The user is in the Wallet view. Wallet operations are user-driven; do not initiate trades, transfers, or fund movements on the user's behalf. Provide read-only guidance only.",
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
    .filter((entry) => (entry.content?.text ?? "").trim().length > 0)
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
    text: (mem.content?.text ?? "").slice(0, 280),
    ageLabel: formatRelativeTimestamp(mem.createdAt),
    role: inferRole(mem, runtime.agentId),
  }));
}

async function renderCharacterLiveState(
  runtime: IAgentRuntime,
): Promise<string | null> {
  const character = runtime.character;
  if (!character) return null;
  const lines: string[] = ["Live character state:"];
  lines.push(`- Name: ${character.name ?? "(unnamed)"}`);
  const bio = (character as { bio?: unknown }).bio;
  if (typeof bio === "string" && bio.trim().length > 0) {
    lines.push(`- Bio: ${bio.trim().slice(0, 200)}`);
  } else if (Array.isArray(bio) && bio.length > 0) {
    lines.push(`- Bio entries: ${bio.length}`);
  }
  const exampleCount = Array.isArray(character.messageExamples)
    ? character.messageExamples.length
    : 0;
  lines.push(`- Message examples: ${exampleCount}`);
  return lines.join("\n");
}

async function renderBrowserLiveState(): Promise<string | null> {
  try {
    const { getBrowserWorkspaceSnapshot } = await import(
      "../services/browser-workspace.js"
    );
    const snapshot = await getBrowserWorkspaceSnapshot();
    const lines: string[] = [
      `Live browser state: bridge=${snapshot.mode}, ${snapshot.tabs.length} tab${snapshot.tabs.length === 1 ? "" : "s"}.`,
    ];
    for (const tab of snapshot.tabs.slice(0, 6)) {
      const flags = tab.visible ? "[visible]" : "";
      lines.push(`- ${tab.title || "(untitled)"} — ${tab.url} ${flags}`.trim());
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

async function renderAutomationsLiveState(
  runtime: IAgentRuntime,
): Promise<string | null> {
  try {
    const tasks = await runtime.getTasks({ agentIds: [runtime.agentId] });
    if (tasks.length === 0) return "Live automations state: no tasks defined.";
    const lines: string[] = [
      `Live automations state: ${tasks.length} task${tasks.length === 1 ? "" : "s"}.`,
    ];
    for (const task of tasks.slice(0, 8)) {
      const name = task.name ?? "(unnamed task)";
      const tagList =
        Array.isArray(task.tags) && task.tags.length > 0
          ? ` [${task.tags.join(", ")}]`
          : "";
      lines.push(`- ${name}${tagList}`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

async function renderLiveStateForScope(
  runtime: IAgentRuntime,
  scope: ConversationScope,
): Promise<string | null> {
  switch (scope) {
    case "page-character":
      return renderCharacterLiveState(runtime);
    case "page-browser":
      return renderBrowserLiveState();
    case "page-automations":
      return renderAutomationsLiveState(runtime);
    case "page-apps":
    case "page-wallet":
      return null;
    default:
      return null;
  }
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
    "Operational context for the current page-scoped chat (Browser, Character, Apps, Automations, Wallet).",
  dynamic: false,
  position: 5,

  async get(runtime: IAgentRuntime, message: Memory): Promise<ProviderResult> {
    try {
      const room = await runtime.getRoom(message.roomId);
      const metadata = extractConversationMetadataFromRoom(room);
      if (!isPageScopedConversationMetadata(metadata)) {
        return EMPTY_RESULT;
      }
      const scope = metadata?.scope as ConversationScope;
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
      logger.error(
        "[page-scoped-context] Error:",
        error instanceof Error ? error.message : String(error),
      );
      return EMPTY_RESULT;
    }
  },
};
