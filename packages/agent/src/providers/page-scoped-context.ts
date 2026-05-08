import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  UUID,
} from "@elizaos/core";
import { logger, stringToUuid } from "@elizaos/core";
import type {
  AppRunSummary,
  LifeOpsCapabilitiesStatus,
  LifeOpsInbox,
  LifeOpsOverview,
  RegistryAppInfo,
  WalletBalancesResponse,
  WalletConfigStatus,
  WalletNftsResponse,
  WalletTradingProfileResponse,
} from "@elizaos/shared";
import {
  extractConversationMetadataFromRoom,
  isPageScopedConversationMetadata,
} from "../api/conversation-metadata.js";
import type { ConversationScope } from "../api/server-types.js";
import { hasOwnerAccess } from "../security/access.js";
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
    "The user is in the Browser view. Tabs are grouped into User Tabs, Agent Tabs, and App Tabs. User Tabs are writable: the user can open them, navigate URLs, refresh pages, capture snapshots, show or hide tabs, and close tabs there. Agent Tabs and App Tabs are read-only context: inspect and explain them, but do not navigate, click, type into, refresh, close, or otherwise mutate them. Action vocabulary the agent can rely on includes openBrowserWorkspaceTab, navigateBrowserWorkspaceTab, snapshotBrowserWorkspaceTab, showBrowserWorkspaceTab, hideBrowserWorkspaceTab, closeBrowserWorkspaceTab. When the user asks what to do, explain the available browser actions, recommend the next action from live tab and bridge state, and offer to answer questions about tabs, forms, current pages, or setup. Do not invent tabs or URLs.",
  "page-character":
    "The user is in the Character view. The Character hub is organized into Overview, Personality, Knowledge, Experience, and Relationships. Name, voice, and system prompt live in Settings > Identity; Personality focuses on bio, style rules, message examples, and evolution history; Knowledge holds uploaded and learned knowledge; Experience surfaces durable learnings the agent recorded; Relationships shows the full relationship graph, facts, memories, and user-scoped personality preferences. When the user asks what to do, explain the relevant hub section, recommend the next improvement from live state, and offer to draft exact copy. Guide the user to the relevant section rather than fabricate a generic setter action.",
  "page-automations":
    "The user is in the Automations view. They can create coordinator-text triggers, one-off tasks, recurring tasks, and n8n workflows; set cron or interval schedules; configure wake mode (inject_now / schedule_at / interval), max-runs, and enabled state; browse templates; inspect existing automations; and troubleshoot failed runs. Action vocabulary: WORKFLOW (op-based dispatch — create/modify/activate/deactivate/toggle_active/delete/executions/promote_task for n8n workflows; create_trigger/update_trigger/delete_trigger/run_trigger for scheduled triggers) and manageTasksAction. When the user asks what to do, recommend trigger vs task vs workflow based on the event, schedule, and desired result. Triggers and workflows already in the system are listed in live state below; reference them by display name when answering.",
  "page-apps":
    "The user is in the Apps view. They can browse and compare catalog apps, launch apps, stop running apps, open attached live viewers, inspect run health and summaries, and manage favorites or recent apps. Action vocabulary: APP with mode launch, relaunch, list, load_from_directory, or create. When the user asks what to do, recommend an app or run-management action from the live catalog and running app state. Refer to apps by display name and never invent app names.",
  "page-connectors":
    "The user is in the Connectors view. They can inspect connector availability, authentication state, setup requirements, webhook readiness, and integration health. Action vocabulary: LIST_CONNECTORS, TOGGLE_CONNECTOR, SAVE_CONNECTOR_CONFIG, DISCONNECT_CONNECTOR. When the user asks what to do, recommend the smallest connector setup or troubleshooting action that fits the visible state. Never invent connected accounts, permissions, webhook state, or delivery results.",
  "page-phone":
    "The user is in the Android Phone view. They can place calls through Android Telecom, open the dialer, send SMS through Android SMS, review recent calls, browse contacts, import vCards, and save call transcripts or summaries. Action vocabulary may include READ_MESSAGES, READ_CHANNEL, SEND_DRAFT, VOICE_CALL, ADD_CONTACT, UPDATE_CONTACT, GET_CONTACT, and SEARCH_CONTACTS when the relevant plugins are enabled. Confirm the target number/contact and message content before calls or SMS. Ground discussion in visible phone state when present and never invent call logs, contacts, message bodies, transcripts, or delivery results.",
  "page-plugins":
    "The user is in the Plugins view. They can inspect installed plugins, registry plugins, configuration readiness, plugin health, and runtime capability gaps. Action vocabulary: PLUGIN with modes install, eject, sync, reinject, list, search, core_status, or create. When the user asks what to do, recommend the smallest plugin setup or troubleshooting action that fits the visible state. Never invent installed plugins, credentials, or enabled capabilities.",
  "page-lifeops":
    "The user is in the LifeOps view. They can inspect the overview, goals, reminders, calendar, messages, mail, sleep, screen time, social context, connector setup, capability readiness, and LifeOps settings. The LifeOps app provider and actions are the authoritative execution path for creating or changing personal workflows, reminders, goals, schedules, inbox drafts, connector setup, and executive-assistant follow-through. When the user asks what to do, recommend capability readiness and overview review first, then suggest the smallest concrete LifeOps action. Reference only live LifeOps state below; never invent reminders, messages, calendar events, goals, or connector status.",
  "page-settings":
    "The user is in the Settings view. They can tune models, providers, permissions, connectors, wallet RPC, cloud account state, appearance, updates, and feature toggles. Action vocabulary: UPDATE_IDENTITY, UPDATE_AI_PROVIDER, TOGGLE_CAPABILITY, and TOGGLE_AUTO_TRAINING. When the user asks what to do, recommend the smallest concrete settings change that fits the visible section. Ask before changes that affect security, spending, or external accounts. Never invent provider status, account state, or permission grants.",
  "page-wallet":
    "The user is in the Wallet view. They can inspect token inventory, NFTs, LP position status, current balance, P&L, activity, EVM/Solana addresses, RPC/provider readiness, wallet/RPC settings, native Hyperliquid and Polymarket readiness, and Vincent delegated trading. There are no chain filters in this surface. When the user asks what to do, recommend the smallest concrete wallet action and confirm asset/market, amount, destination/outcome, slippage/risk limits, and execution path before invoking any available action. If the user asks about Hyperliquid or Polymarket, prefer native app surfaces for reads/status and only surface Vincent for delegated automated trading. Never invent balances, positions, fills, markets, odds, or execution support.",
  "automation-draft":
    "This is an automation-creation room. The user wants to create exactly one automation. Decide the right shape based on their description and call the matching action exactly once:\n" +
    '- Recurring prompt or schedule (e.g. "every morning summarize my inbox") → WORKFLOW with op="create_trigger" and a clear displayName, instructions, and schedule.\n' +
    '- Goal to work toward until done (e.g. "figure out the onboarding refactor") → START_CODING_TASK with name and description.\n' +
    '- Deterministic pipeline of integration steps (e.g. "when a Slack message matches X, post to Discord") → create an n8n workflow via the n8n actions.\n' +
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

