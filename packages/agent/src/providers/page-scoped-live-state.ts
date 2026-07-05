/**
 * Live-state renderers for the per-view dashboard surfaces (wallet, character,
 * browser, apps, automations, knowledge, transcripts). Each renderer pulls real
 * state — from the local agent API or the runtime's own stores — and formats a
 * compact, agent-readable brief for a given `ConversationScope`.
 *
 * A leaf module by design: it depends only on `@elizaos/core`, `@elizaos/shared`,
 * and API-layer types, never on providers or services. Both the page-scoped
 * context provider (`page-scoped-context.ts`) and the proactive-interaction
 * decider (`../services/proactive-interaction-decider.ts`) consume it, so keeping
 * it a leaf avoids a providers ↔ services import cycle (#13587).
 *
 * Doctrine: never fabricate a zero. When a fetch fails, renderers return an
 * explicit "unavailable" line (agent-visible, not silence) and route the failure
 * through `runtime.reportError`; a genuinely empty result renders a designed
 * empty brief, distinct from an unreachable one.
 */
import { type IAgentRuntime, logger } from "@elizaos/core";
import type {
  AppRunSummary,
  RegistryAppInfo,
  WalletBalancesResponse,
  WalletConfigStatus,
  WalletNftsResponse,
  WalletTradingProfileResponse,
} from "@elizaos/shared";
import type { ConversationScope } from "../api/server-types.ts";

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
      if (response.ok) return (await response.json()) as T;
    } catch (err) {
      // error-policy:J4 local-API port failover — the dev API lives on one of a
      // small candidate port set; a connection failure just means try the next
      // port. Exhausting every port returns null, which every caller renders as
      // an explicit "unavailable from the … API" line (agent-visible, not silence).
      logger.debug(
        { err, url },
        "[PageScopedLiveState] local API port unreachable",
      );
    }
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

/**
 * Minimal structural view of the browser workspace service. Typed locally so
 * the module never takes an import edge into the browser plugin; the service is
 * resolved by its runtime service type and the section is omitted for agents
 * that do not have the plugin enabled.
 */
interface BrowserWorkspaceSnapshotView {
  mode: string;
  tabs: Array<{ title?: string | null; url: string; visible?: boolean }>;
}
interface BrowserWorkspaceServiceLike {
  getWorkspaceSnapshot(): Promise<BrowserWorkspaceSnapshotView>;
}

const BROWSER_SERVICE_TYPE = "browser";

function isBrowserWorkspaceService(
  service: unknown,
): service is BrowserWorkspaceServiceLike {
  return (
    typeof (service as { getWorkspaceSnapshot?: unknown } | null)
      ?.getWorkspaceSnapshot === "function"
  );
}

