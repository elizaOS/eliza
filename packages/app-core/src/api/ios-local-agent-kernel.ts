import {
  MODEL_CATALOG,
  findCatalogModel,
} from "../services/local-inference/catalog";
import type { ProviderStatus } from "../services/local-inference/providers";
import type { RoutingPreferences } from "../services/local-inference/routing-preferences";
import type {
  ActiveModelState,
  AgentModelSlot,
  CatalogModel,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
  ModelAssignments,
} from "../services/local-inference/types";
import { AGENT_MODEL_SLOTS } from "../services/local-inference/types";
import type { IttpAgentRequestContext } from "./ittp-agent-transport";

const STORAGE_PREFIX = "eliza:ios-local-agent";
const CONVERSATIONS_KEY = `${STORAGE_PREFIX}:conversations:v1`;
const ACTIVE_MODEL_KEY = `${STORAGE_PREFIX}:active-model:v1`;
const ASSIGNMENTS_KEY = `${STORAGE_PREFIX}:assignments:v1`;
const BROWSER_WORKSPACE_KEY = `${STORAGE_PREFIX}:browser-workspace:v1`;
const AGENT_NAME = "Eliza";
const DEFAULT_SYSTEM_PROMPT =
  "You are Eliza, a private on-device assistant. Answer directly and concisely.";
const EMPTY_ROUTING_PREFERENCES: RoutingPreferences = {
  preferredProvider: {},
  policy: {},
};

type Role = "user" | "assistant";

interface LocalConversation {
  id: string;
  title: string;
  roomId: string;
  createdAt: string;
  updatedAt: string;
  messages: LocalMessage[];
}

interface LocalMessage {
  id: string;
  role: Role;
  text: string;
  timestamp: number;
}

interface ConversationStore {
  conversations: LocalConversation[];
}

interface LocalBrowserWorkspaceTab {
  id: string;
  title: string;
  url: string;
  partition: string;
  kind?: "internal" | "standard";
  visible: boolean;
  createdAt: string;
  updatedAt: string;
  lastFocusedAt: string | null;
}

interface BrowserWorkspaceStore {
  tabs: LocalBrowserWorkspaceTab[];
}

const EMPTY_WALLET_ADDRESSES = {
  evmAddress: null,
  solanaAddress: null,
};

const EMPTY_WALLET_RPC_SELECTIONS = {
  evm: "eliza-cloud",
  bsc: "eliza-cloud",
  solana: "eliza-cloud",
};

type CapacitorLlamaAdapter = {
  getHardwareInfo?: () => Promise<{
    platform?: "ios" | "android" | "web";
    totalRamGb?: number;
    availableRamGb?: number | null;
    cpuCores?: number;
    gpu?: {
      backend?: "metal" | "vulkan" | "gpu-delegate";
      available?: boolean;
    } | null;
    gpuSupported?: boolean;
  }>;
  isLoaded?: () => Promise<{ loaded: boolean; modelPath: string | null }>;
  currentModelPath?: () => string | null;
  load?: (options: {
    modelPath: string;
    contextSize?: number;
    useGpu?: boolean;
  }) => Promise<void>;
  generate?: (options: {
    prompt: string;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
  }) => Promise<{
    text: string;
    promptTokens: number;
    outputTokens: number;
    durationMs: number;
  }>;
};

type CapacitorLlamaModule = {
  capacitorLlama?: CapacitorLlamaAdapter;
};

type LlamaCppModule = {
  downloadModel?: (
    url: string,
    filename: string,
  ) => Promise<string | { path?: string }>;
  getAvailableModels?: () => Promise<
    | Array<{ name?: string; path?: string; size?: number }>
    | { models?: Array<{ name?: string; path?: string; size?: number }> }
  >;
};

let startedAt = Date.now();
let running = false;
let activeState: ActiveModelState = readActiveModelState();
const downloads = new Map<string, DownloadJob>();
let llamaAdapterPromise: Promise<CapacitorLlamaAdapter | null> | null = null;
let llamaCppPromise: Promise<LlamaCppModule | null> | null = null;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage can be unavailable in embedded shells.
  }
}

function readStore(): ConversationStore {
  const parsed = readJson<ConversationStore>(CONVERSATIONS_KEY, {
    conversations: [],
  });
  return {
    conversations: Array.isArray(parsed.conversations)
      ? parsed.conversations
      : [],
  };
}

function writeStore(store: ConversationStore): void {
  writeJson(CONVERSATIONS_KEY, store);
}

function readBrowserWorkspaceStore(): BrowserWorkspaceStore {
  const parsed = readJson<BrowserWorkspaceStore>(BROWSER_WORKSPACE_KEY, {
    tabs: [],
  });
  return {
    tabs: Array.isArray(parsed.tabs) ? parsed.tabs : [],
  };
}

