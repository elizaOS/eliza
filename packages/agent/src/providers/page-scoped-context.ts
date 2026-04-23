import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  UUID,
} from "@elizaos/core";
import type { StewardPendingResponse, StewardStatusResponse } from "@elizaos/app-steward/types/steward";
import { logger, stringToUuid } from "@elizaos/core";
import type {
  AppRunSummary,
  RegistryAppInfo,
} from "@elizaos/shared/contracts/apps";
import type {
  WalletBalancesResponse,
  WalletConfigStatus,
  WalletNftsResponse,
} from "@elizaos/shared/contracts/wallet";
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
    "The user is in the Browser view. They can open tabs, navigate URLs, refresh pages, capture snapshots, show or hide tabs, close tabs, inspect what is open, and connect Agent Browser Bridge for real Chrome control. Action vocabulary the agent can rely on includes openBrowserWorkspaceTab, navigateBrowserWorkspaceTab, snapshotBrowserWorkspaceTab, showBrowserWorkspaceTab, hideBrowserWorkspaceTab, closeBrowserWorkspaceTab. When the user asks what to do, explain the available browser actions, recommend the next action from live tab and bridge state, and offer to answer questions about tabs, forms, current pages, or setup. Do not invent tabs or URLs.",
  "page-character":
    "The user is in the Character view. They can edit the agent's name, description, bio, lore, message examples, style, voice provider and voice id, avatar/VRM selection, greeting animation, and knowledge documents. Most edits are UI-driven through CharacterIdentityPanel, voice config UI, CharacterStylePanel, CharacterExamplesPanel, and KnowledgeView. When the user asks what to do, explain the edit surfaces, recommend the next character improvement from live state, and offer to draft exact copy. Guide the user to the relevant panel rather than fabricate a setter action — there is no general 'change my voice' action.",
  "page-automations":
    "The user is in the Automations view. They can create coordinator-text triggers, one-off tasks, recurring tasks, and n8n workflows; set cron or interval schedules; configure wake mode (inject_now / schedule_at / interval), max-runs, and enabled state; browse templates; inspect existing automations; and troubleshoot failed runs. Action vocabulary: createTriggerTaskAction, manageTasksAction. When the user asks what to do, recommend trigger vs task vs workflow based on the event, schedule, and desired result. Triggers and workflows already in the system are listed in live state below; reference them by display name when answering.",
  "page-apps":
    "The user is in the Apps view. They can browse and compare catalog apps, launch apps, stop running apps, open attached live viewers, inspect run health and summaries, and manage favorites or recent apps. Action vocabulary: launchAppAction, stopAppAction. When the user asks what to do, recommend an app or run-management action from the live catalog and running app state. Refer to apps by display name and never invent app names.",
  "page-wallet":
    "The user is in the Wallet view. They can inspect addresses, balances, NFTs, chain filters, RPC/provider readiness, pending Steward approvals, policy controls, transaction history, and wallet/RPC settings. When the user asks what to do, recommend read-only readiness and safety checks first. Wallet operations are user-driven; do not initiate trades, transfers, swaps, approvals, signatures, or fund movements on the user's behalf. Provide read-only guidance only.",
  "automation-draft":
    "This is an automation-creation room. The user wants to create exactly one automation. Decide the right shape based on their description and call the matching action exactly once:\n" +
    "- Recurring prompt or schedule (e.g. \"every morning summarize my inbox\") → CREATE_TRIGGER_TASK with a clear displayName, instructions, and schedule.\n" +
    "- Goal to work toward until done (e.g. \"figure out the onboarding refactor\") → CREATE_TASK with name and description.\n" +
    "- Deterministic pipeline of integration steps (e.g. \"when a Slack message matches X, post to Discord\") → create an n8n workflow via the n8n actions.\n" +
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

interface BrowserBridgeCompanionLiveStatus {
  connectionState: string;
  browser: string;
  profileLabel?: string | null;
  extensionVersion?: string | null;
}

function getLocalApiUrl(path: string): string {
  const port = process.env.API_PORT || process.env.SERVER_PORT || "2138";
  return `http://127.0.0.1:${port}${path.startsWith("/") ? path : `/${path}`}`;
}

