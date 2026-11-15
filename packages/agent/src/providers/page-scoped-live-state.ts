/**
 * Live-state renderers for the per-view dashboard surfaces (wallet, character,
 * browser, apps, automations, knowledge, transcripts). Each renderer pulls real
 * state — from the local agent API or the runtime's own stores — and formats a
 * compact, agent-readable brief for a given `ConversationScope`.
 *
 * A leaf module by design: it depends only on `@elizaos/core`, API-layer types,
 * the self-API caller and the pure trigger/workbench readers, never on
 * providers or services. Both the page-scoped
 * context provider (`page-scoped-context.ts`) and the proactive-interaction
 * decider (`../services/proactive-interaction-decider.ts`) consume it, so keeping
 * it a leaf avoids a providers ↔ services import cycle (#13587).
 *
 * Doctrine: never fabricate a zero. When a fetch fails, renderers return an
 * explicit "unavailable" line (agent-visible, not silence) and route the failure
 * through `runtime.reportError`; a genuinely empty result renders a designed
 * empty brief, distinct from an unreachable one.
 */

import type {
  ConversationScope,
  WalletBalancesResponse,
  WalletConfigStatus,
  WalletNftsResponse,
} from "@elizaos/contracts";
import {
  type IAgentRuntime,
  logger,
  type RegistryAppInfo,
  type Task,
  toWellFormedUnicode,
} from "@elizaos/core";
import { toWorkbenchTask } from "@elizaos/host/protocol";
import { callSelfApi } from "../api/self-api.ts";
import { readTriggerConfig } from "../triggers/runtime.ts";

async function renderCharacterLiveState(
  runtime: IAgentRuntime,
): Promise<string | null> {
  const character = runtime.character;
  if (!character) return null;
  const lines: string[] = ["Live character state:"];
  lines.push(`- Name: ${character.name ?? "(unnamed)"}`);
  const bio = (
    character as {
      bio?: unknown;
    }
  ).bio;
  if (typeof bio === "string" && bio.trim().length > 0) {
    lines.push(`- Bio: ${toWellFormedUnicode(bio.trim())}`);
  } else if (Array.isArray(bio) && bio.length > 0) {
    lines.push(`- Bio: ${bio.map(String).map(toWellFormedUnicode).join("; ")}`);
  }
  const exampleCount = Array.isArray(character.messageExamples)
    ? character.messageExamples.length
    : 0;
  lines.push(`- Message examples: ${exampleCount}`);
  return lines.join("\n");
}
async function fetchLocalJson<T>(
  runtime: IAgentRuntime,
  path: string,
  timeoutMs = 1500,
): Promise<T | null> {
  // Over HTTP only to this process's own listener; with no listener the
  // route runs in process, so the bearer never reaches a port another app
  // could have bound. The page-scoped provider is OWNER-gated and the
  // proactive judge is internal, which is what the root bearer granted.
  try {
    const response = await callSelfApi({
      runtime,
      path,
      isAuthorized: () => true,
      timeoutMs,
    });
    if (response.status >= 200 && response.status < 300) {
      return response.body as T;
    }
  } catch (err) {
    // error-policy:J4 local-API unavailability — an unreachable self-API
    // returns null, which every caller renders as an explicit "unavailable
    // from the … API" line (agent-visible, not silence).
    logger.debug({ err, path }, "[PageScopedLiveState] local API unreachable");
  }
  return null;
}
/**
 * Minimal structural view of the browser workspace service. Typed locally so
 * the module never takes an import edge into the browser plugin; the service is
 * resolved by its runtime service type and the section is omitted for agents
 * that do not have the plugin enabled.
 */