async function renderBrowserLiveState(
  runtime: IAgentRuntime,
): Promise<string | null> {
  const service = runtime.getService(BROWSER_SERVICE_TYPE);
  if (!isBrowserWorkspaceService(service)) return null;
  try {
    const snapshot = await service.getWorkspaceSnapshot();
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
  } catch (err) {
    // error-policy:J4 explicit user-facing degrade — one failing subsection
    // (browser service throwing) must not blank the whole context, so it
    // degrades to an omitted section; the failure is reported so it reaches the
    // RECENT_ERRORS provider instead of vanishing.
    runtime.reportError("PageScopedContext.browserLiveState", err);
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
      if (!app.name || apps.has(app.name)) continue;
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
      const health = run.health.state ? ` health=${run.health.state}` : "";
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

function hasPositiveAmount(value: string | null | undefined): boolean {
  if (!value) return false;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0;
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
  const [config, balances, nfts, profile, hyperliquidStatus, polymarketStatus] =
    await Promise.all([
      fetchLocalJson<WalletConfigStatus>("/api/wallet/config"),
      fetchLocalJson<WalletBalancesResponse>("/api/wallet/balances"),
      fetchLocalJson<WalletNftsResponse>("/api/wallet/nfts"),
      fetchLocalJson<WalletTradingProfileResponse>(
        "/api/wallet/trading/profile?window=24h&source=all",
      ),
      fetchLocalJson<HyperliquidLiveStatus>("/api/hyperliquid/status"),
      fetchLocalJson<PolymarketLiveStatus>("/api/polymarket/status"),
    ]);

  if (
    !config &&
    !balances &&
    !nfts &&
    !profile &&
    !hyperliquidStatus &&
    !polymarketStatus
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
      const name = task.name;
      const tagList =
        Array.isArray(task.tags) && task.tags.length > 0
          ? ` [${task.tags.join(", ")}]`
          : "";
      lines.push(`- ${name}${tagList}`);
    }
    return lines.join("\n");
  } catch (err) {
    // error-policy:J4 explicit user-facing degrade — a failing task read must
    // not blank the whole context; the automations section is omitted and the
    // failure is reported so it surfaces via the RECENT_ERRORS provider.
    runtime.reportError("PageScopedContext.automationsLiveState", err);
    return null;
  }
}

const KNOWLEDGE_LIVE_STATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const KNOWLEDGE_LIVE_STATE_SCAN_LIMIT = 500;
const ATTACHMENT_DOCUMENT_TAG = "attachment";
const MEDIA_FORMAT_TAG_PREFIX = "media-format:";
const TRANSCRIPT_DOCUMENT_TAG = "transcript";

function documentStringTags(
  metadata: Record<string, unknown> | undefined,
): string[] {
  const tags = metadata?.tags;
  return Array.isArray(tags)
    ? tags.filter((value): value is string => typeof value === "string")
    : [];
}

function documentMediaFormat(
  metadata: Record<string, unknown> | undefined,
  tags: string[],
): string {
  if (typeof metadata?.mediaFormat === "string" && metadata.mediaFormat) {
    return metadata.mediaFormat;
  }
  const tagged = tags.find((tag) => tag.startsWith(MEDIA_FORMAT_TAG_PREFIX));
  return tagged ? tagged.slice(MEDIA_FORMAT_TAG_PREFIX.length) : "file";
}

function documentAddedAt(
  metadata: Record<string, unknown> | undefined,
  createdAt: number | undefined,
): number | undefined {
  return (
    (typeof metadata?.addedAt === "number" ? metadata.addedAt : undefined) ??
    (typeof metadata?.timestamp === "number"
      ? metadata.timestamp
      : undefined) ??
    (typeof createdAt === "number" ? createdAt : undefined)
  );
}

/**
 * Live knowledge state for the Knowledge view (#13593): counts of recently
 * ingested chat attachments (and transcript mirrors) over the trailing week,
 * broken down by media format — the count surface the proactive greeting reads
 * ("You have N new attachments from Discord this week…").
 */
async function renderKnowledgeLiveState(
  runtime: IAgentRuntime,
): Promise<string | null> {
  const now = Date.now();
  const windowStart = now - KNOWLEDGE_LIVE_STATE_WINDOW_MS;
  let recentAttachments = 0;
  let recentTranscripts = 0;
  const byFormat = new Map<string, number>();

  try {
    const batch = await runtime.getMemories({
      tableName: "documents",
      // Scope to THIS agent so a shared/multi-agent adapter does not count
      // another agent's attachment/transcript records into this page's context.
      agentId: runtime.agentId,
      count: KNOWLEDGE_LIVE_STATE_SCAN_LIMIT,
      offset: 0,
    });
    for (const memory of batch) {
      if (memory.agentId && memory.agentId !== runtime.agentId) continue;
      const metadata = (memory.metadata ?? undefined) as
        | Record<string, unknown>
        | undefined;
      const tags = documentStringTags(metadata);
      const isAttachment = tags.includes(ATTACHMENT_DOCUMENT_TAG);
      const isTranscript = tags.includes(TRANSCRIPT_DOCUMENT_TAG);
      if (!isAttachment && !isTranscript) continue;
      const at = documentAddedAt(metadata, memory.createdAt);
      if (typeof at === "number" && at < windowStart) continue;
      if (isAttachment) {
        recentAttachments += 1;
        const format = documentMediaFormat(metadata, tags);
        byFormat.set(format, (byFormat.get(format) ?? 0) + 1);
      } else if (isTranscript) {
        recentTranscripts += 1;
      }
    }
  } catch (err) {
    runtime.reportError("PageScopedContext.knowledgeLiveState", err);
    return "Live knowledge state: unavailable (documents store unreachable).";
  }

  const lines: string[] = [
    `Live knowledge state (last 7 days): ${recentAttachments} ingested chat attachment${
      recentAttachments === 1 ? "" : "s"
    }, ${recentTranscripts} transcript mirror${
      recentTranscripts === 1 ? "" : "s"
    }.`,
  ];
  if (byFormat.size > 0) {
    const parts = [...byFormat.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([format, count]) => `${format}=${count}`);
    lines.push(`Attachments by format: ${parts.join(", ")}.`);
  }
  return lines.join("\n");
}

/**
 * Live transcript state for the Transcripts view (#13587): count of recorded
 * voice transcripts ingested over the trailing week. Transcripts land in the
 * documents store tagged `transcript` (the same mirror the knowledge ingest
 * writes), so this counts those rows scoped to the current agent. An empty
 * result renders a designed empty line; an unreachable store renders an explicit
 * "unavailable" line and reports the failure — never a fabricated zero.
 */
async function renderTranscriptsLiveState(
  runtime: IAgentRuntime,
): Promise<string | null> {
  const now = Date.now();
  const windowStart = now - KNOWLEDGE_LIVE_STATE_WINDOW_MS;
  let recentTranscripts = 0;
  let newestAt: number | undefined;

  try {
    const batch = await runtime.getMemories({
      tableName: "documents",
      agentId: runtime.agentId,
      count: KNOWLEDGE_LIVE_STATE_SCAN_LIMIT,
      offset: 0,
    });
    for (const memory of batch) {
      if (memory.agentId && memory.agentId !== runtime.agentId) continue;
      const metadata = (memory.metadata ?? undefined) as
        | Record<string, unknown>
        | undefined;
      const tags = documentStringTags(metadata);
      if (!tags.includes(TRANSCRIPT_DOCUMENT_TAG)) continue;
      const at = documentAddedAt(metadata, memory.createdAt);
      if (typeof at === "number" && at < windowStart) continue;
      recentTranscripts += 1;
      if (typeof at === "number" && (newestAt === undefined || at > newestAt)) {
        newestAt = at;
      }
    }
  } catch (err) {
    runtime.reportError("PageScopedContext.transcriptsLiveState", err);
    return "Live transcript state: unavailable (transcript store unreachable).";
  }

  if (recentTranscripts === 0) {
    return "Live transcript state (last 7 days): no recorded transcripts yet.";
  }
  const lines: string[] = [
    `Live transcript state (last 7 days): ${recentTranscripts} recorded transcript${
      recentTranscripts === 1 ? "" : "s"
    }.`,
  ];
  if (typeof newestAt === "number") {
    const minutesAgo = Math.max(0, Math.round((now - newestAt) / 60000));
    lines.push(`Newest transcript: ${minutesAgo} minute(s) ago.`);
  }
  return lines.join("\n");
}

/**
 * Render the live-state brief for a `ConversationScope`. Returns null for scopes
 * that carry no live-state surface (connectors/plugins/settings today), which
 * callers render as "no live state" rather than an error.
 */
export async function renderLiveStateForScope(
  runtime: IAgentRuntime,
  scope: ConversationScope,
): Promise<string | null> {
  switch (scope) {
    case "page-character":
      return renderCharacterLiveState(runtime);
    case "page-knowledge":
      return renderKnowledgeLiveState(runtime);
    case "page-transcripts":
      return renderTranscriptsLiveState(runtime);
    case "page-browser":
      return renderBrowserLiveState(runtime);
    case "page-automations":
    case "automation-draft":
      return renderAutomationsLiveState(runtime);
    case "page-apps":
      return renderAppsLiveState();
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

/**
 * Map a view id (as carried on VIEW_SWITCHED / ViewDeclaration.id) to the
 * `ConversationScope` whose live-state renderer applies. Ids not listed have no
 * live-state surface — the proactive judge greets from the declared intent alone.
 */
const VIEW_ID_TO_SCOPE: Record<string, ConversationScope> = {
  character: "page-character",
  documents: "page-knowledge",
  transcripts: "page-transcripts",
  automations: "page-automations",
  "plugins-page": "page-plugins",
  settings: "page-settings",
  wallet: "page-wallet",
  browser: "page-browser",
  apps: "page-apps",
  connectors: "page-connectors",
};

/**
 * Live-state brief for the proactive-interaction judge, keyed by view id.
 * Returns null when the view has no live-state surface. Shared with the
 * page-scoped context provider through {@link renderLiveStateForScope}; kept in
 * this leaf module so the decider (services) can reach it without a providers ↔
 * services import cycle (#13587).
 */
export async function renderViewLiveStateForJudge(
  runtime: IAgentRuntime,
  viewId: string,
): Promise<string | null> {
  const scope = VIEW_ID_TO_SCOPE[viewId];
  if (!scope) return null;
  return renderLiveStateForScope(runtime, scope);
}