function getLocalApiUrls(path: string): string[] {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const configuredPort = process.env.API_PORT || process.env.SERVER_PORT;
  const ports = configuredPort
    ? [configuredPort, configuredPort === "31337" ? "2138" : "31337"]
    : ["2138", "31337"];
  return [...new Set(ports)].map(
    (port) => `http://127.0.0.1:${port}${normalizedPath}`,
  );
}

async function fetchLocalJson<T>(
  path: string,
  timeoutMs = 1500,
): Promise<T | null> {
  for (const url of getLocalApiUrls(path)) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) continue;
      return (await response.json()) as T;
    } catch {}
  }
  return null;
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
      "@elizaos/plugin-browser/workspace"
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
          const browser = companion.browser === "safari" ? "Safari" : "Chrome";
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

function formatLifeOpsOverviewSection(
  label: string,
  overview: LifeOpsOverview["owner"],
): string {
  return `${label}: ${overview.summary.activeOccurrenceCount} active item${overview.summary.activeOccurrenceCount === 1 ? "" : "s"}, ${overview.summary.activeReminderCount} reminder${overview.summary.activeReminderCount === 1 ? "" : "s"}, ${overview.summary.activeGoalCount} goal${overview.summary.activeGoalCount === 1 ? "" : "s"}.`;
}