async function fetchLocalJson<T>(
  path: string,
  timeoutMs = 1500,
): Promise<T | null> {
  try {
    const response = await fetch(getLocalApiUrl(path), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function fetchBrowserBridgeCompanionLiveStatus(): Promise<
  BrowserBridgeCompanionLiveStatus[] | null
> {
  const payload = await fetchLocalJson<{
    companions?: Array<{
      connectionState?: string;
      browser?: string;
      profileLabel?: string | null;
      extensionVersion?: string | null;
    }>;
  }>("/api/browser-bridge/companions");
  if (!payload) return null;
  if (!Array.isArray(payload.companions)) return [];
  return payload.companions.map((companion) => ({
    connectionState: companion.connectionState ?? "unknown",
    browser: companion.browser ?? "chrome",
    profileLabel: companion.profileLabel ?? null,
    extensionVersion: companion.extensionVersion ?? null,
  }));
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

    // Agent Browser Bridge companion status — so the agent can tell the user
    // to install the extension when it isn't connected and reference the
    // connected profile accurately when it is.
    const companions = await fetchBrowserBridgeCompanionLiveStatus();
    if (companions === null) {
      lines.push(
        "Agent Browser Bridge companion: status unknown (companion API unreachable).",
      );
    } else if (companions.length === 0) {
      lines.push(
        "Agent Browser Bridge companion: not installed — tell the user to click 'Install Agent Browser Bridge' in the chat panel to build the extension and load it into Chrome.",
      );
    } else {
      const connected = companions.filter(
        (companion) => companion.connectionState === "connected",
      );
      if (connected.length === 0) {
        lines.push(
          "Agent Browser Bridge companion: extension present but not connected — ask the user to open the Agent Browser Bridge extension in Chrome so it can pair.",
        );
      } else {
        lines.push(
          `Agent Browser Bridge companion: connected (${connected.length} profile${connected.length === 1 ? "" : "s"}).`,
        );
        for (const companion of connected.slice(0, 3)) {
          const browser =
            companion.browser === "safari" ? "Safari" : "Chrome";
          const profile = companion.profileLabel?.trim() || "Default";
          const version = companion.extensionVersion
            ? ` v${companion.extensionVersion}`
            : "";
          lines.push(`- ${browser} / ${profile}${version}`);
        }
      }
    }

    return lines.join("\n");
  } catch {
    return null;
  }
}

function dedupeApps(
  groups: Array<RegistryAppInfo[] | null>,
): RegistryAppInfo[] {
  const apps = new Map<string, RegistryAppInfo>();
  for (const group of groups) {
    if (!group) continue;
    for (const app of group) {
      if (!app?.name || apps.has(app.name)) continue;
      apps.set(app.name, app);
    }
  }
  return [...apps.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

async function renderAppsLiveState(): Promise<string | null> {
  const [catalogApps, serverApps, runs] = await Promise.all([
    fetchLocalJson<RegistryAppInfo[]>("/api/catalog/apps"),
    fetchLocalJson<RegistryAppInfo[]>("/api/apps"),
    fetchLocalJson<AppRunSummary[]>("/api/apps/runs"),
  ]);
  if (!catalogApps && !serverApps && !runs) {
    return "Live apps state: unavailable from the Apps API.";
  }

  const apps = dedupeApps([catalogApps, serverApps]);
  const activeRuns = runs ?? [];
  const lines: string[] = [
    `Live apps state: ${apps.length} catalog app${apps.length === 1 ? "" : "s"}, ${activeRuns.length} running app${activeRuns.length === 1 ? "" : "s"}.`,
  ];

  if (activeRuns.length > 0) {
    lines.push("Running apps:");
    for (const run of activeRuns.slice(0, 8)) {
      const health = run.health?.state ? ` health=${run.health.state}` : "";
      const viewer = run.viewerAttachment
        ? ` viewer=${run.viewerAttachment}`
        : "";
      const summary = run.summary ? ` — ${run.summary.slice(0, 140)}` : "";
      lines.push(
        `- ${run.displayName} (${run.appName}) status=${run.status}${health}${viewer}${summary}`,
      );
    }
  } else {
    lines.push("Running apps: none.");
  }

  if (apps.length > 0) {
    lines.push("Catalog sample:");
    for (const app of apps.slice(0, 12)) {
      const capabilities =
        app.capabilities.length > 0
          ? ` capabilities=${app.capabilities.slice(0, 4).join(", ")}`
          : "";
      lines.push(
        `- ${app.displayName} (${app.name}) category=${app.category}${capabilities}`,
      );
    }
  }

  return lines.join("\n");
}

function shortAddress(address: string | null | undefined): string {
  if (!address) return "(not configured)";
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function readyLabel(value: boolean | undefined): string {
  if (value === true) return "ready";
  if (value === false) return "not ready";
  return "unknown";
}

async function renderWalletLiveState(): Promise<string | null> {
  const [config, balances, nfts, stewardStatus, pendingApprovals] =
    await Promise.all([
      fetchLocalJson<WalletConfigStatus>("/api/wallet/config"),
      fetchLocalJson<WalletBalancesResponse>("/api/wallet/balances"),
      fetchLocalJson<WalletNftsResponse>("/api/wallet/nfts"),
      fetchLocalJson<StewardStatusResponse>("/api/wallet/steward-status"),
      fetchLocalJson<StewardPendingResponse>(
        "/api/wallet/steward-pending-approvals",
      ),
    ]);

  if (!config && !balances && !nfts && !stewardStatus && !pendingApprovals) {
    return "Live wallet state: unavailable from the Wallet API.";
  }

  const lines: string[] = ["Live wallet state:"];
  if (config) {
    lines.push(`- Wallet source: ${config.walletSource ?? "unknown"}`);
    lines.push(`- EVM address: ${shortAddress(config.evmAddress)}`);
    lines.push(`- Solana address: ${shortAddress(config.solanaAddress)}`);
    lines.push(
      `- RPC providers: EVM=${config.selectedRpcProviders.evm}, BSC=${config.selectedRpcProviders.bsc}, Solana=${config.selectedRpcProviders.solana}`,
    );
    lines.push(
      `- Readiness: BSC RPC ${readyLabel(config.managedBscRpcReady)}, EVM balances ${readyLabel(config.evmBalanceReady)}, Solana balances ${readyLabel(config.solanaBalanceReady)}, execution ${readyLabel(config.executionReady)}`,
    );
    if (config.executionBlockedReason) {
      lines.push(`- Execution blocked: ${config.executionBlockedReason}`);
    }
    lines.push(
      `- Signing: EVM=${config.evmSigningCapability ?? "unknown"}, Solana=${readyLabel(config.solanaSigningAvailable)}`,
    );
  }

  if (balances?.evm) {
    lines.push(
      `- EVM balances: ${balances.evm.chains.length} chain${balances.evm.chains.length === 1 ? "" : "s"} for ${shortAddress(balances.evm.address)}.`,
    );
    for (const chain of balances.evm.chains.slice(0, 5)) {
      const tokenCount = chain.tokens.length;
      const error = chain.error ? ` error=${chain.error}` : "";
      lines.push(
        `  - ${chain.chain}: ${chain.nativeBalance} ${chain.nativeSymbol}, ${tokenCount} token${tokenCount === 1 ? "" : "s"}${error}`,
      );
    }
  }
  if (balances?.solana) {
    lines.push(
      `- Solana balance: ${balances.solana.solBalance} SOL, ${balances.solana.tokens.length} token${balances.solana.tokens.length === 1 ? "" : "s"} for ${shortAddress(balances.solana.address)}.`,
    );
  }

  if (nfts) {
    const evmNftCount = nfts.evm.reduce(
      (sum, chain) => sum + chain.nfts.length,
      0,
    );
    const solanaNftCount = nfts.solana?.nfts.length ?? 0;
    lines.push(`- NFTs: EVM=${evmNftCount}, Solana=${solanaNftCount}.`);
  }

  if (stewardStatus) {
    const connected = stewardStatus.connected ? "connected" : "not connected";
    const health = stewardStatus.vaultHealth ?? "unknown";
    lines.push(`- Steward: ${connected}, vault=${health}.`);
  }
  if (pendingApprovals) {
    lines.push(`- Pending Steward approvals: ${pendingApprovals.length}.`);
  }

  return lines.join("\n");
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
    case "automation-draft":
      return renderAutomationsLiveState(runtime);
    case "page-apps":
      return renderAppsLiveState();
    case "page-wallet":
      return renderWalletLiveState();
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
      logger.error(
        "[page-scoped-context] Error:",
        error instanceof Error ? error.message : String(error),
      );
      return EMPTY_RESULT;
    }
  },
};
