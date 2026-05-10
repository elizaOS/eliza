import { asRecord } from "@elizaos/shared";
import { getBootConfig } from "../config/boot-config-store";
import {
  findCatalogModel,
  MODEL_CATALOG,
} from "../services/local-inference/catalog";
import type { ProviderStatus } from "../services/local-inference/providers";
import {
  assessCatalogModelFit,
  catalogDownloadSizeGb,
  chooseSmallerFallbackModel,
  selectRecommendedModelForSlot,
} from "../services/local-inference/recommendation";
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
const WALLET_MARKET_OVERVIEW_KEY = `${STORAGE_PREFIX}:wallet-market-overview:v1`;
const AGENT_NAME = "Eliza";
const DEFAULT_SYSTEM_PROMPT =
  "You are Eliza, a private on-device assistant. Answer directly and concisely.";
const DEFAULT_CLOUD_MARKET_PREVIEW_BASE_URL = "https://www.elizacloud.ai";
const CLOUD_WALLET_MARKET_OVERVIEW_PATH = "/market/preview/wallet-overview";
const WALLET_MARKET_OVERVIEW_CACHE_TTL_MS = 120_000;
const WALLET_MARKET_OVERVIEW_FETCH_TIMEOUT_MS = 8_000;
const COINGECKO_MARKET_LIMIT = 80;
const MARKET_PRICE_IDS = ["bitcoin", "ethereum", "solana"] as const;
const MARKET_PRICE_ID_SET = new Set<string>(MARKET_PRICE_IDS);
const STABLE_ASSET_IDS = new Set([
  "tether",
  "usd-coin",
  "binance-usd",
  "first-digital-usd",
  "dai",
  "ethena-usde",
  "true-usd",
  "usds",
]);
const STABLE_ASSET_SYMBOLS = new Set([
  "usdt",
  "usdc",
  "busd",
  "fdusd",
  "dai",
  "usde",
  "tusd",
  "usds",
]);
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
  localInference?: LocalReply["localInference"];
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

interface CachedWalletMarketOverview {
  response: Record<string, unknown>;
  expiresAt: number;
}