function writeBrowserWorkspaceStore(store: BrowserWorkspaceStore): void {
  writeJson(BROWSER_WORKSPACE_KEY, store);
}

function normalizeBrowserWorkspaceUrl(rawUrl: unknown): string {
  const value = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!value) return "about:blank";
  if (value === "about:blank") return value;
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)
    ? value
    : `https://${value}`;
}

function normalizeBrowserWorkspaceKind(
  value: unknown,
): "internal" | "standard" | undefined {
  return value === "internal" || value === "standard" ? value : undefined;
}

function browserWorkspaceSnapshot(): {
  mode: "web";
  tabs: LocalBrowserWorkspaceTab[];
} {
  return {
    mode: "web",
    tabs: readBrowserWorkspaceStore().tabs,
  };
}

async function openBrowserWorkspaceTab(
  request: Request,
): Promise<Response> {
  const body = await requestJson(request);
  const now = nowIso();
  const show = body.show !== false;
  const tab: LocalBrowserWorkspaceTab = {
    id: randomId("btab"),
    title:
      typeof body.title === "string" && body.title.trim()
        ? body.title.trim()
        : "New tab",
    url: normalizeBrowserWorkspaceUrl(body.url),
    partition:
      typeof body.partition === "string" && body.partition.trim()
        ? body.partition.trim()
        : "persist:eliza-browser-user",
    visible: show,
    createdAt: now,
    updatedAt: now,
    lastFocusedAt: show ? now : null,
  };
  const kind = normalizeBrowserWorkspaceKind(body.kind);
  if (kind) tab.kind = kind;

  const store = readBrowserWorkspaceStore();
  const tabs = show
    ? store.tabs.map((entry) => ({ ...entry, visible: false }))
    : store.tabs;
  tabs.push(tab);
  writeBrowserWorkspaceStore({ tabs });
  return json({ tab });
}

async function handleBrowserWorkspaceTabRoute(
  request: Request,
  pathname: string,
): Promise<Response | null> {
  const method = request.method.toUpperCase();
  const match = pathname.match(
    /^\/api\/browser-workspace\/tabs\/([^/]+)(?:\/(navigate|show|hide|snapshot))?$/,
  );
  if (!match) return null;

  const tabId = decodeURIComponent(match[1]).trim();
  const action = match[2] ?? null;
  const store = readBrowserWorkspaceStore();
  const index = store.tabs.findIndex((tab) => tab.id === tabId);

  if (index < 0) {
    return json({ error: "Browser tab not found" }, 404);
  }

  if (!action && method === "DELETE") {
    store.tabs.splice(index, 1);
    writeBrowserWorkspaceStore(store);
    return json({ closed: true });
  }

  if (action === "snapshot" && method === "GET") {
    return json({ data: "" });
  }

  if (action === "show" && method === "POST") {
    const now = nowIso();
    store.tabs = store.tabs.map((tab) =>
      tab.id === tabId
        ? { ...tab, visible: true, updatedAt: now, lastFocusedAt: now }
        : { ...tab, visible: false },
    );
    writeBrowserWorkspaceStore(store);
    return json({ tab: store.tabs[index] });
  }

  if (action === "hide" && method === "POST") {
    const now = nowIso();
    store.tabs[index] = {
      ...store.tabs[index],
      visible: false,
      updatedAt: now,
    };
    writeBrowserWorkspaceStore(store);
    return json({ tab: store.tabs[index] });
  }

  if (action === "navigate" && method === "POST") {
    const body = await requestJson(request);
    const now = nowIso();
    const url = normalizeBrowserWorkspaceUrl(body.url);
    store.tabs[index] = {
      ...store.tabs[index],
      url,
      title: url === "about:blank" ? "New tab" : store.tabs[index].title,
      updatedAt: now,
      lastFocusedAt: now,
      visible: true,
    };
    store.tabs = store.tabs.map((tab) =>
      tab.id === tabId ? store.tabs[index] : { ...tab, visible: false },
    );
    writeBrowserWorkspaceStore(store);
    return json({ tab: store.tabs.find((tab) => tab.id === tabId) });
  }

  return null;
}

function readActiveModelState(): ActiveModelState {
  const parsed = readJson<Partial<ActiveModelState>>(ACTIVE_MODEL_KEY, {});
  if (
    parsed.status === "ready" &&
    typeof parsed.modelId === "string" &&
    parsed.modelId.trim()
  ) {
    return {
      modelId: parsed.modelId.trim(),
      loadedAt:
        typeof parsed.loadedAt === "string" ? parsed.loadedAt : nowIso(),
      status: "ready",
    };
  }
  return { modelId: null, loadedAt: null, status: "idle" };
}

function writeActiveModelState(state: ActiveModelState): void {
  activeState = state;
  writeJson(ACTIVE_MODEL_KEY, state);
}