async function renderLifeOpsLiveState(): Promise<string | null> {
  const [overview, capabilities, inbox] = await Promise.all([
    fetchLocalJson<LifeOpsOverview>("/api/lifeops/overview"),
    fetchLocalJson<LifeOpsCapabilitiesStatus>("/api/lifeops/capabilities"),
    fetchLocalJson<LifeOpsInbox>("/api/lifeops/inbox?limit=8"),
  ]);

  if (!overview && !capabilities && !inbox) {
    return "Live LifeOps state: unavailable from the LifeOps API.";
  }

  const lines: string[] = ["Live LifeOps state:"];

  if (capabilities) {
    lines.push(`- App enabled: ${capabilities.appEnabled ? "yes" : "no"}.`);
    lines.push(
      `- Capabilities: ${capabilities.summary.workingCount} working, ${capabilities.summary.degradedCount} degraded, ${capabilities.summary.blockedCount} blocked, ${capabilities.summary.notConfiguredCount} not configured.`,
    );
    const attention = capabilities.capabilities.filter(
      (capability) =>
        capability.state === "blocked" ||
        capability.state === "degraded" ||
        capability.state === "not_configured",
    );
    for (const capability of attention.slice(0, 5)) {
      lines.push(
        `  - ${capability.label}: ${capability.state} — ${capability.summary}`,
      );
    }
  }

  if (overview) {
    lines.push(
      `- Overview: ${overview.summary.activeOccurrenceCount} active item${overview.summary.activeOccurrenceCount === 1 ? "" : "s"}, ${overview.summary.overdueOccurrenceCount} overdue, ${overview.summary.activeReminderCount} active reminder${overview.summary.activeReminderCount === 1 ? "" : "s"}, ${overview.summary.activeGoalCount} active goal${overview.summary.activeGoalCount === 1 ? "" : "s"}.`,
    );
    lines.push(`- ${formatLifeOpsOverviewSection("Owner", overview.owner)}`);
    lines.push(
      `- ${formatLifeOpsOverviewSection("Agent ops", overview.agentOps)}`,
    );
    if (overview.schedule) {
      const relative = overview.schedule.relativeTime;
      const wake =
        relative.minutesSinceWake !== null
          ? `${Math.round(relative.minutesSinceWake)}m since wake`
          : "wake time unknown";
      const bedtime =
        relative.minutesUntilBedtimeTarget !== null
          ? `${Math.round(relative.minutesUntilBedtimeTarget)}m until bedtime target`
          : "bedtime target unknown";
      lines.push(
        `- Schedule: ${overview.schedule.circadianState} (${Math.round(overview.schedule.stateConfidence * 100)}% confidence), ${overview.schedule.sleepStatus}; ${wake}; ${bedtime}.`,
      );
    }
    const activeReminders = [
      ...overview.owner.reminders,
      ...overview.agentOps.reminders,
    ];
    if (activeReminders.length > 0) {
      lines.push("Active reminders:");
      for (const reminder of activeReminders.slice(0, 5)) {
        lines.push(
          `- ${reminder.title} (${reminder.channel}, ${reminder.state}) scheduled ${reminder.scheduledFor}`,
        );
      }
    }
    const activeGoals = [...overview.owner.goals, ...overview.agentOps.goals];
    if (activeGoals.length > 0) {
      lines.push("Active goals:");
      for (const goal of activeGoals.slice(0, 5)) {
        lines.push(`- ${goal.title} (${goal.status})`);
      }
    }
  }

  if (inbox) {
    const unreadCount = Object.values(inbox.channelCounts).reduce(
      (sum, count) => sum + count.unread,
      0,
    );
    lines.push(
      `- Inbox: ${inbox.messages.length} recent message${inbox.messages.length === 1 ? "" : "s"}, ${unreadCount} unread.`,
    );
    for (const message of inbox.messages.slice(0, 5)) {
      const subject = message.subject ? `${message.subject}: ` : "";
      const unread = message.unread ? " unread" : "";
      lines.push(
        `  - ${message.channel}${unread} from ${message.sender.displayName}: ${subject}${message.snippet.slice(0, 120)}`,
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

function hasPositiveAmount(value: string | null | undefined): boolean {
  if (!value) return false;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0;
}

interface VincentLiveStatus {
  connected?: boolean;
  connectedAt?: number | null;
  tradingVenues?: readonly string[];
}

interface VincentLiveStrategy {
  connected?: boolean;
  strategy?: {
    name?: string;
    venues?: readonly string[];
  } | null;
}

interface HyperliquidLiveStatus {
  publicReadReady?: boolean;
  signerReady?: boolean;
  executionReady?: boolean;
  executionBlockedReason?: string | null;
  accountAddress?: string | null;
}

interface PolymarketLiveStatus {
  publicReads?: {
    ready?: boolean;
  };
  trading?: {
    ready?: boolean;
    credentialsReady?: boolean;
    reason?: string | null;
    missing?: readonly string[];
  };
}

async function renderWalletLiveState(): Promise<string | null> {
  const [
    config,
    balances,
    nfts,
    profile,
    hyperliquidStatus,
    polymarketStatus,
    vincentStatus,
    vincentStrategy,
  ] = await Promise.all([
    fetchLocalJson<WalletConfigStatus>("/api/wallet/config"),
    fetchLocalJson<WalletBalancesResponse>("/api/wallet/balances"),
    fetchLocalJson<WalletNftsResponse>("/api/wallet/nfts"),
    fetchLocalJson<WalletTradingProfileResponse>(
      "/api/wallet/trading/profile?window=24h&source=all",
    ),
    fetchLocalJson<HyperliquidLiveStatus>("/api/hyperliquid/status"),
    fetchLocalJson<PolymarketLiveStatus>("/api/polymarket/status"),
    fetchLocalJson<VincentLiveStatus>("/api/vincent/status"),
    fetchLocalJson<VincentLiveStrategy>("/api/vincent/strategy"),
  ]);

  if (
    !config &&
    !balances &&
    !nfts &&
    !profile &&
    !hyperliquidStatus &&
    !polymarketStatus &&
    !vincentStatus
  ) {
    return "Live wallet state: unavailable from the Wallet API.";
  }

  const lines: string[] = ["Live wallet state:"];
  if (config) {
    lines.push(`- Wallet source: ${config.walletSource ?? "unknown"}`);
    lines.push(`- EVM address: ${shortAddress(config.evmAddress)}`);
    lines.push(`- Solana address: ${shortAddress(config.solanaAddress)}`);
    lines.push(
      `- RPC providers: EVM=${config.selectedRpcProviders.evm}, Solana=${config.selectedRpcProviders.solana}`,
    );
    lines.push(
      `- Readiness: EVM balances ${readyLabel(config.evmBalanceReady)}, Solana balances ${readyLabel(config.solanaBalanceReady)}, execution ${readyLabel(config.executionReady)}`,
    );
    if (config.executionBlockedReason) {
      lines.push(`- Execution blocked: ${config.executionBlockedReason}`);
    }
    lines.push(
      `- Signing: EVM=${config.evmSigningCapability ?? "unknown"}, Solana=${readyLabel(config.solanaSigningAvailable)}`,
    );
  }

  const assetLines: string[] = [];
  if (balances?.evm) {
    for (const chain of balances.evm.chains) {
      if (hasPositiveAmount(chain.nativeBalance)) {
        assetLines.push(`${chain.nativeBalance} ${chain.nativeSymbol}`);
      }
      for (const token of chain.tokens) {
        if (hasPositiveAmount(token.balance)) {
          assetLines.push(`${token.balance} ${token.symbol}`);
        }
      }
    }
  }
  if (balances?.solana) {
    if (hasPositiveAmount(balances.solana.solBalance)) {
      assetLines.push(`${balances.solana.solBalance} SOL`);
    }
    for (const token of balances.solana.tokens) {
      if (hasPositiveAmount(token.balance)) {
        assetLines.push(`${token.balance} ${token.symbol}`);
      }
    }
  }
  if (balances?.evm || balances?.solana) {
    lines.push(
      `- Token inventory: ${assetLines.length} asset${assetLines.length === 1 ? "" : "s"}.`,
    );
    for (const asset of assetLines.slice(0, 10)) {
      lines.push(`  - ${asset}`);
    }
  }

  if (nfts) {
    const evmNftCount = nfts.evm.reduce(
      (sum, chain) => sum + chain.nfts.length,
      0,
    );
    const solanaNftCount = nfts.solana?.nfts.length ?? 0;
    const nftCount = evmNftCount + solanaNftCount;
    lines.push(`- NFTs: ${nftCount} item${nftCount === 1 ? "" : "s"}.`);
  }

  if (profile) {
    lines.push(
      `- 24h activity: ${profile.summary.totalSwaps} swap${profile.summary.totalSwaps === 1 ? "" : "s"}, realized P&L ${profile.summary.realizedPnlBnb} BNB, volume ${profile.summary.volumeBnb} BNB.`,
    );
  }

  if (hyperliquidStatus) {
    lines.push(
      `- Hyperliquid native: public reads ${readyLabel(hyperliquidStatus.publicReadReady)}, signer ${readyLabel(hyperliquidStatus.signerReady)}, execution ${readyLabel(hyperliquidStatus.executionReady)}, account ${shortAddress(hyperliquidStatus.accountAddress)}.`,
    );
    if (hyperliquidStatus.executionBlockedReason) {
      lines.push(
        `- Hyperliquid execution blocked: ${hyperliquidStatus.executionBlockedReason}`,
      );
    }
  }

  if (polymarketStatus) {
    lines.push(
      `- Polymarket native: public reads ${readyLabel(polymarketStatus.publicReads?.ready)}, credentials ${readyLabel(polymarketStatus.trading?.credentialsReady)}, trading ${readyLabel(polymarketStatus.trading?.ready)}.`,
    );
    if (polymarketStatus.trading?.reason) {
      lines.push(
        `- Polymarket trading blocked: ${polymarketStatus.trading.reason}`,
      );
    }
  }

  if (vincentStatus) {
    const connected = vincentStatus.connected ? "connected" : "not connected";
    const venues = vincentStatus.tradingVenues?.join(", ") ?? "unknown venues";
    lines.push(`- Vincent delegated trading: ${connected} for ${venues}.`);
  }
  const strategy = vincentStrategy?.strategy;
  if (strategy) {
    const venues = strategy.venues ?? [];
    const venueText = venues.length > 0 ? ` venues=${venues.join(", ")}` : "";
    lines.push(
      `- Vincent strategy: ${strategy.name ?? "unknown"}${venueText}.`,
    );
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
    case "page-lifeops":
      return renderLifeOpsLiveState();
    case "page-connectors":
    case "page-plugins":
    case "page-settings":
      return null;
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
    "Operational context for the current page-scoped chat (Browser, Character, Apps, Connectors, Plugins, Settings, LifeOps, Automations, Wallet).",
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
  roleGate: { minRole: "USER" },

  async get(runtime: IAgentRuntime, message: Memory): Promise<ProviderResult> {
    try {
      if (!(await hasOwnerAccess(runtime, message))) {
        return EMPTY_RESULT;
      }

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
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "[page-scoped-context] Error",
      );
      return EMPTY_RESULT;
    }
  },
};