interface CoinGeckoMarketRecord {
  id: string;
  symbol: string;
  name: string;
  currentPriceUsd: number;
  change24hPct: number;
  marketCapRank: number | null;
  imageUrl: string | null;
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
    deviceModel?: string;
    machineId?: string;
    osVersion?: string;
    isSimulator?: boolean;
    totalRamGb?: number;
    availableRamGb?: number | null;
    freeStorageGb?: number | null;
    cpuCores?: number;
    gpu?: {
      backend?: "metal" | "vulkan" | "gpu-delegate";
      available?: boolean;
    } | null;
    gpuSupported?: boolean;
    lowPowerMode?: boolean;
    thermalState?: "nominal" | "fair" | "serious" | "critical" | "unknown";
    dflashSupported?: boolean;
    dflashReason?: string;
    source?: "native" | "adapter-fallback";
  }>;
  isLoaded?: () => Promise<{ loaded: boolean; modelPath: string | null }>;
  currentModelPath?: () => string | null;
  load?: (options: {
    modelPath: string;
    contextSize?: number;
    useGpu?: boolean;
    maxThreads?: number;
    draftModelPath?: string;
    draftContextSize?: number;
    draftMin?: number;
    draftMax?: number;
    speculativeSamples?: number;
    mobileSpeculative?: boolean;
    cacheTypeK?: string;
    cacheTypeV?: string;
    disableThinking?: boolean;
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

type CapacitorLlamaLoadOptions = Parameters<
  NonNullable<CapacitorLlamaAdapter["load"]>
>[0];

type LlamaCppModule = {
  downloadModel?: (
    url: string,
    filename: string,
  ) => Promise<string | { path?: string }>;
  getDownloadProgress?: (url: string) => Promise<{
    downloaded?: number;
    received?: number;
    total?: number;
    percentage?: number;
    bytesPerSec?: number;
    etaMs?: number | null;
    error?: string;
  }>;
  cancelDownload?: (url: string) => Promise<boolean>;
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
let loadedRuntimeSignature: string | null = null;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function removeStorageItem(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    /* localStorage unavailable */
  }
}

function resetIosLocalAgentState(): void {
  for (const key of [
    CONVERSATIONS_KEY,
    ACTIVE_MODEL_KEY,
    ASSIGNMENTS_KEY,
    BROWSER_WORKSPACE_KEY,
    WALLET_MARKET_OVERVIEW_KEY,
  ]) {
    removeStorageItem(key);
  }
  downloads.clear();
  activeState = readActiveModelState();
  loadedRuntimeSignature = null;
  running = true;
  startedAt = Date.now();
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

function stringFromUnknown(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerFromUnknown(value: unknown): number | null {
  const parsed = numberFromUnknown(value);
  if (parsed === null) return null;
  return Number.isInteger(parsed) ? parsed : Math.round(parsed);
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
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) ? value : `https://${value}`;
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

async function openBrowserWorkspaceTab(request: Request): Promise<Response> {
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

function isWalletMarketOverviewSource(value: unknown): boolean {
  const record = asRecord(value);
  return (
    record !== null &&
    typeof record.providerId === "string" &&
    typeof record.providerName === "string" &&
    typeof record.providerUrl === "string" &&
    typeof record.available === "boolean" &&
    typeof record.stale === "boolean" &&
    (record.error === null ||
      record.error === undefined ||
      typeof record.error === "string")
  );
}

function isWalletMarketOverview(
  value: unknown,
): value is Record<string, unknown> {
  const record = asRecord(value);
  const sources = asRecord(record?.sources);
  return (
    record !== null &&
    typeof record.generatedAt === "string" &&
    typeof record.cacheTtlSeconds === "number" &&
    typeof record.stale === "boolean" &&
    sources !== null &&
    isWalletMarketOverviewSource(sources.prices) &&
    isWalletMarketOverviewSource(sources.movers) &&
    isWalletMarketOverviewSource(sources.predictions) &&
    Array.isArray(record.prices) &&
    Array.isArray(record.movers) &&
    Array.isArray(record.predictions)
  );
}

function readCachedWalletMarketOverview(): CachedWalletMarketOverview | null {
  const parsed = readJson<CachedWalletMarketOverview | null>(
    WALLET_MARKET_OVERVIEW_KEY,
    null,
  );
  if (
    !parsed ||
    typeof parsed.expiresAt !== "number" ||
    !isWalletMarketOverview(parsed.response)
  ) {
    return null;
  }
  return parsed;
}

function writeCachedWalletMarketOverview(
  response: Record<string, unknown>,
): void {
  const cacheTtlSeconds =
    typeof response.cacheTtlSeconds === "number" && response.cacheTtlSeconds > 0
      ? response.cacheTtlSeconds
      : Math.floor(WALLET_MARKET_OVERVIEW_CACHE_TTL_MS / 1000);
  writeJson(WALLET_MARKET_OVERVIEW_KEY, {
    response,
    expiresAt: Date.now() + cacheTtlSeconds * 1000,
  } satisfies CachedWalletMarketOverview);
}

function staleWalletMarketOverview(
  response: Record<string, unknown>,
): Record<string, unknown> {
  const sources = asRecord(response.sources) ?? {};
  const markStale = (value: unknown) => {
    const source = asRecord(value);
    return source ? { ...source, stale: true } : value;
  };
  return {
    ...response,
    stale: true,
    sources: {
      prices: markStale(sources.prices),
      movers: markStale(sources.movers),
      predictions: markStale(sources.predictions),
    },
  };
}

function normalizeCloudMarketPreviewBaseUrl(rawBaseUrl: string): string {
  try {
    const parsed = new URL(rawBaseUrl);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    if (!parsed.pathname || parsed.pathname === "/") {
      parsed.pathname = "/api/v1";
    } else if (!parsed.pathname.endsWith("/api/v1")) {
      parsed.pathname = `${parsed.pathname}/api/v1`;
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return `${DEFAULT_CLOUD_MARKET_PREVIEW_BASE_URL}/api/v1`;
  }
}

function resolveCloudWalletMarketOverviewUrl(): string {
  const rawBase = getBootConfig().cloudApiBase;
  const cloudApiBase: string =
    typeof rawBase === "string"
      ? rawBase
      : DEFAULT_CLOUD_MARKET_PREVIEW_BASE_URL;
  return `${normalizeCloudMarketPreviewBaseUrl(cloudApiBase)}${CLOUD_WALLET_MARKET_OVERVIEW_PATH}`;
}

async function fetchJsonWithTimeout(url: string | URL): Promise<unknown> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => {
    controller.abort();
  }, WALLET_MARKET_OVERVIEW_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Market feed responded ${response.status}`);
    }
    return response.json();
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function mapCoinGeckoMarket(input: unknown): CoinGeckoMarketRecord | null {
  const record = asRecord(input);
  if (!record) return null;

  const id = stringFromUnknown(record.id);
  const symbol = stringFromUnknown(record.symbol);
  const name = stringFromUnknown(record.name);
  const currentPriceUsd = numberFromUnknown(record.current_price);
  const change24hPct = numberFromUnknown(record.price_change_percentage_24h);
  if (
    !id ||
    !symbol ||
    !name ||
    currentPriceUsd === null ||
    change24hPct === null
  ) {
    return null;
  }

  return {
    id,
    symbol: symbol.toUpperCase(),
    name,
    currentPriceUsd,
    change24hPct,
    marketCapRank: integerFromUnknown(record.market_cap_rank),
    imageUrl: stringFromUnknown(record.image),
  };
}

function isStableAsset(market: CoinGeckoMarketRecord): boolean {
  const id = market.id.toLowerCase();
  const symbol = market.symbol.toLowerCase();
  return STABLE_ASSET_IDS.has(id) || STABLE_ASSET_SYMBOLS.has(symbol);
}

function buildLocalPriceSnapshots(markets: CoinGeckoMarketRecord[]): unknown[] {
  const byId = new Map(markets.map((market) => [market.id, market]));
  return MARKET_PRICE_IDS.reduce<unknown[]>((items, id) => {
    const market = byId.get(id);
    if (!market) return items;
    items.push({
      id: market.id,
      symbol: market.symbol,
      name: market.name,
      priceUsd: market.currentPriceUsd,
      change24hPct: market.change24hPct,
      imageUrl: market.imageUrl,
    });
    return items;
  }, []);
}

function buildLocalMovers(markets: CoinGeckoMarketRecord[]): unknown[] {
  return markets
    .filter((market) => !MARKET_PRICE_ID_SET.has(market.id))
    .filter((market) => !isStableAsset(market))
    .filter(
      (market) => market.marketCapRank === null || market.marketCapRank <= 200,
    )
    .sort(
      (left, right) =>
        Math.abs(right.change24hPct) - Math.abs(left.change24hPct),
    )
    .slice(0, 6)
    .map((market) => ({
      id: market.id,
      symbol: market.symbol,
      name: market.name,
      priceUsd: market.currentPriceUsd,
      change24hPct: market.change24hPct,
      marketCapRank: market.marketCapRank,
      imageUrl: market.imageUrl,
    }));
}

async function fetchCoinGeckoWalletMarketOverview(): Promise<
  Record<string, unknown>
> {
  const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("order", "market_cap_desc");
  url.searchParams.set("per_page", String(COINGECKO_MARKET_LIMIT));
  url.searchParams.set("page", "1");
  url.searchParams.set("price_change_percentage", "24h");

  const payload = await fetchJsonWithTimeout(url);
  if (!Array.isArray(payload)) {
    throw new Error("CoinGecko payload was not an array");
  }

  const markets = payload
    .map(mapCoinGeckoMarket)
    .filter((market): market is CoinGeckoMarketRecord => market !== null);

  const coinGeckoSource = {
    providerId: "coingecko",
    providerName: "CoinGecko",
    providerUrl: "https://www.coingecko.com/",
    available: true,
    stale: false,
    error: null,
  };

  return {
    generatedAt: nowIso(),
    cacheTtlSeconds: Math.floor(WALLET_MARKET_OVERVIEW_CACHE_TTL_MS / 1000),
    stale: false,
    sources: {
      prices: coinGeckoSource,
      movers: coinGeckoSource,
      predictions: {
        providerId: "polymarket",
        providerName: "Polymarket",
        providerUrl: "https://polymarket.com/",
        available: false,
        stale: false,
        error: "Polymarket preview requires the Eliza Cloud market feed.",
      },
    },
    prices: buildLocalPriceSnapshots(markets),
    movers: buildLocalMovers(markets),
    predictions: [],
  };
}

let walletMarketOverviewInFlight: Promise<Record<string, unknown>> | null =
  null;

async function refreshWalletMarketOverview(): Promise<Record<string, unknown>> {
  if (!walletMarketOverviewInFlight) {
    walletMarketOverviewInFlight = (async () => {
      const cloudPayload = await fetchJsonWithTimeout(
        resolveCloudWalletMarketOverviewUrl(),
      ).catch(() => fetchCoinGeckoWalletMarketOverview());
      if (!isWalletMarketOverview(cloudPayload)) {
        throw new Error("Wallet market feed returned an invalid response");
      }
      writeCachedWalletMarketOverview(cloudPayload);
      return cloudPayload;
    })().finally(() => {
      walletMarketOverviewInFlight = null;
    });
  }
  return walletMarketOverviewInFlight;
}

function emptyWalletMarketOverview(
  error = "Market data is unavailable in local iOS mode.",
): Record<string, unknown> {
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
    error,
  });

  return {
    generatedAt: nowIso(),
    cacheTtlSeconds: 0,
    stale: false,
    sources: {
      prices: unavailable(
        "coingecko",
        "CoinGecko",
        "https://www.coingecko.com",
      ),
      movers: unavailable(
        "coingecko",
        "CoinGecko",
        "https://www.coingecko.com",
      ),
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

async function localWalletMarketOverview(): Promise<Record<string, unknown>> {
  if (typeof window === "undefined") {
    return emptyWalletMarketOverview();
  }

  const cached = readCachedWalletMarketOverview();
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return cached.response;
    }
    void refreshWalletMarketOverview();
    return staleWalletMarketOverview(cached.response);
  }

  try {
    return await refreshWalletMarketOverview();
  } catch (error) {
    return emptyWalletMarketOverview(
      error instanceof Error ? error.message : "Market data is unavailable.",
    );
  }
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
  const filenameCandidates = [model.name, model.path?.split(/[\\/]/).pop()]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
  const fileMatch = MODEL_CATALOG.find((candidate) => {
    const file = candidate.ggufFile.split("/").pop()?.toLowerCase() ?? "";
    return file.length > 0 && filenameCandidates.includes(file);
  });
  if (fileMatch) return fileMatch;

  return [...MODEL_CATALOG]
    .sort((a, b) => b.id.length - a.id.length)
    .find((candidate) => haystack.includes(candidate.id.toLowerCase()));
}

function mobileRecommendedBucket(
  totalRamGb: number,
): HardwareProbe["recommendedBucket"] {
  if (totalRamGb >= 32) return "xl";
  if (totalRamGb >= 16) return "large";
  if (totalRamGb >= 12) return "mid";
  return "small";
}

function positiveFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function fallbackMobileTotalRamGb(platform: "ios" | "android"): number {
  const browserMemory =
    typeof navigator === "undefined"
      ? null
      : positiveFiniteNumber(
          (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
        );
  if (browserMemory) return browserMemory;
  return platform === "ios" ? 8 : 4;
}

function normalizeMobilePlatform(
  platform: "ios" | "android" | "web" | undefined,
): "ios" | "android" {
  return platform === "android" ? "android" : "ios";
}

function gpuBackendForMobile(
  platform: "ios" | "android",
  backend?: "metal" | "vulkan" | "gpu-delegate",
): "metal" | "vulkan" {
  if (backend === "vulkan") return "vulkan";
  return platform === "android" ? "vulkan" : "metal";
}

function mobileContextSize(
  hardware: HardwareProbe,
  catalog: CatalogModel | undefined,
): number {
  const target = catalog?.runtime?.dflash?.contextSize ?? 4096;
  if (hardware.totalRamGb >= 12) return Math.min(target, 8192);
  if (hardware.totalRamGb >= 8) return Math.min(target, 6144);
  return Math.min(target, 4096);
}

function mobileThreadCount(hardware: HardwareProbe): number {
  if (!Number.isFinite(hardware.cpuCores) || hardware.cpuCores <= 0) return 0;
  return Math.max(2, Math.min(Math.floor(hardware.cpuCores) - 1, 6));
}

function companionInstalled(
  installed: InstalledModel[],
  modelId: string,
): InstalledModel | undefined {
  return installed.find((entry) => entry.id === modelId);
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
        ...(catalog?.runtimeRole ? { runtimeRole: catalog.runtimeRole } : {}),
        ...(catalog?.companionForModelId
          ? { companionFor: catalog.companionForModelId }
          : {}),
      };
    });
}

async function hardwareProbe(): Promise<HardwareProbe> {
  const llama = await loadCapacitorLlama();
  const hardware = await llama?.getHardwareInfo?.().catch(() => null);
  const cpuCores = hardware?.cpuCores ?? navigator.hardwareConcurrency ?? 0;
  const platform = normalizeMobilePlatform(hardware?.platform);
  const totalRamGb =
    positiveFiniteNumber(hardware?.totalRamGb) ??
    fallbackMobileTotalRamGb(platform);
  const availableRamGb =
    positiveFiniteNumber(hardware?.availableRamGb) ?? totalRamGb;
  const gpu =
    hardware?.gpu?.available && hardware.gpuSupported !== false
      ? {
          backend: gpuBackendForMobile(platform, hardware.gpu.backend),
          totalVramGb: 0,
          freeVramGb: 0,
        }
      : null;
  return {
    totalRamGb,
    freeRamGb: availableRamGb,
    gpu,
    cpuCores,
    platform: platform as NodeJS.Platform,
    arch: "arm64" as NodeJS.Architecture,
    appleSilicon: true,
    recommendedBucket: mobileRecommendedBucket(totalRamGb),
    source: "os-fallback",
    mobile: {
      platform,
      ...(hardware?.deviceModel ? { deviceModel: hardware.deviceModel } : {}),
      ...(hardware?.machineId ? { machineId: hardware.machineId } : {}),
      ...(hardware?.osVersion ? { osVersion: hardware.osVersion } : {}),
      ...(typeof hardware?.isSimulator === "boolean"
        ? { isSimulator: hardware.isSimulator }
        : {}),
      availableRamGb,
      ...(typeof hardware?.freeStorageGb === "number"
        ? { freeStorageGb: hardware.freeStorageGb }
        : {}),
      ...(typeof hardware?.lowPowerMode === "boolean"
        ? { lowPowerMode: hardware.lowPowerMode }
        : {}),
      ...(hardware?.thermalState
        ? { thermalState: hardware.thermalState }
        : {}),
      gpuSupported: hardware?.gpuSupported ?? Boolean(gpu),
      dflashSupported: hardware?.dflashSupported ?? false,
      dflashReason:
        hardware?.dflashReason ??
        "native runtime has not reported DFlash drafter support",
      source: hardware?.source ?? "adapter-fallback",
    },
  };
}

function buildMobileLoadOptions(
  model: InstalledModel,
  installed: InstalledModel[],
  hardware: HardwareProbe,
): CapacitorLlamaLoadOptions {
  const catalog = findCatalogModel(model.id);
  const options: CapacitorLlamaLoadOptions = {
    modelPath: model.path,
    contextSize: mobileContextSize(hardware, catalog),
    useGpu: hardware.mobile?.gpuSupported !== false,
    maxThreads: mobileThreadCount(hardware),
  };
  const dflash = catalog?.runtime?.dflash;
  if (!dflash) return options;
  if (hardware.mobile?.dflashSupported !== true) return options;

  const drafter = companionInstalled(installed, dflash.drafterModelId);
  if (!drafter) return options;

  return {
    ...options,
    draftModelPath: drafter.path,
    draftContextSize: dflash.draftContextSize,
    draftMin: dflash.draftMin,
    draftMax: dflash.draftMax,
    speculativeSamples: Math.min(dflash.draftMax, 4),
    mobileSpeculative: true,
    cacheTypeK: catalog.runtime?.kvCache?.typeK,
    cacheTypeV: catalog.runtime?.kvCache?.typeV,
    disableThinking: dflash.disableThinking,
  };
}

function runtimeSignature(options: CapacitorLlamaLoadOptions): string {
  return [
    options.modelPath,
    options.contextSize ?? "",
    options.draftModelPath ?? "",
    options.draftContextSize ?? "",
    options.speculativeSamples ?? "",
    options.cacheTypeK ?? "",
    options.cacheTypeV ?? "",
  ].join("|");
}

async function validateMobileModelFit(
  model: CatalogModel,
): Promise<string | null> {
  if (model.runtimeRole === "dflash-drafter") return null;
  const hardware = await hardwareProbe();
  const fit = assessCatalogModelFit(hardware, model, MODEL_CATALOG);
  if (fit === "wontfit") {
    return `${model.displayName} is above this device's local inference minspec. Switch to a smaller model.`;
  }
  const freeStorageGb = hardware.mobile?.freeStorageGb;
  if (typeof freeStorageGb === "number" && freeStorageGb > 0) {
    const requiredGb = catalogDownloadSizeGb(model, MODEL_CATALOG);
    if (requiredGb > freeStorageGb * 0.9) {
      return `Not enough free storage for ${model.displayName}: needs about ${requiredGb.toFixed(
        1,
      )} GB including companions, ${freeStorageGb.toFixed(1)} GB available.`;
    }
  }
  return null;
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
  const hardware = await hardwareProbe();
  const loadOptions = buildMobileLoadOptions(model, installed, hardware);
  const signature = runtimeSignature(loadOptions);
  const loaded = await llama.isLoaded?.().catch(() => null);
  if (
    loaded?.loaded &&
    loaded.modelPath === model.path &&
    loadedRuntimeSignature === signature
  ) {
    return;
  }
  await llama.load(loadOptions);
  loadedRuntimeSignature = signature;
}

type LocalReply = {
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    model?: string;
  };
  localInference?: {
    intent?:
      | "retry"
      | "resume"
      | "redownload"
      | "download"
      | "cancel"
      | "switch_smaller"
      | "status";
    status:
      | "missing"
      | "downloading"
      | "loading"
      | "failed"
      | "no_space"
      | "idle"
      | "ready"
      | "cancelled";
    modelId?: string | null;
    activeModelId?: string | null;
    error?: string;
    progress?: {
      percent?: number;
      receivedBytes: number;
      totalBytes: number;
      bytesPerSec?: number;
      etaMs?: number | null;
    };
  };
};

function emptyUsage(modelId?: string | null): LocalReply["usage"] {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    ...(modelId ? { model: modelId } : {}),
  };
}

async function localModelStatusReply(text: string): Promise<LocalReply | null> {
  const intent = classifyLocalModelIntent(text);
  if (activeState.status === "ready" && intent !== "status") return null;

  const hardware = await hardwareProbe();
  const activeCatalog = activeState.modelId
    ? findCatalogModel(activeState.modelId)
    : null;
  let model =
    activeCatalog ??
    selectRecommendedModelForSlot("TEXT_LARGE", hardware, MODEL_CATALOG).model;
  if (!model) {
    return {
      text: "I could not find a local model that fits this device.",
      usage: emptyUsage(activeState.modelId),
      localInference: {
        intent: intent ?? "status",
        status: "failed",
        activeModelId: activeState.modelId,
        error: "No fitting local model in catalog",
      },
    };
  }

  if (intent === "switch_smaller") {
    const smaller = chooseSmallerFallbackModel(
      model.id,
      hardware,
      "TEXT_LARGE",
      MODEL_CATALOG,
    );
    if (smaller) model = smaller;
    const validationError = await validateMobileModelFit(model);
    if (validationError) {
      return {
        text: validationError,
        usage: emptyUsage(model.id),
        localInference: {
          intent,
          status: validationError.toLowerCase().includes("storage")
            ? "no_space"
            : "failed",
          modelId: model.id,
          activeModelId: activeState.modelId,
          error: validationError,
        },
      };
    }
    startDownload(model);
  } else if (
    intent === "download" ||
    intent === "redownload" ||
    activeState.status === "idle" ||
    !activeState.modelId
  ) {
    const validationError = await validateMobileModelFit(model);
    if (validationError) {
      const smaller = chooseSmallerFallbackModel(
        model.id,
        hardware,
        "TEXT_LARGE",
        MODEL_CATALOG,
      );
      if (smaller) {
        model = smaller;
      } else {
        return {
          text: validationError,
          usage: emptyUsage(model.id),
          localInference: {
            intent: intent ?? "download",
            status: validationError.toLowerCase().includes("storage")
              ? "no_space"
              : "failed",
            modelId: model.id,
            activeModelId: activeState.modelId,
            error: validationError,
          },
        };
      }
    }
    startDownload(model);
  } else if (intent === "cancel") {
    for (const job of aggregateDownloadJobs(model)) {
      if (["queued", "downloading"].includes(job.state)) {
        updateDownload(job, { state: "cancelled", etaMs: 0 });
      }
    }
  }

  const jobs = aggregateDownloadJobs(model);
  const progress = aggregateProgress(jobs);
  if (activeState.status === "ready") {
    return {
      text: `Local inference is ready on ${model.displayName}.`,
      usage: emptyUsage(model.id),
      localInference: {
        intent: "status",
        status: "ready",
        modelId: model.id,
        activeModelId: activeState.modelId,
      },
    };
  }
  const state =
    activeState.status === "loading"
      ? "loading"
      : progress.state === "failed"
        ? progress.error?.toLowerCase().includes("space")
          ? "no_space"
          : "failed"
        : progress.state === "cancelled"
          ? "cancelled"
          : progress.state === "completed"
            ? "loading"
            : progress.state === "missing"
              ? "missing"
              : "downloading";
  return {
    text: statusLine(model, jobs),
    usage: emptyUsage(model.id),
    localInference: {
      intent: intent ?? "status",
      status: state,
      modelId: model.id,
      activeModelId: activeState.modelId,
      ...(progress.error ? { error: progress.error } : {}),
      progress: {
        ...(progress.percent !== null ? { percent: progress.percent } : {}),
        receivedBytes: progress.received,
        totalBytes:
          progress.total ||
          Math.round(catalogDownloadSizeGb(model, MODEL_CATALOG) * 1024 ** 3),
        bytesPerSec: progress.bytesPerSec,
        etaMs: progress.etaMs,
      },
    },
  };
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
): Promise<LocalReply> {
  const statusReply = await localModelStatusReply(text);
  if (statusReply) return statusReply;
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

async function generateLocalGreeting(): Promise<LocalReply> {
  const setupReply = await localModelStatusReply(
    "download the default local model",
  );
  if (setupReply && setupReply.localInference?.status !== "ready") {
    return setupReply;
  }
  return {
    text: "What would you like to work on?",
    usage: emptyUsage(activeState.modelId),
    ...(setupReply?.localInference
      ? { localInference: setupReply.localInference }
      : {}),
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}

function aggregateDownloadJobs(model: CatalogModel): DownloadJob[] {
  const ids = [model.id, ...(model.companionModelIds ?? [])];
  return ids.flatMap((id) => {
    const job = downloads.get(id);
    return job ? [job] : [];
  });
}

function aggregateProgress(jobs: DownloadJob[]): {
  received: number;
  total: number;
  percent: number | null;
  bytesPerSec: number;
  etaMs: number | null;
  state: DownloadJob["state"] | "missing";
  error?: string;
} {
  if (jobs.length === 0) {
    return {
      received: 0,
      total: 0,
      percent: null,
      bytesPerSec: 0,
      etaMs: null,
      state: "missing",
    };
  }
  const received = jobs.reduce(
    (sum, job) => sum + Math.max(0, job.received),
    0,
  );
  const total = jobs.reduce((sum, job) => sum + Math.max(0, job.total), 0);
  const bytesPerSec = jobs.reduce(
    (sum, job) => sum + Math.max(0, job.bytesPerSec),
    0,
  );
  const failed = jobs.find((job) => job.state === "failed");
  const cancelled = jobs.find((job) => job.state === "cancelled");
  const active = jobs.find((job) =>
    ["queued", "downloading"].includes(job.state),
  );
  const allCompleted = jobs.every((job) => job.state === "completed");
  const etaMs =
    total > received && bytesPerSec > 0
      ? Math.round(((total - received) / bytesPerSec) * 1000)
      : null;
  return {
    received,
    total,
    percent:
      total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null,
    bytesPerSec,
    etaMs,
    state: failed
      ? "failed"
      : cancelled
        ? "cancelled"
        : active
          ? active.state
          : allCompleted
            ? "completed"
            : "missing",
    ...(failed?.error ? { error: failed.error } : {}),
  };
}

function classifyLocalModelIntent(
  text: string,
): "redownload" | "download" | "cancel" | "switch_smaller" | "status" | null {
  const normalized = text.toLowerCase();
  if (/\b(cancel|stop|pause|abort)\b/.test(normalized)) return "cancel";
  if (
    /\b(redownload|re-download|download again|fresh copy|retry download)\b/.test(
      normalized,
    )
  ) {
    return "redownload";
  }
  if (
    /\b(smaller|lighter|tiny|low memory|less memory|save space|not enough space)\b/.test(
      normalized,
    )
  ) {
    return "switch_smaller";
  }
  if (/\b(download|install|fetch|pull|resume|retry)\b/.test(normalized))
    return "download";
  if (
    /\b(status|progress|percent|percentage|eta|what.*happen|how.*long)\b/.test(
      normalized,
    )
  ) {
    return "status";
  }
  return null;
}

function statusLine(
  model: CatalogModel,
  jobs: DownloadJob[],
  detail?: string,
): string {
  const progress = aggregateProgress(jobs);
  const templates = [
    () =>
      `I'm still downloading ${model.displayName}: ${progress.percent ?? 0}% (${formatGb(
        progress.received,
      )}/${formatGb(progress.total || Math.round(catalogDownloadSizeGb(model, MODEL_CATALOG) * 1024 ** 3))}). Please hold on.`,
    () =>
      `${model.displayName} is still downloading: ${progress.percent ?? 0}% complete, ${formatGb(
        progress.received,
      )} of ${formatGb(progress.total || Math.round(catalogDownloadSizeGb(model, MODEL_CATALOG) * 1024 ** 3))}.`,
    () =>
      `Local inference is still downloading. ${model.displayName} is at ${
        progress.percent ?? 0
      }% (${formatGb(progress.received)}/${formatGb(
        progress.total ||
          Math.round(catalogDownloadSizeGb(model, MODEL_CATALOG) * 1024 ** 3),
      )}).`,
  ];
  if (progress.state === "failed") {
    return `The ${model.displayName} download failed${progress.error ? `: ${progress.error}` : "."}`;
  }
  if (progress.state === "cancelled") {
    return `The ${model.displayName} download is cancelled.`;
  }
  if (detail) return detail;
  const index = Math.abs(Math.floor(Date.now() / 10_000)) % templates.length;
  return templates[index]();
}

async function queueCompanionDownloads(model: CatalogModel): Promise<void> {
  if (!model.companionModelIds?.length) return;
  const installed = await listInstalledModels().catch(() => []);
  for (const companionId of model.companionModelIds) {
    const companion = findCatalogModel(companionId);
    if (!companion) continue;
    if (installed.some((entry) => entry.id === companionId)) continue;
    const existing = downloads.get(companionId);
    if (
      existing &&
      existing.state !== "failed" &&
      existing.state !== "cancelled"
    ) {
      continue;
    }
    startDownload(companion);
  }
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
      if (model.runtimeRole !== "dflash-drafter") {
        void queueCompanionDownloads(model);
      }
      updateDownload(job, { state: "downloading" });
      const llama = await loadLlamaCpp();
      if (!llama?.downloadModel) {
        throw new Error("llama-cpp-capacitor downloadModel is unavailable.");
      }
      const downloadUrl = buildHuggingFaceResolveUrl(model);
      let polling = true;
      void (async () => {
        while (polling && ["queued", "downloading"].includes(job.state)) {
          try {
            const progress = await llama.getDownloadProgress?.(downloadUrl);
            if (progress) {
              const received =
                typeof progress.downloaded === "number"
                  ? progress.downloaded
                  : typeof progress.received === "number"
                    ? progress.received
                    : job.received;
              const total =
                typeof progress.total === "number" && progress.total > 0
                  ? progress.total
                  : job.total;
              const bytesPerSec =
                typeof progress.bytesPerSec === "number"
                  ? progress.bytesPerSec
                  : job.bytesPerSec;
              updateDownload(job, {
                received,
                total,
                bytesPerSec,
                etaMs:
                  typeof progress.etaMs === "number" || progress.etaMs === null
                    ? progress.etaMs
                    : total > received && bytesPerSec > 0
                      ? Math.round(((total - received) / bytesPerSec) * 1000)
                      : job.etaMs,
                ...(progress.error ? { error: progress.error } : {}),
              });
            }
          } catch {
            // The native progress endpoint is best-effort; the download promise
            // remains the source of truth for completion or failure.
          }
          await sleep(1000);
        }
      })();
      let result: string | { path?: string };
      try {
        result = await llama.downloadModel(downloadUrl, modelFilename(model));
      } finally {
        polling = false;
      }
      const path =
        typeof result === "string"
          ? result
          : (result.path ?? modelFilename(model));
      updateDownload(job, {
        state: "completed",
        received: job.total,
        etaMs: 0,
      });
      if (model.runtimeRole === "dflash-drafter") {
        if (
          model.companionForModelId &&
          activeState.modelId === model.companionForModelId
        ) {
          await activateModel(model.companionForModelId).catch(() => undefined);
        }
        return;
      }
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
  const catalog = findCatalogModel(modelId);
  if (catalog?.runtimeRole === "dflash-drafter") {
    const state: ActiveModelState = {
      modelId,
      loadedAt: null,
      status: "error",
      error: `${catalog.displayName} is a DFlash drafter companion, not a standalone chat model.`,
    };
    writeActiveModelState(state);
    return state;
  }
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
          ...(catalog?.runtimeRole ? { runtimeRole: catalog.runtimeRole } : {}),
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
    const hardware = await hardwareProbe();
    if (catalog) {
      const fit = assessCatalogModelFit(hardware, catalog, MODEL_CATALOG);
      if (fit === "wontfit") {
        throw new Error(
          `${catalog.displayName} is above this device's local inference minspec. Switch to a smaller model.`,
        );
      }
    }
    const loadOptions = buildMobileLoadOptions(model, installed, hardware);
    await llama.load(loadOptions);
    loadedRuntimeSignature = runtimeSignature(loadOptions);
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
      model: activeState.status === "ready" ? activeState.modelId : null,
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

  if (method === "POST" && pathname === "/api/agent/reset") {
    resetIosLocalAgentState();
    return json({ ok: true });
  }

  if (method === "POST" && pathname === "/api/agent/restart") {
    running = true;
    startedAt = Date.now();
    return json({
      status: {
        state: "running",
        agentName: AGENT_NAME,
        model: activeState.status === "ready" ? activeState.modelId : null,
        startedAt,
        uptime: 0,
        cloud: {
          connectionStatus: "disconnected",
          activeAgentId: null,
          cloudProvisioned: false,
          hasApiKey: false,
        },
        pendingRestart: false,
        pendingRestartReasons: [],
      },
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
    return json(await localWalletMarketOverview());
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
    const validationError = await validateMobileModelFit(catalog);
    if (validationError) return json({ error: validationError }, 409);
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
        const catalog = findCatalogModel(modelId);
        if (catalog) {
          const llama = await loadLlamaCpp();
          await llama
            ?.cancelDownload?.(buildHuggingFaceResolveUrl(catalog))
            .catch(() => false);
        }
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
    loadedRuntimeSignature = null;
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
    const greeting = await generateLocalGreeting();
    return json({
      text: greeting.text,
      agentName: AGENT_NAME,
      generated: true,
      persisted: false,
      ...(greeting.localInference
        ? { localInference: greeting.localInference }
        : {}),
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
        ...(reply.localInference
          ? { localInference: reply.localInference }
          : {}),
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
            ...(reply.localInference
              ? { localInference: reply.localInference }
              : {}),
          },
        ]);
      }

      return json({
        text: reply.text,
        agentName: AGENT_NAME,
        blocks: [{ type: "text", text: reply.text }],
        ...(reply.localInference
          ? { localInference: reply.localInference }
          : {}),
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