function readAssignments(): ModelAssignments {
  return readJson<ModelAssignments>(ASSIGNMENTS_KEY, {});
}

function writeAssignments(assignments: ModelAssignments): void {
  writeJson(ASSIGNMENTS_KEY, assignments);
}

function isAgentModelSlot(value: string): value is AgentModelSlot {
  return AGENT_MODEL_SLOTS.includes(value as AgentModelSlot);
}

async function capacitorLlamaProviderStatus(): Promise<ProviderStatus> {
  const available = Boolean(await loadCapacitorLlama());
  return {
    id: "capacitor-llama",
    label: "On-device llama.cpp (mobile)",
    kind: "local",
    description: "Runs llama.cpp natively inside the iOS app.",
    supportedSlots: ["TEXT_SMALL", "TEXT_LARGE"],
    configureHref: null,
    enableState: {
      enabled: available,
      reason: available
        ? "Native Capacitor runtime detected"
        : "Capacitor llama runtime unavailable",
    },
    registeredSlots:
      activeState.status === "ready" ? ["TEXT_SMALL", "TEXT_LARGE"] : [],
  };
}

function localConfig(): Record<string, unknown> {
  return {
    meta: { onboardingComplete: true },
    ui: {},
    cloud: {
      enabled: false,
      connectionStatus: "disconnected",
      cloudProvisioned: false,
    },
  };
}

function localCharacter(): Record<string, unknown> {
  return {
    name: AGENT_NAME,
    bio: ["Private on-device assistant"],
    lore: [],
    knowledge: [],
    messageExamples: [],
    postExamples: [],
    topics: [],
    style: { all: [], chat: [], post: [] },
    adjectives: [],
  };
}

function localWalletConfig(): Record<string, unknown> {
  return {
    ...EMPTY_WALLET_ADDRESSES,
    selectedRpcProviders: EMPTY_WALLET_RPC_SELECTIONS,
    walletNetwork: "mainnet",
    legacyCustomChains: [],
    alchemyKeySet: false,
    infuraKeySet: false,
    ankrKeySet: false,
    nodeRealBscRpcSet: false,
    quickNodeBscRpcSet: false,
    managedBscRpcReady: false,
    cloudManagedAccess: false,
    evmBalanceReady: false,
    ethereumBalanceReady: false,
    baseBalanceReady: false,
    bscBalanceReady: false,
    avalancheBalanceReady: false,
    solanaBalanceReady: false,
    heliusKeySet: false,
    birdeyeKeySet: false,
    evmChains: [
      "Ethereum",
      "Base",
      "Arbitrum",
      "Optimism",
      "Polygon",
      "BSC",
      "Avalanche",
    ],
    walletSource: "none",
    automationMode: "connectors-only",
    pluginEvmLoaded: false,
    pluginEvmRequired: false,
    executionReady: false,
    executionBlockedReason: "No wallet is configured for local iOS mode.",
    evmSigningCapability: "none",
    evmSigningReason: "No wallet is configured for local iOS mode.",
    solanaSigningAvailable: false,
    wallets: [],
  };
}

function emptyWalletMarketOverview(): Record<string, unknown> {
  const unavailable = (
    providerId: "coingecko" | "polymarket",
    providerName: string,
    providerUrl: string,
  ) => ({
    providerId,
    providerName,
    providerUrl,
    available: false,
    stale: false,
    error: "Market data is unavailable in local iOS mode.",
  });

  return {
    generatedAt: nowIso(),
    cacheTtlSeconds: 0,
    stale: false,
    sources: {
      prices: unavailable("coingecko", "CoinGecko", "https://www.coingecko.com"),
      movers: unavailable("coingecko", "CoinGecko", "https://www.coingecko.com"),
      predictions: unavailable(
        "polymarket",
        "Polymarket",
        "https://polymarket.com",
      ),
    },
    prices: [],
    movers: [],
    predictions: [],
  };
}