interface BrowserWorkspaceSnapshotView {
  mode: string;
  tabs: Array<{
    title?: string | null;
    url: string;
    visible?: boolean;
  }>;
}
interface BrowserWorkspaceServiceLike {
  getWorkspaceSnapshot(): Promise<BrowserWorkspaceSnapshotView>;
}
const BROWSER_SERVICE_TYPE = "browser";
function isBrowserWorkspaceService(
  service: unknown,
): service is BrowserWorkspaceServiceLike {
  return (
    typeof (
      service as {
        getWorkspaceSnapshot?: unknown;
      } | null
    )?.getWorkspaceSnapshot === "function"
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
    for (const tab of snapshot.tabs) {
      const flags = tab.visible ? "[visible]" : "";
      lines.push(`- ${tab.title || "(untitled)"} — ${tab.url} ${flags}`.trim());
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
async function renderAppsLiveState(
  runtime: IAgentRuntime,
): Promise<string | null> {
  const catalogApps = await fetchLocalJson<RegistryAppInfo[]>(
    runtime,
    "/api/catalog/apps",
  );
  if (!catalogApps) {
    return "Live apps state: unavailable from the Apps API.";
  }
  const apps = [...catalogApps].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
  const lines: string[] = [
    `Live apps state: ${apps.length} catalog app${apps.length === 1 ? "" : "s"}.`,
  ];
  if (apps.length > 0) {
    lines.push("Catalog sample:");
    for (const app of apps) {
      const capabilities =
        app.capabilities.length > 0
          ? ` capabilities=${app.capabilities.join(", ")}`
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
  return toWellFormedUnicode(address);
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
async function renderWalletLiveState(
  runtime: IAgentRuntime,
): Promise<string | null> {
  const [config, balances, nfts] = await Promise.all([
    fetchLocalJson<WalletConfigStatus>(runtime, "/api/wallet/config"),
    fetchLocalJson<WalletBalancesResponse>(runtime, "/api/wallet/balances"),
    fetchLocalJson<WalletNftsResponse>(runtime, "/api/wallet/nfts"),
  ]);
  if (!config && !balances && !nfts) {
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
  // A chain whose balance read failed is unknown, not empty: name it and drop
  // the inventory total rather than count it as zero.
  const unavailableChains: string[] = [];
  if (balances?.evm) {
    for (const chain of balances.evm.chains) {
      if (chain.error) {
        unavailableChains.push(chain.chain);
        continue;
      }
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
    const solanaError = (balances.solana as { error?: unknown }).error;
    if (solanaError) {
      unavailableChains.push("Solana");
    } else {
      if (hasPositiveAmount(balances.solana.solBalance)) {
        assetLines.push(`${balances.solana.solBalance} SOL`);
      }
      for (const token of balances.solana.tokens) {
        if (hasPositiveAmount(token.balance)) {
          assetLines.push(`${token.balance} ${token.symbol}`);
        }
      }
    }
  }
  for (const chain of unavailableChains) {
    lines.push(`- Balances unavailable for ${toWellFormedUnicode(chain)}.`);
  }
  if (balances?.evm || balances?.solana) {
    if (unavailableChains.length === 0) {
      lines.push(
        `- Token inventory: ${assetLines.length} asset${assetLines.length === 1 ? "" : "s"}.`,
      );
    } else if (assetLines.length > 0) {
      lines.push("- Token inventory (partial):");
    }
    for (const asset of assetLines) {
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
  return lines.join("\n");
}
function describeTriggerSchedule(
  trigger: NonNullable<ReturnType<typeof readTriggerConfig>>,
): string {
  if (trigger.triggerType === "interval" && trigger.intervalMs) {
    const mins = Math.round(trigger.intervalMs / 60_000);
    return mins >= 60 ? `every ${Math.round(mins / 60)}h` : `every ${mins}m`;
  }
  if (trigger.triggerType === "cron" && trigger.cronExpression) {
    return `cron: ${trigger.cronExpression}`;
  }
  if (trigger.triggerType === "once") return "one-time";
  return trigger.triggerType;
}
/**
 * Only user-visible automations: triggers by display name and workbench tasks.
 * Internal queue rows (TRIGGER_DISPATCH, maintenance) are skipped, matching the
 * ongoing-tasks provider and the automations feed.
 */
function formatAutomationLine(task: Task): string | null {
  const trigger = readTriggerConfig(task);
  if (trigger) {
    const status = trigger.enabled ? "active" : "paused";
    return `- [${status}] ${toWellFormedUnicode(trigger.displayName)} (${describeTriggerSchedule(trigger)})`;
  }
  const workbench = toWorkbenchTask(task);
  if (!workbench) return null;
  const status = workbench.isCompleted ? "completed" : "active";
  return `- [${status}] ${toWellFormedUnicode(workbench.name)}`;
}
async function renderAutomationsLiveState(
  runtime: IAgentRuntime,
): Promise<string | null> {
  try {
    const tasks = await runtime.getTasks({ agentIds: [runtime.agentId] });
    const entries = tasks
      .map(formatAutomationLine)
      .filter((line): line is string => line !== null);
    if (entries.length === 0) {
      return "Live automations state: no automations defined.";
    }
    return [
      `Live automations state: ${entries.length} automation${entries.length === 1 ? "" : "s"}.`,
      ...entries,
    ].join("\n");
  } catch (err) {
    // error-policy:J4 explicit user-facing degrade — a failing task read must
    // not blank the whole context; the automations section is omitted and the
    // failure is reported so it surfaces via the RECENT_ERRORS provider.
    runtime.reportError("PageScopedContext.automationsLiveState", err);
    return null;
  }
}
const KNOWLEDGE_LIVE_STATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// Newest documents read per render. Counts hitting the cap render as "at least".
const DOCUMENTS_LIVE_STATE_LIMIT = 500;
function readRecentDocuments(runtime: IAgentRuntime) {
  return runtime.getMemories({
    tableName: "documents",
    // Scope to THIS agent so a shared/multi-agent adapter does not count
    // another agent's attachment/transcript records into this page's context.
    agentId: runtime.agentId,
    limit: DOCUMENTS_LIVE_STATE_LIMIT,
    orderBy: "createdAt",
    orderDirection: "desc",
    includeEmbedding: false,
  });
}
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
  let capped = false;
  try {
    const batch = await readRecentDocuments(runtime);
    capped = batch.length >= DOCUMENTS_LIVE_STATE_LIMIT;
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
  const atLeast = capped ? "at least " : "";
  const lines: string[] = [
    `Live knowledge state (last 7 days): ${atLeast}${recentAttachments} ingested chat attachment${recentAttachments === 1 ? "" : "s"}, ${atLeast}${recentTranscripts} transcript mirror${recentTranscripts === 1 ? "" : "s"}.`,
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
  let capped = false;
  try {
    const batch = await readRecentDocuments(runtime);
    capped = batch.length >= DOCUMENTS_LIVE_STATE_LIMIT;
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
    return capped
      ? `Live transcript state (last 7 days): no recorded transcripts among the newest ${DOCUMENTS_LIVE_STATE_LIMIT} documents.`
      : "Live transcript state (last 7 days): no recorded transcripts yet.";
  }
  const lines: string[] = [
    `Live transcript state (last 7 days): ${capped ? "at least " : ""}${recentTranscripts} recorded transcript${recentTranscripts === 1 ? "" : "s"}.`,
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
      return renderAppsLiveState(runtime);
    case "page-connectors":
    case "page-plugins":
    case "page-settings":
      return null;
    case "page-wallet":
      return renderWalletLiveState(runtime);
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