function emptyWalletTradingProfile(url: URL): Record<string, unknown> {
  const windowParam = url.searchParams.get("window");
  const sourceParam = url.searchParams.get("source");
  const selectedWindow =
    windowParam === "24h" ||
    windowParam === "7d" ||
    windowParam === "30d" ||
    windowParam === "all"
      ? windowParam
      : "30d";
  const selectedSource =
    sourceParam === "agent" || sourceParam === "manual" || sourceParam === "all"
      ? sourceParam
      : "all";

  return {
    window: selectedWindow,
    source: selectedSource,
    generatedAt: nowIso(),
    summary: {
      totalSwaps: 0,
      buyCount: 0,
      sellCount: 0,
      settledCount: 0,
      successCount: 0,
      revertedCount: 0,
      tradeWinRate: null,
      txSuccessRate: null,
      winningTrades: 0,
      evaluatedTrades: 0,
      realizedPnlBnb: "0",
      volumeBnb: "0",
    },
    pnlSeries: [],
    tokenBreakdown: [],
    recentSwaps: [],
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function textEventStream(events: unknown[]): Response {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

async function loadCapacitorLlama(): Promise<CapacitorLlamaAdapter | null> {
  llamaAdapterPromise ??= (async () => {
    try {
      const packageName = "@elizaos/capacitor-llama";
      const mod = (await import(
        /* @vite-ignore */ packageName
      )) as CapacitorLlamaModule | null;
      return mod?.capacitorLlama ?? null;
    } catch {
      return null;
    }
  })();
  return llamaAdapterPromise;
}

async function loadLlamaCpp(): Promise<LlamaCppModule | null> {
  llamaCppPromise ??= (async () => {
    try {
      const packageName = "llama-cpp-capacitor";
      return (await import(/* @vite-ignore */ packageName)) as LlamaCppModule;
    } catch {
      return null;
    }
  })();
  return llamaCppPromise;
}

function modelFilename(model: CatalogModel): string {
  return `${model.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.gguf`;
}

function buildHuggingFaceResolveUrl(model: CatalogModel): string {
  const encodedPath = model.ggufFile
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://huggingface.co/${model.hfRepo}/resolve/main/${encodedPath}?download=true`;
}

function catalogForAvailableModel(model: {
  name?: string;
  path?: string;
}): CatalogModel | undefined {
  const haystack = `${model.name ?? ""} ${model.path ?? ""}`.toLowerCase();
  return MODEL_CATALOG.find((candidate) => {
    const id = candidate.id.toLowerCase();
    const file = candidate.ggufFile.split("/").pop()?.toLowerCase() ?? "";
    return (
      haystack.includes(id) || (file.length > 0 && haystack.includes(file))
    );
  });
}

async function listInstalledModels(): Promise<InstalledModel[]> {
  const llama = await loadLlamaCpp();
  const result = await llama?.getAvailableModels?.().catch(() => []);
  const models = Array.isArray(result) ? result : (result?.models ?? []);
  const installedAt = nowIso();
  return models
    .filter((model) => typeof model.path === "string" && model.path.length > 0)
    .map((model): InstalledModel => {
      const catalog = catalogForAvailableModel(model);
      const id =
        catalog?.id ??
        (model.name || model.path || randomId("model")).replace(/\.gguf$/i, "");
      return {
        id,
        displayName: catalog?.displayName ?? model.name ?? id,
        path: model.path as string,
        sizeBytes: typeof model.size === "number" ? model.size : 0,
        ...(catalog?.hfRepo ? { hfRepo: catalog.hfRepo } : {}),
        installedAt,
        lastUsedAt: activeState.modelId === id ? activeState.loadedAt : null,
        source: catalog ? "eliza-download" : "external-scan",
      };
    });
}

async function hardwareProbe(): Promise<HardwareProbe> {
  const llama = await loadCapacitorLlama();
  const hardware = await llama?.getHardwareInfo?.().catch(() => null);
  const totalRamGb = hardware?.totalRamGb ?? 0;
  const cpuCores = hardware?.cpuCores ?? navigator.hardwareConcurrency ?? 0;
  const metal = hardware?.gpu?.available
    ? {
        backend: "metal" as const,
        totalVramGb: 0,
        freeVramGb: 0,
      }
    : null;
  return {
    totalRamGb,
    freeRamGb: hardware?.availableRamGb ?? totalRamGb,
    gpu: metal,
    cpuCores,
    platform: "darwin" as NodeJS.Platform,
    arch: "arm64" as NodeJS.Architecture,
    appleSilicon: true,
    recommendedBucket: totalRamGb >= 12 ? "mid" : "small",
    source: "os-fallback",
  };
}

async function ensureActiveModelLoaded(): Promise<void> {
  if (activeState.status !== "ready" || !activeState.modelId) {
    throw new Error(
      "No local model is active. Install and activate a GGUF model first.",
    );
  }
  const installed = await listInstalledModels();
  const model = installed.find((entry) => entry.id === activeState.modelId);
  if (!model) {
    writeActiveModelState({
      modelId: activeState.modelId,
      loadedAt: null,
      status: "error",
      error: "Active model file is missing",
    });
    throw new Error("Active model file is missing");
  }

  const llama = await loadCapacitorLlama();
  if (!llama?.load || !llama.generate) {
    throw new Error("Capacitor llama runtime is not available on this build.");
  }
  const loaded = await llama.isLoaded?.().catch(() => null);
  if (loaded?.loaded && loaded.modelPath === model.path) return;
  await llama.load({ modelPath: model.path, contextSize: 4096, useGpu: true });
}

function buildPrompt(messages: LocalMessage[], latestText: string): string {
  const history = messages
    .slice(-12)
    .map((message) => {
      const role = message.role === "assistant" ? "Assistant" : "User";
      return `${role}: ${message.text}`;
    })
    .join("\n");
  return `${DEFAULT_SYSTEM_PROMPT}\n\n${history}${history ? "\n" : ""}User: ${latestText}\nAssistant:`;
}

async function generateLocalReply(
  conversation: LocalConversation,
  text: string,
): Promise<{
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    model?: string;
  };
}> {
  await ensureActiveModelLoaded();
  const llama = await loadCapacitorLlama();
  if (!llama?.generate) {
    throw new Error("Capacitor llama runtime is not available on this build.");
  }
  const prompt = buildPrompt(conversation.messages, text);
  const result = await llama.generate({
    prompt,
    maxTokens: 256,
    temperature: 0.7,
    topP: 0.9,
    stopSequences: ["\nUser:", "\nAssistant:"],
  });
  const cleaned =
    result.text.trim() || "I could not generate a local response.";
  return {
    text: cleaned,
    usage: {
      promptTokens: result.promptTokens,
      completionTokens: result.outputTokens,
      totalTokens: result.promptTokens + result.outputTokens,
      ...(activeState.modelId ? { model: activeState.modelId } : {}),
    },
  };
}

function createConversation(title?: string): LocalConversation {
  const createdAt = nowIso();
  const id = randomId("conv");
  return {
    id,
    roomId: id,
    title: title?.trim() || "New chat",
    createdAt,
    updatedAt: createdAt,
    messages: [],
  };
}

function conversationDto(conversation: LocalConversation) {
  return {
    id: conversation.id,
    title: conversation.title,
    roomId: conversation.roomId,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

async function hubSnapshot() {
  const [installed, hardware] = await Promise.all([
    listInstalledModels(),
    hardwareProbe(),
  ]);
  return {
    catalog: MODEL_CATALOG,
    installed,
    active: activeState,
    downloads: [...downloads.values()],
    hardware,
    assignments: readAssignments(),
  };
}

function updateDownload(job: DownloadJob, patch: Partial<DownloadJob>): void {
  Object.assign(job, patch, { updatedAt: nowIso() });
  downloads.set(job.modelId, { ...job });
}

function startDownload(model: CatalogModel): DownloadJob {
  const existing = downloads.get(model.id);
  if (existing && ["queued", "downloading"].includes(existing.state)) {
    return existing;
  }
  const job: DownloadJob = {
    jobId: randomId("download"),
    modelId: model.id,
    state: "queued",
    received: 0,
    total: Math.round(model.sizeGb * 1024 ** 3),
    bytesPerSec: 0,
    etaMs: null,
    startedAt: nowIso(),
    updatedAt: nowIso(),
  };
  downloads.set(model.id, job);

  void (async () => {
    try {
      updateDownload(job, { state: "downloading" });
      const llama = await loadLlamaCpp();
      if (!llama?.downloadModel) {
        throw new Error("llama-cpp-capacitor downloadModel is unavailable.");
      }
      const result = await llama.downloadModel(
        buildHuggingFaceResolveUrl(model),
        modelFilename(model),
      );
      const path =
        typeof result === "string"
          ? result
          : (result.path ?? modelFilename(model));
      updateDownload(job, {
        state: "completed",
        received: job.total,
        etaMs: 0,
      });
      if (activeState.status === "idle" || !activeState.modelId) {
        await activateModel(model.id, path).catch(() => undefined);
      }
    } catch (error) {
      updateDownload(job, {
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return job;
}

async function activateModel(
  modelId: string,
  knownPath?: string,
): Promise<ActiveModelState> {
  const installed = await listInstalledModels();
  const model =
    installed.find((entry) => entry.id === modelId) ??
    (knownPath
      ? ({
          id: modelId,
          displayName: findCatalogModel(modelId)?.displayName ?? modelId,
          path: knownPath,
          sizeBytes: 0,
          installedAt: nowIso(),
          lastUsedAt: null,
          source: "eliza-download" as const,
        } satisfies InstalledModel)
      : null);
  if (!model) {
    const state: ActiveModelState = {
      modelId,
      loadedAt: null,
      status: "error",
      error: `Model ${modelId} is not installed.`,
    };
    writeActiveModelState(state);
    return state;
  }

  writeActiveModelState({ modelId, loadedAt: null, status: "loading" });
  try {
    const llama = await loadCapacitorLlama();
    if (!llama?.load) {
      throw new Error(
        "Capacitor llama runtime is not available on this build.",
      );
    }
    await llama.load({
      modelPath: model.path,
      contextSize: 4096,
      useGpu: true,
    });
    const state: ActiveModelState = {
      modelId,
      loadedAt: nowIso(),
      status: "ready",
    };
    writeActiveModelState(state);
    const assignments = readAssignments();
    writeAssignments({
      ...assignments,
      TEXT_SMALL: assignments.TEXT_SMALL ?? modelId,
      TEXT_LARGE: assignments.TEXT_LARGE ?? modelId,
    });
    return state;
  } catch (error) {
    const state: ActiveModelState = {
      modelId,
      loadedAt: null,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
    writeActiveModelState(state);
    return state;
  }
}

export function startIosLocalAgentKernel(): void {
  running = true;
  startedAt = startedAt || Date.now();
}

export async function handleIosLocalAgentRequest(
  request: Request,
  _context: IttpAgentRequestContext = {},
): Promise<Response> {
  startIosLocalAgentKernel();

  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const pathname = url.pathname;

  if (method === "OPTIONS") return new Response(null, { status: 204 });

  if (method === "GET" && pathname === "/api/health") {
    return json({
      ready: running,
      runtime: "ok",
      database: "localStorage",
      plugins: { loaded: 0, failed: 0 },
      coordinator: "not_wired",
      connectors: {},
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      agentState: running ? "running" : "not_started",
    });
  }

  if (method === "GET" && pathname === "/api/status") {
    return json({
      state: running ? "running" : "not_started",
      agentName: AGENT_NAME,
      model: activeState.status === "ready" ? activeState.modelId : undefined,
      startedAt,
      uptime: Date.now() - startedAt,
      cloud: {
        connectionStatus: "disconnected",
        activeAgentId: null,
        cloudProvisioned: false,
        hasApiKey: false,
      },
      pendingRestart: false,
      pendingRestartReasons: [],
    });
  }

  if (method === "GET" && pathname === "/api/auth/status") {
    return json({ required: false, pairingEnabled: false, expiresAt: null });
  }

  if (method === "GET" && pathname === "/api/auth/me") {
    return json({
      identity: {
        id: "local-agent",
        displayName: "Local Agent",
        kind: "machine",
      },
      session: { id: "local", kind: "local", expiresAt: null },
      access: {
        mode: "local",
        passwordConfigured: false,
        ownerConfigured: false,
      },
    });
  }

  if (method === "GET" && pathname === "/api/onboarding/status") {
    return json({
      complete: true,
      cloudProvisioned: false,
      deploymentTarget: "local",
    });
  }

  if (method === "GET" && pathname === "/api/config") {
    return json(localConfig());
  }

  if (method === "PUT" && pathname === "/api/config") {
    return json(localConfig());
  }

  if (method === "GET" && pathname === "/api/config/schema") {
    return json({ schema: {}, defaults: localConfig() });
  }

  if (method === "GET" && pathname === "/api/character") {
    return json(localCharacter());
  }

  if (method === "PUT" && pathname === "/api/character") {
    return json(localCharacter());
  }

  if (method === "GET" && pathname === "/api/wallet/addresses") {
    return json(EMPTY_WALLET_ADDRESSES);
  }

  if (method === "GET" && pathname === "/api/wallet/config") {
    return json(localWalletConfig());
  }

  if (method === "PUT" && pathname === "/api/wallet/config") {
    return json({ ok: true });
  }

  if (method === "GET" && pathname === "/api/wallet/balances") {
    return json({ evm: null, solana: null });
  }

  if (method === "GET" && pathname === "/api/wallet/nfts") {
    return json({ evm: [], solana: null });
  }

  if (method === "GET" && pathname === "/api/wallet/market-overview") {
    return json(emptyWalletMarketOverview());
  }

  if (method === "GET" && pathname === "/api/wallet/trading/profile") {
    return json(emptyWalletTradingProfile(url));
  }

  if (method === "POST" && pathname === "/api/wallet/refresh-cloud") {
    return json({
      ok: false,
      warnings: ["Cloud wallet refresh is unavailable in local iOS mode."],
    });
  }

  if (method === "POST" && pathname === "/api/wallet/primary") {
    return json({ ok: false, error: "No wallet is configured." }, 400);
  }

  if (method === "GET" && pathname === "/api/browser-workspace") {
    return json(browserWorkspaceSnapshot());
  }

  if (method === "GET" && pathname === "/api/browser-workspace/tabs") {
    return json({ tabs: readBrowserWorkspaceStore().tabs });
  }

  if (method === "POST" && pathname === "/api/browser-workspace/tabs") {
    return openBrowserWorkspaceTab(request);
  }

  if (pathname.startsWith("/api/browser-workspace/tabs/")) {
    const response = await handleBrowserWorkspaceTabRoute(request, pathname);
    if (response) return response;
  }

  if (method === "GET" && pathname === "/api/stream/settings") {
    return json({ settings: {} });
  }

  if (method === "HEAD" && pathname.startsWith("/api/avatar/")) {
    return new Response(null, { status: 404 });
  }

  if (method === "GET" && pathname === "/api/agent/events") {
    return json({ events: [] });
  }

  if (method === "GET" && pathname === "/api/workbench/overview") {
    return json({
      tasks: [],
      triggers: [],
      todos: [],
      autonomy: { enabled: false, thinking: false, lastEventAt: null },
    });
  }

  if (
    method === "GET" &&
    (pathname === "/api/apps" || pathname === "/api/catalog/apps")
  ) {
    return json([]);
  }

  if (method === "GET" && pathname === "/api/plugins") {
    return json({ plugins: [] });
  }

  if (method === "GET" && pathname === "/api/skills") {
    return json({ skills: [] });
  }

  if (method === "GET" && pathname === "/api/local-inference/hub") {
    return json(await hubSnapshot());
  }

  if (method === "GET" && pathname === "/api/local-inference/hardware") {
    return json(await hardwareProbe());
  }

  if (method === "GET" && pathname === "/api/local-inference/catalog") {
    return json({ models: MODEL_CATALOG });
  }

  if (method === "GET" && pathname === "/api/local-inference/installed") {
    return json({ models: await listInstalledModels() });
  }

  if (method === "GET" && pathname === "/api/local-inference/downloads") {
    return json({ downloads: [...downloads.values()] });
  }

  if (
    method === "GET" &&
    pathname === "/api/local-inference/downloads/stream"
  ) {
    return textEventStream([
      {
        type: "snapshot",
        downloads: [...downloads.values()],
        active: activeState,
      },
    ]);
  }

  if (method === "POST" && pathname === "/api/local-inference/downloads") {
    const body = await requestJson(request);
    const modelId =
      typeof body.modelId === "string"
        ? body.modelId
        : typeof body.spec === "object" &&
            body.spec &&
            !Array.isArray(body.spec) &&
            typeof (body.spec as { id?: unknown }).id === "string"
          ? (body.spec as { id: string }).id
          : "";
    const catalog = findCatalogModel(modelId);
    if (!catalog) return json({ error: `Unknown model id: ${modelId}` }, 404);
    return json({ job: startDownload(catalog) });
  }

  const downloadMatch = pathname.match(
    /^\/api\/local-inference\/downloads\/([^/]+)$/,
  );
  if (downloadMatch) {
    const modelId = decodeURIComponent(downloadMatch[1]);
    const job = downloads.get(modelId);
    if (method === "GET") {
      return job ? json({ job }) : json({ error: "Download not found" }, 404);
    }
    if (method === "DELETE") {
      if (job && ["queued", "downloading"].includes(job.state)) {
        updateDownload(job, { state: "cancelled", etaMs: 0 });
      }
      return json({ ok: true, job: downloads.get(modelId) ?? null });
    }
  }

  if (method === "GET" && pathname === "/api/local-inference/active") {
    return json(activeState);
  }

  if (method === "POST" && pathname === "/api/local-inference/active") {
    const body = await requestJson(request);
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
    if (!modelId) return json({ error: "modelId is required" }, 400);
    return json(await activateModel(modelId));
  }

  if (method === "DELETE" && pathname === "/api/local-inference/active") {
    writeActiveModelState({ modelId: null, loadedAt: null, status: "idle" });
    return json(activeState);
  }

  if (method === "GET" && pathname === "/api/local-inference/assignments") {
    return json({ assignments: readAssignments() });
  }

  if (method === "POST" && pathname === "/api/local-inference/assignments") {
    const body = await requestJson(request);
    const slot = typeof body.slot === "string" ? body.slot : "";
    const modelId = typeof body.modelId === "string" ? body.modelId : null;
    if (!isAgentModelSlot(slot)) {
      return json({ error: "slot is required" }, 400);
    }
    const assignments = { ...readAssignments(), [slot]: modelId };
    if (modelId === null) delete assignments[slot];
    writeAssignments(assignments);
    return json({ assignments });
  }

  if (method === "GET" && pathname === "/api/local-inference/providers") {
    return json({ providers: [await capacitorLlamaProviderStatus()] });
  }

  if (method === "GET" && pathname === "/api/local-inference/routing") {
    return json({
      registrations: [],
      preferences: EMPTY_ROUTING_PREFERENCES,
    });
  }

  if (
    method === "POST" &&
    (pathname === "/api/local-inference/routing/preferred" ||
      pathname === "/api/local-inference/routing/policy")
  ) {
    return json({
      preferences: EMPTY_ROUTING_PREFERENCES,
    });
  }

  if (method === "GET" && pathname === "/api/local-inference/device") {
    return json({
      enabled: true,
      connected: true,
      devices: [
        {
          id: "ios-local",
          label: "This iPhone",
          platform: "ios",
          connectedAt: startedAt,
          lastSeenAt: Date.now(),
        },
      ],
    });
  }

  const installedMatch = pathname.match(
    /^\/api\/local-inference\/installed\/([^/]+)(?:\/verify)?$/,
  );
  if (installedMatch) {
    const id = decodeURIComponent(installedMatch[1]);
    const installed = await listInstalledModels();
    const model = installed.find((entry) => entry.id === id);
    if (!model) return json({ error: "Model not found" }, 404);
    if (method === "GET") return json({ model });
    if (method === "DELETE") {
      return json(
        { ok: false, error: "Uninstall is not supported on iOS yet." },
        400,
      );
    }
    if (method === "POST" && pathname.endsWith("/verify")) {
      return json({ ok: true, model, errors: [] });
    }
  }

  if (method === "GET" && pathname === "/api/conversations") {
    const store = readStore();
    return json({
      conversations: store.conversations
        .map(conversationDto)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    });
  }

  if (method === "POST" && pathname === "/api/conversations") {
    const body = await requestJson(request);
    const conversation = createConversation(
      typeof body.title === "string" ? body.title : undefined,
    );
    const store = readStore();
    store.conversations.unshift(conversation);
    writeStore(store);
    return json({ conversation: conversationDto(conversation) });
  }

  const greetingMatch = pathname.match(
    /^\/api\/conversations\/([^/]+)\/greeting$/,
  );
  if (greetingMatch && method === "POST") {
    return json({
      text: "I'm running locally on this device.",
      agentName: AGENT_NAME,
      generated: true,
      persisted: false,
    });
  }

  const messageMatch = pathname.match(
    /^\/api\/conversations\/([^/]+)\/messages(?:\/stream|\/truncate)?$/,
  );
  if (messageMatch) {
    const conversationId = decodeURIComponent(messageMatch[1]);
    const store = readStore();
    const conversation = store.conversations.find(
      (entry) => entry.id === conversationId,
    );
    if (!conversation) return json({ error: "Conversation not found" }, 404);

    if (method === "GET" && pathname.endsWith("/messages")) {
      return json({ messages: conversation.messages });
    }

    if (method === "POST" && pathname.endsWith("/messages/truncate")) {
      const body = await requestJson(request);
      const messageId =
        typeof body.messageId === "string" ? body.messageId : null;
      if (!messageId) return json({ error: "messageId is required" }, 400);
      const index = conversation.messages.findIndex((m) => m.id === messageId);
      if (index < 0) return json({ ok: true, deletedCount: 0 });
      const inclusive = body.inclusive === true;
      const deleteFrom = inclusive ? index : index + 1;
      const deletedCount = conversation.messages.length - deleteFrom;
      conversation.messages.splice(deleteFrom);
      conversation.updatedAt = nowIso();
      writeStore(store);
      return json({ ok: true, deletedCount });
    }

    if (method === "POST") {
      const body = await requestJson(request);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return json({ error: "text is required" }, 400);
      const userMessage: LocalMessage = {
        id: randomId("msg"),
        role: "user",
        text,
        timestamp: Date.now(),
      };
      conversation.messages.push(userMessage);
      if (conversation.title === "New chat") {
        conversation.title = text.slice(0, 60) || conversation.title;
      }
      const reply = await generateLocalReply(conversation, text);
      const assistantMessage: LocalMessage = {
        id: randomId("msg"),
        role: "assistant",
        text: reply.text,
        timestamp: Date.now(),
      };
      conversation.messages.push(assistantMessage);
      conversation.updatedAt = nowIso();
      writeStore(store);

      if (pathname.endsWith("/stream")) {
        return textEventStream([
          { type: "token", text: reply.text, fullText: reply.text },
          {
            type: "done",
            fullText: reply.text,
            agentName: AGENT_NAME,
            usage: reply.usage,
          },
        ]);
      }

      return json({
        text: reply.text,
        agentName: AGENT_NAME,
        blocks: [{ type: "text", text: reply.text }],
      });
    }
  }

  const conversationMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (conversationMatch) {
    const conversationId = decodeURIComponent(conversationMatch[1]);
    const store = readStore();
    const index = store.conversations.findIndex(
      (entry) => entry.id === conversationId,
    );
    if (index < 0) return json({ error: "Conversation not found" }, 404);
    if (method === "DELETE") {
      store.conversations.splice(index, 1);
      writeStore(store);
      return json({ ok: true });
    }
    if (method === "PATCH") {
      const body = await requestJson(request);
      if (typeof body.title === "string" && body.title.trim()) {
        store.conversations[index].title = body.title.trim();
      }
      store.conversations[index].updatedAt = nowIso();
      writeStore(store);
      return json({
        conversation: conversationDto(store.conversations[index]),
      });
    }
  }

  return json({ error: "Not found" }, 404);
}
