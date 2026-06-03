import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { WebSocketServer } from "ws";

const port = Number(process.env.ELIZA_UI_SMOKE_API_PORT || "31337");
const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
const SMOKE_GENERATED_AT = "2026-01-01T00:00:00.000Z";
let browserWorkspaceCounter = 0;
let browserWorkspaceTabs = [];
let lifeOpsAppEnabled = true;
let conversationCounter = 0;
let messageCounter = 0;
const stubConversations = [];
const stubConversationMessages = new Map();
const unhandledApiRequests = [];
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

// A minimal valid 16-bit PCM mono WAV of silence. The onboarding voice path
// POSTs /api/tts/first-run/speak and plays the returned bytes as audio/wav, so
// the stub must return decodable audio (not a 501) to avoid a console.error.
function buildSilentWav() {
  const sampleRate = 8000;
  const dataBytes = 1600; // ~0.1s of silence
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audioFormat = PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byteRate (mono, 16-bit)
  header.writeUInt16LE(2, 32); // blockAlign
  header.writeUInt16LE(16, 34); // bitsPerSample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

const SILENT_WAV = buildSilentWav();
function readSmokeVrm() {
  const candidates = [
    new URL(
      "../../../plugins/plugin-companion/public/vrms/eliza-1.vrm.gz",
      import.meta.url,
    ),
    new URL(
      "../../../plugins/plugin-companion/public_src/vrms/eliza-1.vrm",
      import.meta.url,
    ),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const body = readFileSync(candidate);
    return candidate.pathname.endsWith(".gz") ? gunzipSync(body) : body;
  }

  return Buffer.alloc(4);
}

const SMOKE_VRM = readSmokeVrm();

const smokeViewDeclarations = [
  ["companion", "Companion", "plugin-companion", "/companion", "CompanionView"],
  [
    "companion",
    "Companion TUI",
    "plugin-companion",
    "/companion/tui",
    "CompanionTuiView",
    "tui",
  ],
  ["contacts", "Contacts", "plugin-contacts", "/contacts", "ContactsAppView"],
  [
    "contacts",
    "Contacts TUI",
    "plugin-contacts",
    "/contacts/tui",
    "ContactsTuiView",
    "tui",
  ],
  [
    "hyperliquid",
    "Hyperliquid",
    "plugin-hyperliquid-app",
    "/hyperliquid",
    "HyperliquidAppView",
  ],
  [
    "hyperliquid",
    "Hyperliquid TUI",
    "plugin-hyperliquid-app",
    "/hyperliquid/tui",
    "HyperliquidTuiView",
    "tui",
  ],
  ["lifeops", "LifeOps", "plugin-lifeops", "/lifeops", "LifeOpsPageView"],
  [
    "lifeops",
    "LifeOps TUI",
    "plugin-lifeops",
    "/lifeops/tui",
    "LifeOpsTuiView",
    "tui",
  ],
  [
    "messages",
    "Messages",
    "plugin-messages",
    "/messages",
    "MessagesPluginView",
  ],
  [
    "messages",
    "Messages TUI",
    "plugin-messages",
    "/messages/tui",
    "MessagesTuiView",
    "tui",
  ],
  [
    "model-tester",
    "Model Tester",
    "app-model-tester",
    "/model-tester",
    "ModelTesterAppView",
  ],
  [
    "model-tester",
    "Model Tester TUI",
    "app-model-tester",
    "/model-tester/tui",
    "ModelTesterTuiView",
    "tui",
  ],
  ["phone", "Phone", "plugin-phone", "/phone", "PhonePluginView"],
  ["phone", "Phone TUI", "plugin-phone", "/phone/tui", "PhoneTuiView", "tui"],
  [
    "polymarket",
    "Polymarket",
    "plugin-polymarket-app",
    "/polymarket",
    "PolymarketAppView",
  ],
  [
    "polymarket",
    "Polymarket TUI",
    "plugin-polymarket-app",
    "/polymarket/tui",
    "PolymarketTuiView",
    "tui",
  ],
  ["shopify", "Shopify", "plugin-shopify-ui", "/shopify", "ShopifyAppView"],
  [
    "shopify",
    "Shopify TUI",
    "plugin-shopify-ui",
    "/shopify/tui",
    "ShopifyTuiView",
    "tui",
  ],
  ["steward", "Steward", "plugin-steward-app", "/steward", "StewardView"],
  [
    "steward",
    "Steward TUI",
    "plugin-steward-app",
    "/steward/tui",
    "StewardTuiView",
    "tui",
  ],
  ["vincent", "Vincent", "plugin-vincent", "/vincent", "VincentAppView"],
  [
    "vincent",
    "Vincent TUI",
    "plugin-vincent",
    "/vincent/tui",
    "VincentTuiView",
    "tui",
  ],
  ["wallet", "Wallet", "plugin-wallet-ui", "/wallet", "InventoryView"],
  [
    "wallet",
    "Wallet TUI",
    "plugin-wallet-ui",
    "/wallet/tui",
    "InventoryTuiView",
    "tui",
  ],
  [
    "2004scape",
    "2004Scape",
    "plugin-2004scape",
    "/2004scape",
    "TwoThousandFourScapeOperatorSurface",
  ],
  [
    "2004scape",
    "2004Scape TUI",
    "plugin-2004scape",
    "/2004scape/tui",
    "TwoThousandFourScapeTuiView",
    "tui",
  ],
  ["feed", "Feed", "plugin-feed", "/feed", "FeedOperatorSurface"],
  ["feed", "Feed TUI", "plugin-feed", "/feed/tui", "FeedTuiView", "tui"],
  ["views-manager", "Views", "plugin-app-control", "/views", "ViewManagerView"],
  [
    "views-manager",
    "Views TUI",
    "plugin-app-control",
    "/views/tui",
    "ViewManagerTuiView",
    "tui",
  ],
  [
    "clawville",
    "Clawville",
    "plugin-clawville",
    "/clawville",
    "ClawvilleOperatorSurface",
  ],
  [
    "clawville",
    "Clawville TUI",
    "plugin-clawville",
    "/clawville/tui",
    "ClawvilleTuiView",
    "tui",
  ],
  [
    "defense-of-the-agents",
    "Defense of the Agents",
    "plugin-defense-of-the-agents",
    "/defense-of-the-agents",
    "DefenseAgentsOperatorSurface",
  ],
  [
    "defense-of-the-agents",
    "Defense of the Agents TUI",
    "plugin-defense-of-the-agents",
    "/defense-of-the-agents/tui",
    "DefenseAgentsTuiView",
    "tui",
  ],
  [
    "hyperscape",
    "Hyperscape",
    "plugin-hyperscape",
    "/hyperscape",
    "HyperscapeOperatorSurface",
  ],
  [
    "hyperscape",
    "Hyperscape TUI",
    "plugin-hyperscape",
    "/hyperscape/tui",
    "HyperscapeTuiView",
    "tui",
  ],
  ["scape", "Scape", "plugin-scape", "/scape", "ScapeOperatorSurface"],
  ["scape", "Scape TUI", "plugin-scape", "/scape/tui", "ScapeTuiView", "tui"],
  [
    "screenshare",
    "Screenshare",
    "plugin-screenshare",
    "/screenshare",
    "ScreenshareOperatorSurface",
  ],
  [
    "screenshare",
    "Screenshare TUI",
    "plugin-screenshare",
    "/screenshare/tui",
    "ScreenshareTuiView",
    "tui",
  ],
  [
    "task-coordinator",
    "Task Coordinator",
    "plugin-task-coordinator",
    "/task-coordinator",
    "CodingAgentTasksPanel",
  ],
  [
    "task-coordinator",
    "Task Coordinator TUI",
    "plugin-task-coordinator",
    "/task-coordinator/tui",
    "TaskCoordinatorTuiView",
    "tui",
  ],
  [
    "trajectory-logger",
    "Trajectory Logger",
    "plugin-trajectory-logger",
    "/trajectory-logger",
    "TrajectoryLoggerView",
  ],
  [
    "trajectory-logger",
    "Trajectory Logger TUI",
    "plugin-trajectory-logger",
    "/trajectory-logger/tui",
    "TrajectoryLoggerTuiView",
    "tui",
  ],
  ["training", "Fine Tuning", "plugin-training", "/training", "FineTuningView"],
  [
    "training",
    "Fine Tuning TUI",
    "plugin-training",
    "/training/tui",
    "FineTuningTuiView",
    "tui",
  ],
];

const smokeViews = smokeViewDeclarations.map(
  ([id, label, pluginDirName, viewPath, componentExport, viewType = "gui"]) => {
    const encodedId = encodeURIComponent(id);
    const query =
      viewType === "tui" ? "?viewType=tui&v=ui-smoke" : "?v=ui-smoke";
    const bundlePath = path.join(
      repoRoot,
      "plugins",
      pluginDirName,
      "dist",
      "views",
      "bundle.js",
    );
    return {
      id,
      label,
      viewType,
      pluginName: `@elizaos/${pluginDirName}`,
      path: viewPath,
      order: 100,
      bundlePath: "dist/views/bundle.js",
      bundleUrl: `/api/views/${encodedId}/bundle.js${query}`,
      componentExport,
      available: true,
      realBundleAvailable: existsSync(bundlePath),
      visibleInManager: true,
      capabilities: [
        {
          id: "get-state",
          label: "Get state",
          inputSchema: { type: "object" },
        },
      ],
      _smokePluginDirName: pluginDirName,
    };
  },
);

const stubPlugins = [
  {
    id: "openai",
    name: "OpenAI",
    description:
      "Integrates OpenAI's GPT models for automated text generation with customizable prompts.",
    tags: ["ai-provider"],
    enabled: false,
    configured: false,
    envKey: "OPENAI_API_KEY",
    category: "ai-provider",
    source: "bundled",
    parameters: [],
    validationErrors: [],
    validationWarnings: [],
    isActive: false,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description:
      "Anthropic model provider for Claude chat and reasoning models.",
    tags: ["ai-provider"],
    enabled: false,
    configured: false,
    envKey: "ANTHROPIC_API_KEY",
    category: "ai-provider",
    source: "bundled",
    parameters: [],
    validationErrors: [],
    validationWarnings: [],
    isActive: false,
  },
  {
    id: "plugin-browser",
    name: "Browser Workspace",
    description: "Agent-controlled browser workspace.",
    tags: ["feature"],
    enabled: true,
    configured: true,
    envKey: null,
    category: "feature",
    source: "bundled",
    parameters: [],
    validationErrors: [],
    validationWarnings: [],
    isActive: true,
  },
];

function stubCatalogApp({
  name,
  displayName,
  description,
  category = "utility",
  capabilities = [],
  heroImage = null,
}) {
  return {
    name,
    displayName,
    description,
    category,
    launchType: "local",
    launchUrl: null,
    icon: null,
    heroImage,
    capabilities,
    stars: 0,
    repository: "",
    latestVersion: null,
    supports: { v0: false, v1: false, v2: true },
    npm: {
      package: name,
      v0Version: null,
      v1Version: null,
      v2Version: null,
    },
  };
}

const stubCatalogApps = [
  stubCatalogApp({
    name: "@elizaos/plugin-lifeops",
    displayName: "LifeOps",
    description:
      "Run tasks, reminders, calendar, inbox, and connected workflows.",
    capabilities: ["lifeops", "tasks", "calendar", "gmail"],
    heroImage: "/app-heroes/lifeops.png",
  }),
  stubCatalogApp({
    name: "@elizaos/app-plugin-viewer",
    displayName: "Plugin Viewer",
    description:
      "Inspect installed plugins, connectors, and runtime feature flags.",
    capabilities: ["plugins", "connectors", "viewer"],
    heroImage: "/app-heroes/plugin-viewer.png",
  }),
  stubCatalogApp({
    name: "@elizaos/app-skills-viewer",
    displayName: "Skills Viewer",
    description: "Create, enable, review, and install custom agent skills.",
    capabilities: ["skills", "viewer"],
    heroImage: "/app-heroes/skills-viewer.png",
  }),
  stubCatalogApp({
    name: "@elizaos/plugin-training",
    displayName: "Fine Tuning",
    description:
      "Build datasets, inspect trajectories, and activate tuned models.",
    capabilities: ["training", "fine-tuning", "datasets", "models"],
  }),
  stubCatalogApp({
    name: "@elizaos/app-trajectory-viewer",
    displayName: "Trajectory Viewer",
    description: "Inspect LLM call history, prompts, and execution traces.",
    capabilities: ["trajectories", "debug", "viewer"],
    heroImage: "/app-heroes/trajectory-viewer.png",
  }),
  stubCatalogApp({
    name: "@elizaos/app-relationship-viewer",
    displayName: "Relationship Viewer",
    description: "Explore people, identities, and relationship graphs.",
    capabilities: ["relationships", "graph", "viewer"],
    heroImage: "/app-heroes/relationship-viewer.png",
  }),
  stubCatalogApp({
    name: "@elizaos/app-memory-viewer",
    displayName: "Memory Viewer",
    description: "Browse memory, fact, and extraction activity.",
    capabilities: ["memory", "facts", "viewer"],
    heroImage: "/app-heroes/memory-viewer.png",
  }),
  stubCatalogApp({
    name: "@elizaos/app-runtime-debugger",
    displayName: "Runtime Debugger",
    description:
      "Inspect runtime objects, plugin order, providers, and services.",
    capabilities: ["runtime", "debug", "viewer"],
    heroImage: "/app-heroes/runtime-debugger.png",
  }),
  stubCatalogApp({
    name: "@elizaos/app-database-viewer",
    displayName: "Database Viewer",
    description: "Inspect tables, media, vectors, and ad-hoc SQL.",
    capabilities: ["database", "sql", "viewer"],
    heroImage: "/app-heroes/database-viewer.png",
  }),
  stubCatalogApp({
    name: "@elizaos/app-log-viewer",
    displayName: "Log Viewer",
    description: "Search runtime and service logs.",
    capabilities: ["logs", "debug", "viewer"],
    heroImage: "/app-heroes/log-viewer.png",
  }),
  stubCatalogApp({
    name: "@elizaos/plugin-companion",
    displayName: "Companion",
    description: "The companion overlay shell for ambient agent presence.",
    category: "social",
  }),
  stubCatalogApp({
    name: "@elizaos/plugin-steward-app",
    displayName: "Steward",
    description: "Review wallet approvals and inventory status.",
    capabilities: ["wallet", "approvals", "inventory"],
  }),
  stubCatalogApp({
    name: "@elizaos/plugin-elizamaker",
    displayName: "ElizaMaker",
    description: "Run drop, mint, whitelist, and verification workflows.",
    capabilities: ["drops", "minting", "whitelist"],
  }),
  stubCatalogApp({
    name: "@elizaos/plugin-shopify-ui",
    displayName: "Shopify",
    description: "Manage Shopify store operations from the agent workspace.",
    category: "platform",
  }),
  stubCatalogApp({
    name: "@elizaos/plugin-vincent",
    displayName: "Vincent",
    description: "Manage Vincent DeFi account access and trading context.",
    category: "platform",
  }),
  stubCatalogApp({
    name: "@elizaos/plugin-hyperliquid-app",
    displayName: "Hyperliquid",
    description: "Inspect Hyperliquid markets, positions, and order status.",
    category: "platform",
    capabilities: ["hyperliquid", "trading", "wallet"],
  }),
  stubCatalogApp({
    name: "@elizaos/plugin-polymarket-app",
    displayName: "Polymarket",
    description: "Browse prediction markets and native trading readiness.",
    category: "platform",
    capabilities: ["polymarket", "prediction-markets", "wallet"],
  }),
];

let smokeFavoriteApps = [];

const stubMemoryStats = {
  total: 0,
  byType: {},
};

const stubRelationshipsPeopleResponse = {
  data: [],
  stats: {
    totalPeople: 0,
    totalEntities: 0,
    totalEdges: 0,
  },
};

const stubRelationshipsGraphResponse = {
  data: {
    people: [],
    relationships: [],
    stats: {
      totalPeople: 0,
      totalRelationships: 0,
      totalIdentities: 0,
    },
    candidateMerges: [],
  },
};

const stubAuthIdentity = {
  id: "owner-1",
  displayName: "Owner",
  kind: "owner",
};

const stubAuthSession = {
  id: "local-session",
  kind: "local",
  expiresAt: null,
};

const stubAuthAccess = {
  mode: "local",
  passwordConfigured: false,
  ownerConfigured: true,
};

const stubLogsResponse = {
  entries: [
    {
      timestamp: Date.now(),
      level: "info",
      message: "smoke API ready",
      source: "smoke",
      tags: ["smoke"],
    },
  ],
  sources: ["smoke"],
  tags: ["smoke"],
};

const stubMemoryFeedResponse = {
  memories: [],
  hasMore: false,
};

const stubMemoryBrowseResponse = {
  memories: [],
  total: 0,
  limit: 50,
  offset: 0,
};

const emptyComputerUseApprovalSnapshot = {
  mode: "full_control",
  pendingCount: 0,
  pendingApprovals: [],
};

const emptySkillsResponse = {
  skills: [],
};

const emptyLocalInferenceActive = {
  modelId: null,
  loadedAt: null,
  status: "idle",
};

const emptyLocalInferenceHardware = {
  totalRamGb: 16,
  freeRamGb: 8,
  gpu: null,
  cpuCores: 8,
  platform: process.platform,
  arch: process.arch,
  appleSilicon: process.platform === "darwin" && process.arch === "arm64",
  recommendedBucket: "small",
  source: "os-fallback",
};

const emptyLocalInferenceHub = {
  catalog: [],
  installed: [],
  active: emptyLocalInferenceActive,
  downloads: [],
  hardware: emptyLocalInferenceHardware,
};

const emptyWalletConfig = {
  evmAddress: null,
  solanaAddress: null,
  selectedRpcProviders: {
    evm: "eliza-cloud",
    bsc: "eliza-cloud",
    solana: "eliza-cloud",
  },
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
  evmChains: [],
  walletSource: "none",
  pluginEvmLoaded: false,
  pluginEvmRequired: false,
  executionReady: false,
  executionBlockedReason: null,
  evmSigningCapability: "none",
  solanaSigningAvailable: false,
  wallets: [],
  primary: {
    evm: "local",
    solana: "local",
  },
};

const emptyWalletBalances = {
  evm: null,
  solana: null,
};

const emptyWalletNfts = {
  evm: [],
  solana: null,
};

const emptyWalletTradingProfile = {
  window: "30d",
  source: "all",
  generatedAt: new Date(0).toISOString(),
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

const emptyWalletMarketSource = {
  providerId: "coingecko",
  providerName: "CoinGecko",
  providerUrl: "https://www.coingecko.com",
  available: false,
  stale: false,
  error: null,
};

const emptyWalletMarketOverview = {
  generatedAt: new Date(0).toISOString(),
  cacheTtlSeconds: 300,
  stale: false,
  sources: {
    prices: emptyWalletMarketSource,
    movers: emptyWalletMarketSource,
    predictions: {
      providerId: "polymarket",
      providerName: "Polymarket",
      providerUrl: "https://polymarket.com",
      available: false,
      stale: false,
      error: null,
    },
  },
  prices: [],
  movers: [],
  predictions: [],
};

const stubHyperliquidStatus = {
  publicReadReady: true,
  signerReady: false,
  executionReady: false,
  executionBlockedReason:
    "Signed Hyperliquid exchange mutations are disabled in UI smoke.",
  accountAddress: null,
  apiBaseUrl: "https://api.hyperliquid.xyz",
  credentialMode: "none",
  readiness: {
    publicReads: true,
    accountReads: false,
    signer: false,
    execution: false,
  },
  account: {
    address: null,
    source: "none",
    guidance:
      "Connect a managed vault or configure an account address for account reads.",
  },
  vault: {
    configured: false,
    ready: false,
    address: null,
    guidance: "Public market reads do not require a vault.",
  },
  apiWallet: {
    configured: false,
    guidance: "API-wallet delegation is optional.",
  },
};

const stubHyperliquidMarkets = {
  markets: [
    {
      name: "BTC",
      index: 0,
      szDecimals: 5,
      maxLeverage: 50,
      onlyIsolated: false,
      isDelisted: false,
    },
    {
      name: "ETH",
      index: 1,
      szDecimals: 4,
      maxLeverage: 50,
      onlyIsolated: false,
      isDelisted: false,
    },
  ],
  source: "hyperliquid-info-meta",
  fetchedAt: "2026-01-01T00:00:00.000Z",
};

const stubPolymarketStatus = {
  publicReads: {
    ready: true,
    reason: null,
    gammaApiBase: "https://gamma-api.polymarket.com",
    dataApiBase: "https://data-api.polymarket.com",
  },
  trading: {
    ready: false,
    credentialsReady: false,
    missing: [
      "POLYMARKET_PRIVATE_KEY",
      "CLOB_API_KEY",
      "CLOB_API_SECRET",
      "CLOB_API_PASSPHRASE",
    ],
    reason: "Trading is disabled in UI smoke.",
    clobApiBase: "https://clob.polymarket.com",
  },
};

const stubPolymarketMarket = {
  id: "ui-smoke-market",
  slug: "ui-smoke-market",
  question: "Will the UI smoke suite stay green?",
  description: "Deterministic fixture market for app-window QA.",
  category: "QA",
  active: true,
  closed: false,
  archived: false,
  restricted: false,
  enableOrderBook: true,
  conditionId: "0xsmoke",
  clobTokenIds: ["yes-token", "no-token"],
  outcomes: [
    { name: "Yes", price: "0.72" },
    { name: "No", price: "0.28" },
  ],
  liquidity: "10000",
  volume: "42000",
  volume24hr: "1200",
  lastTradePrice: "0.72",
  bestBid: "0.71",
  bestAsk: "0.73",
  image: null,
  icon: null,
  endDate: null,
  startDate: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const smokeGeneratedAt = "2026-01-01T00:00:00.000Z";

const emptyLifeOpsOverviewSummary = {
  activeGoalCount: 0,
  activeOccurrenceCount: 0,
  activeReminderCount: 0,
  overdueOccurrenceCount: 0,
  snoozedOccurrenceCount: 0,
};

const emptyLifeOpsOverviewSection = {
  occurrences: [],
  goals: [],
  reminders: [],
  summary: emptyLifeOpsOverviewSummary,
};

const emptyLifeOpsOverview = {
  occurrences: [],
  goals: [],
  reminders: [],
  summary: emptyLifeOpsOverviewSummary,
  owner: emptyLifeOpsOverviewSection,
  agentOps: emptyLifeOpsOverviewSection,
  schedule: null,
};

const emptyLifeOpsCapabilities = {
  generatedAt: smokeGeneratedAt,
  appEnabled: true,
  relativeTime: null,
  capabilities: [],
  summary: {
    totalCount: 0,
    workingCount: 0,
    degradedCount: 0,
    blockedCount: 0,
    notConfiguredCount: 0,
  },
};

const emptyLifeOpsCalendarFeed = {
  calendarId: "primary",
  events: [],
  source: "cache",
  timeMin: smokeGeneratedAt,
  timeMax: smokeGeneratedAt,
  syncedAt: null,
};

const emptyLifeOpsInbox = {
  messages: [],
  channelCounts: {},
  fetchedAt: smokeGeneratedAt,
  threadGroups: [],
};

const emptyLifeOpsScreenTimeSummary = {
  items: [],
  totalSeconds: 0,
};

const emptyLifeOpsScreenTimeBreakdown = {
  items: [],
  totalSeconds: 0,
  bySource: [],
  byCategory: [],
  byDevice: [],
  byService: [],
  byBrowser: [],
  fetchedAt: smokeGeneratedAt,
};

const emptyLifeOpsSocialSummary = {
  since: smokeGeneratedAt,
  until: smokeGeneratedAt,
  totalSeconds: 0,
  services: [],
  devices: [],
  surfaces: [],
  browsers: [],
  sessions: [],
  messages: {
    channels: [],
    inbound: 0,
    outbound: 0,
    opened: 0,
    replied: 0,
  },
  dataSources: [],
  fetchedAt: smokeGeneratedAt,
};

const emptyBrowserBridgeSettings = {
  enabled: true,
  trackingMode: "current_tab",
  allowBrowserControl: false,
  requireConfirmationForAccountAffecting: true,
  incognitoEnabled: false,
  siteAccessMode: "current_site_only",
  grantedOrigins: [],
  blockedOrigins: [],
  maxRememberedTabs: 10,
  pauseUntil: null,
  metadata: {},
  updatedAt: null,
};

const emptyBrowserBridgePackageStatus = {
  extensionPath: null,
  chromeBuildPath: null,
  chromePackagePath: null,
  safariAppPath: null,
  safariPackagePath: null,
  safariWebExtensionPath: null,
  releaseManifest: null,
};

const stubCharacter = {
  name: "Eliza",
  username: "eliza",
  bio: ["A concise local assistant for UI smoke tests."],
  system: "You are Eliza, a concise assistant for UI smoke tests.",
  adjectives: ["focused", "direct"],
  topics: [],
  style: {
    all: [],
    chat: [],
    post: [],
  },
  messageExamples: [],
  postExamples: [],
};

const stubExperiences = [
  {
    id: "stub-exp-vite-env",
    type: "correction",
    outcome: "positive",
    context:
      "A local Vite app kept stale environment variables after .env changed.",
    action: "Restarted the dev server and reran the route check.",
    result: "The updated API base URL appeared after restart.",
    learning:
      "Restart the dev server after changing environment variables so the running process loads new config.",
    tags: ["vite", "env", "restart"],
    keywords: ["vite", "env", "restart", "config"],
    associatedEntityIds: ["stub-user-local", "stub-agent"],
    domain: "coding",
    confidence: 0.91,
    importance: 0.88,
    createdAt: "2026-04-20T12:00:00.000Z",
    updatedAt: "2026-04-21T12:00:00.000Z",
    accessCount: 3,
    embeddingDimensions: 1536,
    sourceMessageIds: ["stub-msg-1", "stub-msg-2", "stub-msg-3"],
    sourceRoomId: "stub-room-local-dev",
    sourceTriggerMessageId: "stub-msg-3",
    extractionMethod: "experience_evaluator",
  },
  {
    id: "stub-exp-test-deps",
    type: "warning",
    outcome: "negative",
    context:
      "A TypeScript test run started before workspace dependencies were ready.",
    action: "Ran tests before installing packages.",
    result: "The test suite failed on missing dependencies.",
    learning:
      "Install workspace dependencies before running app tests or local dev commands.",
    tags: ["setup", "tests"],
    keywords: ["dependencies", "tests", "workspace", "setup"],
    associatedEntityIds: ["stub-user-local"],
    domain: "coding",
    confidence: 0.78,
    importance: 0.76,
    createdAt: "2026-04-22T12:00:00.000Z",
    updatedAt: "2026-04-22T13:00:00.000Z",
    accessCount: 2,
    embeddingDimensions: 1536,
  },
  {
    id: "stub-exp-release-notes",
    type: "success",
    outcome: "positive",
    context: "A release note draft contained too much implementation detail.",
    action: "Grouped changes by user impact first.",
    result: "The summary was accepted without follow-up edits.",
    learning:
      "For release notes, group by user impact before implementation details.",
    tags: ["writing", "release-notes"],
    keywords: ["release", "notes", "impact", "writing"],
    associatedEntityIds: ["stub-user-docs"],
    domain: "writing",
    confidence: 0.86,
    importance: 0.52,
    createdAt: "2026-04-23T12:00:00.000Z",
    updatedAt: "2026-04-23T12:00:00.000Z",
    accessCount: 1,
    embeddingDimensions: 1536,
  },
  {
    id: "stub-exp-graph-ux",
    type: "learning",
    outcome: "neutral",
    context: "The experience graph used text cards inside the map.",
    action: "Reviewed visual density and interaction clarity.",
    result: "The graph felt like a list pasted into a canvas.",
    learning:
      "Use visual encodings in graph views and keep text in the detail panel outside the map.",
    tags: ["graph", "ux"],
    keywords: ["graph", "visual", "detail", "map"],
    associatedEntityIds: ["stub-user-design", "stub-agent"],
    domain: "ux",
    confidence: 0.82,
    importance: 0.9,
    createdAt: "2026-04-24T12:00:00.000Z",
    updatedAt: "2026-04-24T12:00:00.000Z",
    accessCount: 1,
    embeddingDimensions: 1536,
    relatedExperiences: ["stub-exp-search-action"],
  },
  {
    id: "stub-exp-automation-cadence",
    type: "correction",
    outcome: "mixed",
    context:
      "Older automation cadence guidance conflicted with newer direct feedback.",
    action: "Kept the latest explicit preference and linked older records.",
    result: "Future automation suggestions used the corrected cadence.",
    learning:
      "Prefer the latest explicit cadence preference when automation guidance conflicts.",
    tags: ["automation", "preference"],
    keywords: ["automation", "cadence", "preference"],
    associatedEntityIds: ["stub-user-design"],
    domain: "planning",
    confidence: 0.72,
    importance: 0.82,
    createdAt: "2026-04-25T12:00:00.000Z",
    updatedAt: "2026-04-25T12:00:00.000Z",
    accessCount: 1,
    embeddingDimensions: 1536,
    supersedes: "stub-exp-release-notes",
  },
  {
    id: "stub-exp-search-action",
    type: "discovery",
    outcome: "neutral",
    context: "A graph search needed more than top-level context injection.",
    action: "Added a dedicated experience search action with graph data.",
    result: "The agent can retrieve detailed experience results on demand.",
    learning:
      "Expose experience graph search as an action so planning context can stay compact but details remain searchable.",
    tags: ["search", "graph"],
    keywords: ["experience", "graph", "search", "action"],
    associatedEntityIds: ["stub-agent"],
    domain: "coding",
    confidence: 0.84,
    importance: 0.86,
    createdAt: "2026-04-26T12:00:00.000Z",
    updatedAt: "2026-04-26T12:00:00.000Z",
    accessCount: 1,
    embeddingDimensions: 1536,
    relatedExperiences: ["stub-exp-graph-ux"],
  },
];

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createStubConversation({ title = "New chat", metadata = {} } = {}) {
  conversationCounter += 1;
  const createdAt = nowIso();
  const conversation = {
    id: `stub-conversation-${conversationCounter}`,
    title:
      typeof title === "string" && title.trim().length > 0
        ? title.trim()
        : "New chat",
    roomId: `stub-room-${conversationCounter}`,
    metadata:
      metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? metadata
        : {},
    createdAt,
    updatedAt: createdAt,
  };
  stubConversations.unshift(conversation);
  stubConversationMessages.set(conversation.id, []);
  return conversation;
}

function findStubConversation(id) {
  return stubConversations.find((conversation) => conversation.id === id);
}

function createStubMessage(role, text) {
  messageCounter += 1;
  return {
    id: `stub-message-${messageCounter}`,
    role,
    text: typeof text === "string" ? text : "",
    timestamp: Date.now(),
  };
}

function stableTextHash(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function normalizeAssistantInput(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function classifyAssistantAction(text) {
  const normalized = text.toLowerCase();
  if (/\b(wallet|inventory|address|balance)\b/.test(normalized)) {
    return { type: "navigate", target: "/wallet" };
  }
  if (/\b(view|views|app|apps)\b/.test(normalized)) {
    return { type: "navigate", target: "/views" };
  }
  if (/\b(setting|settings|provider|model|voice)\b/.test(normalized)) {
    return { type: "navigate", target: "/settings" };
  }
  if (/\b(chat|conversation|message)\b/.test(normalized)) {
    return { type: "navigate", target: "/chat" };
  }
  return { type: "noop", target: null };
}

function createDeterministicAssistantText({ body, conversationId, transport }) {
  const inputText = normalizeAssistantInput(body?.text ?? body?.message);
  if (/\bbroken[_ -]?llm[_ -]?response\b/i.test(inputText)) {
    return `BROKEN_MOCK_LLM_RESPONSE:${JSON.stringify({
      fixture: "ui-smoke-assistant-v1",
      conversationId,
      transport,
      input: { text: inputText },
      action: classifyAssistantAction(inputText),
    }).slice(0, -2)}`;
  }
  const payload = {
    fixture: "ui-smoke-assistant-v1",
    registrySeam: "strict-fixture-registry",
    conversationId,
    transport,
    input: {
      text: inputText,
      length: inputText.length,
      hash: stableTextHash(inputText),
    },
    action: classifyAssistantAction(inputText),
  };
  return JSON.stringify(payload);
}

function recordUnhandledApiRequest(req, url) {
  const entry = {
    method: req.method ?? "GET",
    path: url.pathname,
    search: url.search,
    at: nowIso(),
  };
  unhandledApiRequests.push(entry);
  if (unhandledApiRequests.length > 50) {
    unhandledApiRequests.shift();
  }
  console.error(
    `[playwright-ui-smoke-api-stub] unhandled API route: ${entry.method} ${entry.path}${entry.search}`,
  );
  return entry;
}

function appendStubMessage(conversationId, message) {
  const messages = stubConversationMessages.get(conversationId) ?? [];
  messages.push(message);
  stubConversationMessages.set(conversationId, messages);
  const conversation = findStubConversation(conversationId);
  if (conversation) conversation.updatedAt = nowIso();
  return message;
}

function cleanupEmptyStubConversations({ keepId } = {}) {
  const deleted = [];
  for (let index = stubConversations.length - 1; index >= 0; index -= 1) {
    const conversation = stubConversations[index];
    if (typeof keepId === "string" && conversation.id === keepId) continue;
    const messages = stubConversationMessages.get(conversation.id) ?? [];
    const hasUserMessage = messages.some((message) => message.role === "user");
    if (hasUserMessage) continue;
    stubConversations.splice(index, 1);
    stubConversationMessages.delete(conversation.id);
    deleted.push(conversation.id);
  }
  return deleted;
}

function buildRuntimeSnapshot(url) {
  const maxDepth = parsePositiveInt(url.searchParams.get("depth"), 10);
  const maxArrayLength = parsePositiveInt(
    url.searchParams.get("maxArrayLength"),
    1000,
  );
  const maxObjectEntries = parsePositiveInt(
    url.searchParams.get("maxObjectEntries"),
    1000,
  );
  const maxStringLength = parsePositiveInt(
    url.searchParams.get("maxStringLength"),
    280,
  );

  return {
    runtimeAvailable: true,
    generatedAt: Date.now(),
    settings: {
      maxDepth,
      maxArrayLength,
      maxObjectEntries,
      maxStringLength,
    },
    meta: {
      agentId: "playwright-ui-smoke-agent",
      agentState: "running",
      agentName: "UI Smoke Runtime",
      model: "stubbed",
      pluginCount: 1,
      actionCount: 1,
      providerCount: 1,
      evaluatorCount: 1,
      serviceTypeCount: 1,
      serviceCount: 1,
    },
    order: {
      plugins: [
        {
          index: 0,
          name: "plugin-browser",
          className: "BrowserWorkspacePlugin",
          id: "plugin-browser",
        },
      ],
      actions: [
        {
          index: 0,
          name: "open_browser_workspace",
          className: "BrowserWorkspaceAction",
          id: "browser-workspace-action",
        },
      ],
      providers: [
        {
          index: 0,
          name: "browser_workspace_provider",
          className: "BrowserWorkspaceProvider",
          id: "browser-workspace-provider",
        },
      ],
      evaluators: [
        {
          index: 0,
          name: "browser_workspace_health",
          className: "BrowserWorkspaceHealthEvaluator",
          id: "browser-workspace-health",
        },
      ],
      services: [
        {
          index: 0,
          serviceType: "browser-workspace",
          count: 1,
          instances: [
            {
              index: 0,
              name: "browser-workspace-service",
              className: "BrowserWorkspaceService",
              id: "browser-workspace-service",
            },
          ],
        },
      ],
    },
    sections: {
      runtime: {
        agent: {
          id: "playwright-ui-smoke-agent",
          name: "UI Smoke Runtime",
          state: "running",
        },
        environment: {
          mode: "stub",
          ci: process.env.CI === "true",
        },
        settings: {
          maxDepth,
          maxArrayLength,
          maxObjectEntries,
          maxStringLength,
        },
      },
      plugins: {
        "plugin-browser": {
          id: "plugin-browser",
          source: "bundled",
          enabled: true,
        },
      },
      actions: {
        open_browser_workspace: {
          enabled: true,
          description: "Stub browser workspace action for UI smoke tests.",
        },
      },
      providers: {
        browser_workspace_provider: {
          enabled: true,
          source: "stub",
        },
      },
      evaluators: {
        browser_workspace_health: {
          enabled: true,
          status: "ok",
        },
      },
      services: {
        "browser-workspace": {
          instances: 1,
          status: "ready",
        },
      },
    },
  };
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeStubBrowserUrl(rawUrl) {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "about:blank") {
    return trimmed;
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
    return new URL(trimmed).toString();
  }
  return new URL(`https://${trimmed}`).toString();
}

function inferStubBrowserTitle(url) {
  if (url === "about:blank") {
    return "New Tab";
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "Browser";
  } catch {
    return "Browser";
  }
}

function browserWorkspaceSnapshot() {
  return {
    mode: "web",
    tabs: browserWorkspaceTabs,
  };
}

function showBrowserWorkspaceTab(tabId) {
  let selected = null;
  browserWorkspaceTabs = browserWorkspaceTabs.map((tab) => {
    const visible = tab.id === tabId;
    const nextTab = {
      ...tab,
      visible,
      updatedAt: nowIso(),
      lastFocusedAt: visible ? nowIso() : tab.lastFocusedAt,
    };
    if (visible) {
      selected = nextTab;
    }
    return nextTab;
  });
  return selected;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin ?? "*");
  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS",
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(req, res, status, payload) {
  applyCors(req, res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function sendEmpty(req, res, status) {
  applyCors(req, res);
  res.statusCode = status;
  res.end();
}

function sendBinary(req, res, status, contentType, body) {
  applyCors(req, res);
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.end(req.method === "HEAD" ? undefined : body);
}

function contentTypeForSmokeViewAsset(assetPath) {
  const ext = path.extname(assetPath).toLowerCase();
  if (ext === ".js" || ext === ".mjs")
    return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".map" || ext === ".json")
    return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function convertNamedImportsToDestructuring(namedImports) {
  return namedImports
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/\s+as\s+/u, ": "))
    .join(", ");
}

function buildHostExternalImportReplacement(importClause, specifier, index) {
  const moduleVar = `__eliza_dynamic_view_host_external_${index}`;
  const lines = [
    `const ${moduleVar} = await globalThis.__ELIZA_DYNAMIC_VIEW_IMPORT__(${JSON.stringify(specifier)});`,
  ];
  const trimmed = importClause.trim();
  if (trimmed.startsWith("* as ")) {
    lines.push(`const ${trimmed.slice("* as ".length).trim()} = ${moduleVar};`);
    return lines.join("\n");
  }
  const namedMatch = trimmed.match(/^\{([\s\S]*)\}$/u);
  if (namedMatch) {
    lines.push(
      `const { ${convertNamedImportsToDestructuring(namedMatch[1])} } = ${moduleVar};`,
    );
    return lines.join("\n");
  }
  const defaultAndNamedMatch = trimmed.match(/^([^,]+),\s*\{([\s\S]*)\}$/u);
  if (defaultAndNamedMatch) {
    lines.push(
      `const ${defaultAndNamedMatch[1].trim()} = ${moduleVar}.default ?? ${moduleVar};`,
    );
    lines.push(
      `const { ${convertNamedImportsToDestructuring(defaultAndNamedMatch[2])} } = ${moduleVar};`,
    );
    return lines.join("\n");
  }
  lines.push(`const ${trimmed} = ${moduleVar}.default ?? ${moduleVar};`);
  return lines.join("\n");
}

function rewriteHostExternalImports(source, specifiers) {
  if (specifiers.length === 0) return source;
  const specifierPattern = specifiers
    .map((item) => item.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  const fromImportPattern = new RegExp(
    `import\\s+([^;]*?)\\s+from\\s+["'](${specifierPattern})["'];?`,
    "gu",
  );
  const sideEffectPattern = new RegExp(
    `import\\s+["'](${specifierPattern})["'];?`,
    "gu",
  );
  let replacementIndex = 0;
  return source
    .replace(fromImportPattern, (_match, importClause, specifier) =>
      buildHostExternalImportReplacement(
        String(importClause),
        String(specifier),
        replacementIndex++,
      ),
    )
    .replace(
      sideEffectPattern,
      (_match, specifier) =>
        `await globalThis.__ELIZA_DYNAMIC_VIEW_IMPORT__(${JSON.stringify(String(specifier))});`,
    );
}

function parseHostExternalSpecifiers(url) {
  if (url.searchParams.get("hostExternalRuntime") !== "1") return [];
  return (url.searchParams.get("hostExternalSpecifiers") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function smokeViewByRequest(id, viewType) {
  return smokeViews.find(
    (view) => view.id === id && view.viewType === (viewType || "gui"),
  );
}

function safeComponentExportName(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : "SmokeView";
}

function smokeTuiViewBundleSource(view, exportName) {
  const label = JSON.stringify(view.label);
  const id = JSON.stringify(view.id);
  const viewType = JSON.stringify(view.viewType);
  const pluginName = JSON.stringify(view.pluginName);
  const commands =
    view.id === "feed"
      ? [
          "refresh-agent-status",
          "send-team-message",
          "refresh-feed",
          "list-agents",
        ]
      : ["status", "refresh", "inspect", "help"];
  return `import React from "react";

const viewMeta = {
  id: ${id},
  label: ${label},
  viewType: ${viewType},
  pluginName: ${pluginName}
};
const commands = ${JSON.stringify(commands)};

function SmokeView() {
  const [outputs, setOutputs] = React.useState([]);
  const runCommand = async (command) => {
    window.dispatchEvent(new CustomEvent("eliza:tui-command", {
      detail: { viewId: viewMeta.id, command }
    }));
    let result;
    try {
      const response = await fetch("/api/views/" + encodeURIComponent(viewMeta.id) + "/interact?viewType=tui", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability: command, timeoutMs: 5000 })
      });
      result = await response.json();
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    setOutputs((current) => [...current, { command, result }]);
  };
  const state = JSON.stringify({
    viewId: viewMeta.id,
    viewType: "tui",
    status: "ready",
    fixture: "ui-smoke",
    commandCount: commands.length
  });
  return React.createElement(
    "div",
    {
      "data-view-state": state,
      style: {
        minHeight: "100vh",
        background: "#020617",
        color: "#cbd5e1",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        padding: 20
      }
    },
    React.createElement("div", { style: { color: "#7dd3fc", marginBottom: 4 } }, "elizaos://" + viewMeta.id + " --type=tui"),
    React.createElement("div", { style: { color: "#94a3b8", marginBottom: 16 } }, viewMeta.label + " smoke terminal"),
    React.createElement(
      "div",
      { style: { display: "flex", flexWrap: "wrap", gap: 8 } },
      ...commands.map((command) =>
        React.createElement(
          "button",
          {
            key: command,
            type: "button",
            "data-terminal-command": command,
            "aria-label": "Run " + command,
            onClick: () => void runCommand(command),
            style: {
              border: "1px solid #38bdf8",
              borderRadius: 4,
              color: "#e0f2fe",
              background: "transparent",
              padding: "6px 10px"
            }
          },
          command
        )
      )
    ),
    ...outputs.map((entry, index) =>
      React.createElement(
        "pre",
        {
          key: entry.command + index,
          "data-terminal-output": entry.result?.ok ? "ok" : "error",
          style: {
            marginTop: 8,
            whiteSpace: "pre-wrap",
            color: entry.result?.ok ? "#bbf7d0" : "#fecaca"
          }
        },
        "$ " + entry.command + "\\n" + JSON.stringify(entry.result, null, 2)
      )
    )
  );
}

export { SmokeView as ${exportName} };
export default SmokeView;
export async function interact(capability, params = {}) {
  return { ok: true, viewId: viewMeta.id, viewType: viewMeta.viewType, capability, params };
}
`;
}

function smokeScreenshareBundleSource(view, exportName) {
  const label = JSON.stringify(view.label);
  const id = JSON.stringify(view.id);
  const viewType = JSON.stringify(view.viewType);
  const pluginName = JSON.stringify(view.pluginName);
  return `import React from "react";

const viewMeta = {
  id: ${id},
  label: ${label},
  viewType: ${viewType},
  pluginName: ${pluginName}
};

function maskSession(value) {
  if (!value) return "";
  return value.slice(0, 6) + "\\u2026" + value.slice(-4);
}

function maskToken(value) {
  if (!value) return "";
  return "\\u2022\\u2022\\u2022\\u2022 " + value.slice(-4);
}

function SmokeView() {
  const [capabilities, setCapabilities] = React.useState(null);
  const [host, setHost] = React.useState(null);
  const [token, setToken] = React.useState("");
  const [viewerUrl, setViewerUrl] = React.useState("");
  const [remoteBase, setRemoteBase] = React.useState("");
  const [remoteSession, setRemoteSession] = React.useState("");
  const [remoteToken, setRemoteToken] = React.useState("");

  const refreshCapabilities = React.useCallback(async () => {
    const response = await fetch("/api/apps/screenshare/capabilities");
    setCapabilities(await response.json());
  }, []);

  React.useEffect(() => {
    void refreshCapabilities();
  }, [refreshCapabilities]);

  const startHost = async () => {
    const response = await fetch("/api/apps/screenshare/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "This machine" })
    });
    const result = await response.json();
    setHost(result.session);
    setToken(result.token);
    setViewerUrl(result.viewerUrl);
  };

  const copyDetails = async () => {
    await navigator.clipboard.writeText(JSON.stringify({
      sessionId: host?.id,
      token
    }));
  };

  const openHostViewer = () => {
    if (viewerUrl) window.open(viewerUrl);
  };

  const openRemote = () => {
    const url = new URL("/api/apps/screenshare/viewer", remoteBase);
    url.searchParams.set("sessionId", remoteSession);
    url.searchParams.set("token", remoteToken);
    url.searchParams.set("remoteBase", remoteBase);
    window.open(url.toString());
  };

  const stopHost = async () => {
    if (!host?.id) return;
    const response = await fetch("/api/apps/screenshare/session/" + encodeURIComponent(host.id) + "/stop", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-screenshare-token": token
      },
      body: JSON.stringify({ token })
    });
    const result = await response.json();
    setHost(result.session);
  };

  const capabilityList = capabilities?.capabilities ?? {};
  return React.createElement(
    "section",
    { "aria-label": viewMeta.label, style: { minHeight: "100vh", padding: 24 } },
    React.createElement("h1", null, viewMeta.label),
    React.createElement("p", null, viewMeta.pluginName + " dynamic view smoke surface is ready."),
    React.createElement("h2", null, "Host"),
    React.createElement("button", { type: "button", onClick: startHost }, "Start host session"),
    host && React.createElement("button", { type: "button", onClick: copyDetails }, "Copy host details"),
    host && React.createElement("button", { type: "button", onClick: openHostViewer }, "Open host viewer"),
    host && React.createElement("button", { type: "button", onClick: stopHost }, "Stop host session"),
    host && React.createElement("div", null,
      React.createElement("input", { placeholder: "Session", readOnly: true, value: maskSession(host.id) }),
      React.createElement("input", { placeholder: "Token", readOnly: true, value: maskToken(token) }),
      React.createElement("span", null, String(host.frameCount ?? 0)),
      React.createElement("span", null, String(host.inputCount ?? 0)),
      React.createElement("span", null, host.status)
    ),
    React.createElement("h2", null, "Capabilities"),
    React.createElement("button", { type: "button", onClick: () => void refreshCapabilities() }, "Refresh capabilities"),
    React.createElement("div", null,
      React.createElement("span", null, "Screenshot"),
      React.createElement("span", null, capabilityList.screenshot?.available ? "Ready" : "Unavailable")
    ),
    React.createElement("div", null,
      React.createElement("span", null, "Keyboard"),
      React.createElement("span", null, capabilityList.keyboard?.available ? "Ready" : "Unavailable")
    ),
    React.createElement("h2", null, "Remote"),
    React.createElement("input", { placeholder: "Server URL", value: remoteBase, onChange: (event) => setRemoteBase(event.target.value) }),
    React.createElement("input", { placeholder: "Session", value: remoteSession, onChange: (event) => setRemoteSession(event.target.value) }),
    React.createElement("input", { placeholder: "Token", value: remoteToken, onChange: (event) => setRemoteToken(event.target.value) }),
    React.createElement("button", { type: "button", onClick: openRemote }, "Connect to remote")
  );
}

export { SmokeView as ${exportName} };
export default SmokeView;
export async function interact(capability, params = {}) {
  return { ok: true, viewId: viewMeta.id, viewType: viewMeta.viewType, capability, params };
}
`;
}

function smokeTaskCoordinatorBundleSource(view, exportName) {
  const label = JSON.stringify(view.label);
  const id = JSON.stringify(view.id);
  const viewType = JSON.stringify(view.viewType);
  const pluginName = JSON.stringify(view.pluginName);
  return `import React from "react";

const viewMeta = {
  id: ${id},
  label: ${label},
  viewType: ${viewType},
  pluginName: ${pluginName}
};

function statusLabel(thread) {
  return String(thread?.status ?? "open").replace(/_/g, " ");
}

function SmokeView() {
  const [tasks, setTasks] = React.useState([]);
  const [detail, setDetail] = React.useState(null);
  const [search, setSearch] = React.useState("");

  const loadTasks = React.useCallback(async (nextSearch = search) => {
    const url = new URL("/api/orchestrator/tasks", window.location.origin);
    url.searchParams.set("limit", "50");
    if (nextSearch) url.searchParams.set("search", nextSearch);
    const response = await fetch(url.pathname + url.search);
    const result = await response.json();
    setTasks(result.tasks ?? []);
  }, [search]);

  React.useEffect(() => {
    void loadTasks("");
  }, []);

  const updateSearch = (value) => {
    setSearch(value);
    void loadTasks(value);
  };

  const openTask = async (task) => {
    const response = await fetch("/api/orchestrator/tasks/" + encodeURIComponent(task.id));
    setDetail(await response.json());
  };

  const archiveTask = async () => {
    if (!detail?.id) return;
    await fetch("/api/orchestrator/tasks/" + encodeURIComponent(detail.id) + "/archive", { method: "POST" });
    await loadTasks(search);
  };

  const reopenTask = async () => {
    if (!detail?.id) return;
    await fetch("/api/orchestrator/tasks/" + encodeURIComponent(detail.id) + "/reopen", { method: "POST" });
    const response = await fetch("/api/orchestrator/tasks/" + encodeURIComponent(detail.id));
    setDetail(await response.json());
    await loadTasks(search);
  };

  return React.createElement(
    "section",
    {
      "aria-label": viewMeta.label,
      "data-testid": "chat-widget-orchestrator",
      style: { minHeight: "100vh", padding: 24 }
    },
    React.createElement("h1", null, viewMeta.label),
    React.createElement("p", null, viewMeta.pluginName + " dynamic view smoke surface is ready."),
    React.createElement("input", {
      placeholder: "Search tasks",
      value: search,
      onChange: (event) => updateSearch(event.target.value)
    }),
    React.createElement(
      "div",
      null,
      ...tasks.map((task) =>
        React.createElement(
          "button",
          {
            key: task.id,
            type: "button",
            onClick: () => void openTask(task),
            style: { display: "block", marginTop: 8 }
          },
          task.title + " " + statusLabel(task)
        )
      )
    ),
    detail && React.createElement(
      "article",
      { "aria-label": "Task detail", style: { marginTop: 16 } },
      React.createElement("h2", null, detail.title),
      React.createElement("p", null, detail.summary ?? detail.originalRequest ?? ""),
      ...(detail.acceptanceCriteria ?? []).map((item) => React.createElement("p", { key: item }, item)),
      ...(detail.sessions ?? []).map((session) =>
        React.createElement(
          "div",
          { key: session.id },
          React.createElement("span", null, session.label),
          React.createElement("span", null, (session.framework ?? "") + " (" + (session.providerSource ?? "") + ")")
        )
      ),
      ...(detail.artifacts ?? []).map((artifact) => React.createElement("p", { key: artifact.id }, artifact.title)),
      ...(detail.pendingDecisions ?? []).map((decision) => React.createElement("p", { key: decision.sessionId }, decision.promptText)),
      ...(detail.events ?? []).map((event) => React.createElement("p", { key: event.id }, event.summary)),
      ...(detail.transcripts ?? []).map((transcript) => React.createElement("p", { key: transcript.id }, transcript.content)),
      detail.status === "archived"
        ? React.createElement("button", { type: "button", onClick: () => void reopenTask() }, "Reopen")
        : React.createElement("button", { type: "button", onClick: () => void archiveTask() }, "Delete")
    )
  );
}

export { SmokeView as ${exportName} };
export default SmokeView;
export async function interact(capability, params = {}) {
  return { ok: true, viewId: viewMeta.id, viewType: viewMeta.viewType, capability, params };
}
`;
}

function smokeGenericViewBundleSource(view, exportName) {
  const label = JSON.stringify(view.label);
  const id = JSON.stringify(view.id);
  const viewType = JSON.stringify(view.viewType);
  const pluginName = JSON.stringify(view.pluginName);
  return `import React from "react";

const viewMeta = {
  id: ${id},
  label: ${label},
  viewType: ${viewType},
  pluginName: ${pluginName}
};

function SmokeView() {
  return React.createElement(
    "section",
    { "aria-label": viewMeta.label, style: { minHeight: "100vh", padding: 24 } },
    React.createElement("h1", null, viewMeta.label),
    React.createElement("p", null, viewMeta.pluginName + " dynamic view smoke surface is ready."),
    React.createElement("button", { type: "button" }, "Refresh view"),
    React.createElement("input", { "aria-label": viewMeta.label + " input", defaultValue: viewMeta.id })
  );
}

export { SmokeView as ${exportName} };
export default SmokeView;
export async function interact(capability, params = {}) {
  return { ok: true, viewId: viewMeta.id, viewType: viewMeta.viewType, capability, params };
}
`;
}

function smokeViewBundleSource(view) {
  const exportName = safeComponentExportName(view.componentExport);
  if (view.viewType === "tui") {
    return smokeTuiViewBundleSource(view, exportName);
  }
  if (view.id === "screenshare") {
    return smokeScreenshareBundleSource(view, exportName);
  }
  if (view.id === "task-coordinator") {
    return smokeTaskCoordinatorBundleSource(view, exportName);
  }
  return smokeGenericViewBundleSource(view, exportName);
}

function sendSmokeViewAsset(req, res, url, view, subResource) {
  const bundleDir = path.join(
    repoRoot,
    "plugins",
    view._smokePluginDirName,
    "dist",
    "views",
  );
  const assetPath = path.resolve(bundleDir, decodeURIComponent(subResource));
  const relative = path.relative(bundleDir, assetPath);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative === ""
  ) {
    sendJson(req, res, 400, { error: "Malformed view asset path" });
    return;
  }
  const hostExternalSpecifiers = parseHostExternalSpecifiers(url);
  if (!existsSync(assetPath)) {
    if (subResource === "bundle.js") {
      const source = smokeViewBundleSource(view);
      const body =
        hostExternalSpecifiers.length > 0
          ? rewriteHostExternalImports(source, hostExternalSpecifiers)
          : source;
      sendBinary(
        req,
        res,
        200,
        "application/javascript; charset=utf-8",
        Buffer.from(body, "utf8"),
      );
      return;
    }
    sendJson(req, res, 404, { error: `View asset not found: ${subResource}` });
    return;
  }
  const rawBody = readFileSync(assetPath);
  const body =
    hostExternalSpecifiers.length > 0 &&
    contentTypeForSmokeViewAsset(assetPath).startsWith("application/javascript")
      ? Buffer.from(
          rewriteHostExternalImports(
            rawBody.toString("utf8"),
            hostExternalSpecifiers,
          ),
          "utf8",
        )
      : rawBody;
  sendBinary(req, res, 200, contentTypeForSmokeViewAsset(assetPath), body);
}

function sendSseHeaders(req, res) {
  applyCors(req, res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return null;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function workbenchOverview() {
  return {
    tasks: [],
    triggers: [],
    todos: [],
    summary: {
      totalTasks: 0,
      completedTasks: 0,
      totalTriggers: 0,
      activeTriggers: 0,
      totalTodos: 0,
      completedTodos: 0,
    },
    tasksAvailable: false,
    triggersAvailable: false,
    todosAvailable: false,
    lifeopsAvailable: false,
  };
}

function streamSettings(payload = {}) {
  return {
    ok: true,
    settings: {
      theme: "eliza",
      avatarIndex: 0,
      ...payload,
    },
  };
}

const databaseRowsByTable = {
  messages: [
    {
      id: "msg-smoke-1",
      content:
        "UI smoke database row with https://example.com/smoke-image.png media",
      roomId: "room-smoke",
      entityId: "entity-smoke",
      createdAt: SMOKE_GENERATED_AT,
    },
    {
      id: "msg-smoke-2",
      content: "UI smoke vector sample row",
      roomId: "room-smoke",
      entityId: "entity-smoke",
      createdAt: SMOKE_GENERATED_AT,
    },
  ],
  memories: [
    {
      id: "memory-smoke-1",
      text: "Deterministic memory fixture for UI smoke.",
      roomId: "room-smoke",
      entityId: "entity-smoke",
      createdAt: SMOKE_GENERATED_AT,
      dim_0: 0.12,
      dim_1: 0.34,
      dim_2: 0.56,
    },
  ],
  media: [
    {
      id: "media-smoke-1",
      url: "https://example.com/smoke-image.png",
      type: "image",
      filename: "smoke-image.png",
      createdAt: SMOKE_GENERATED_AT,
    },
  ],
};

const databaseTables = Object.entries(databaseRowsByTable).map(
  ([name, rows]) => ({
    name,
    schema: "public",
    rowCount: rows.length,
    columns: Object.keys(rows[0] ?? {}).map((columnName) => ({
      name: columnName,
      type: columnName.startsWith("dim_") ? "double precision" : "text",
      nullable: false,
      defaultValue: null,
      isPrimaryKey: columnName === "id",
    })),
  }),
);

function databaseRowsResponse(tableName, url) {
  const rows = databaseRowsByTable[tableName] ?? [];
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const sort = url.searchParams.get("sort");
  const order = url.searchParams.get("order") === "desc" ? "desc" : "asc";
  const sortedRows = sort
    ? [...rows].sort((left, right) => {
        const leftValue = String(left[sort] ?? "");
        const rightValue = String(right[sort] ?? "");
        return order === "desc"
          ? rightValue.localeCompare(leftValue)
          : leftValue.localeCompare(rightValue);
      })
    : rows;
  const pageRows = sortedRows.slice(offset, offset + limit);
  return {
    table: tableName,
    rows: pageRows,
    columns: Object.keys(rows[0] ?? {}),
    total: rows.length,
    offset,
    limit,
  };
}

function executeDatabaseQueryResult(sql) {
  const match = /from\s+"?([a-z0-9_-]+)"?/iu.exec(sql ?? "");
  const tableName =
    match?.[1] && databaseRowsByTable[match[1]] ? match[1] : "messages";
  const rows = databaseRowsByTable[tableName] ?? [];
  return {
    columns: Object.keys(rows[0] ?? {}),
    rows,
    rowCount: rows.length,
    durationMs: 1,
  };
}

const sockets = new Set();
const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? `127.0.0.1:${port}`}`,
  );

  if (req.method === "OPTIONS") {
    sendEmpty(req, res, 204);
    return;
  }

  if (
    (req.method === "GET" || req.method === "HEAD") &&
    url.pathname === "/api/avatar/vrm"
  ) {
    sendBinary(req, res, 200, "application/octet-stream", SMOKE_VRM);
    return;
  }

  if (
    (req.method === "GET" || req.method === "HEAD") &&
    url.pathname === "/api/avatar/background"
  ) {
    sendBinary(req, res, 200, "image/png", ONE_PIXEL_PNG);
    return;
  }

  if (
    (req.method === "GET" || req.method === "HEAD") &&
    url.pathname.startsWith("/api/apps/hero/")
  ) {
    sendBinary(req, res, 200, "image/png", ONE_PIXEL_PNG);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/views") {
    const requestedViewType = url.searchParams.get("viewType");
    const views =
      requestedViewType === "gui" || requestedViewType === "tui"
        ? smokeViews.filter((view) => view.viewType === requestedViewType)
        : smokeViews;
    sendJson(req, res, 200, { views });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/views/current") {
    sendJson(req, res, 200, { currentView: null });
    return;
  }

  if (
    (req.method === "GET" || req.method === "HEAD") &&
    url.pathname.startsWith("/api/views/")
  ) {
    const afterPrefix = url.pathname.slice("/api/views/".length);
    const slashIndex = afterPrefix.indexOf("/");
    const rawId =
      slashIndex === -1 ? afterPrefix : afterPrefix.slice(0, slashIndex);
    const subResource =
      slashIndex === -1 ? "" : afterPrefix.slice(slashIndex + 1);
    const id = decodeURIComponent(rawId);
    const view = smokeViewByRequest(id, url.searchParams.get("viewType"));
    if (!view) {
      sendJson(req, res, 404, { error: `View not found: ${id}` });
      return;
    }
    if (subResource === "") {
      sendJson(req, res, 200, view);
      return;
    }
    if (subResource === "hero") {
      sendBinary(req, res, 200, "image/png", ONE_PIXEL_PNG);
      return;
    }
    if (subResource === "bundle.js") {
      sendSmokeViewAsset(req, res, url, view, "bundle.js");
      return;
    }
    sendSmokeViewAsset(req, res, url, view, subResource);
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/views/")) {
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(req, res, 200, { status: "ok" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/first-run/status") {
    sendJson(req, res, 200, { complete: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/first-run/options") {
    sendJson(req, res, 200, {
      names: [],
      styles: [],
      providers: [],
      cloudProviders: [],
      models: {
        nano: [],
        small: [],
        medium: [],
        large: [],
        mega: [],
      },
      inventoryProviders: [],
      sharedStyleRules: "",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    sendJson(req, res, 200, {
      required: false,
      pairingEnabled: false,
      expiresAt: null,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    sendJson(req, res, 200, {
      identity: stubAuthIdentity,
      session: stubAuthSession,
      access: stubAuthAccess,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/sessions") {
    sendJson(req, res, 200, {
      sessions: [
        {
          id: stubAuthSession.id,
          kind: stubAuthSession.kind,
          ip: "127.0.0.1",
          userAgent: "Playwright smoke",
          lastSeenAt: Date.now(),
          expiresAt: null,
          current: true,
        },
      ],
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent/status") {
    sendJson(req, res, 200, { firstRunComplete: true, status: "running" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/emote") {
    const body = (await readJsonBody(req)) || {};
    sendJson(req, res, 200, {
      ok: true,
      emoteId: typeof body.emoteId === "string" ? body.emoteId : null,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    sendJson(req, res, 200, {
      state: "running",
      startup: { phase: "running", attempt: 0 },
      pendingRestart: false,
      pendingRestartReasons: [],
    });
    return;
  }

  if (url.pathname === "/api/config") {
    const config = {
      cloud: { enabled: false },
      media: {},
      plugins: { entries: {} },
      ui: {},
      wallet: {},
    };
    if (req.method === "GET") {
      sendJson(req, res, 200, config);
      return;
    }
    if (req.method === "PUT" || req.method === "PATCH") {
      const body = (await readJsonBody(req)) || {};
      sendJson(req, res, 200, {
        ...config,
        ...(body && typeof body === "object" && !Array.isArray(body)
          ? body
          : {}),
      });
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/database/status") {
    sendJson(req, res, 200, {
      provider: "pglite",
      connected: true,
      serverVersion: "16.0-ui-smoke",
      tableCount: databaseTables.length,
      pgliteDataDir: null,
      postgresHost: null,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/database/config") {
    sendJson(req, res, 200, {
      config: {},
      activeProvider: "pglite",
      needsRestart: false,
    });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/database/config") {
    sendJson(req, res, 200, {
      config: (await readJsonBody(req)) || {},
      activeProvider: "pglite",
      needsRestart: false,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/database/test") {
    sendJson(req, res, 200, {
      success: true,
      serverVersion: "16.0-ui-smoke",
      error: null,
      durationMs: 1,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/database/tables") {
    sendJson(req, res, 200, { tables: databaseTables });
    return;
  }

  const databaseRowsMatch = /^\/api\/database\/tables\/([^/]+)\/rows$/.exec(
    url.pathname,
  );
  if (databaseRowsMatch) {
    const tableName = decodeURIComponent(databaseRowsMatch[1]);
    if (req.method === "GET") {
      sendJson(req, res, 200, databaseRowsResponse(tableName, url));
      return;
    }
    if (["POST", "PUT", "DELETE"].includes(req.method ?? "GET")) {
      sendJson(req, res, 200, {
        ok: true,
        table: tableName,
        row: databaseRowsByTable[tableName]?.[0] ?? null,
      });
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/database/query") {
    const body = (await readJsonBody(req)) || {};
    sendJson(req, res, 200, executeDatabaseQueryResult(String(body.sql ?? "")));
    return;
  }

  if (
    (req.method === "GET" || req.method === "POST") &&
    url.pathname === "/api/database/vectors/search"
  ) {
    const query =
      req.method === "POST"
        ? (await readJsonBody(req))?.query
        : url.searchParams.get("query");
    sendJson(req, res, 200, {
      query: typeof query === "string" ? query : "",
      table: "memories",
      limit: 10,
      count: 1,
      results: [
        {
          id: "memory-smoke-1",
          text: "Deterministic memory fixture for UI smoke.",
          similarity: 0.98,
          roomId: "room-smoke",
          entityId: "entity-smoke",
          createdAt: SMOKE_GENERATED_AT,
          tableName: "memories",
        },
      ],
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/vincent/status") {
    sendJson(req, res, 200, {
      connected: false,
      connectedAt: null,
      tradingVenues: ["hyperliquid", "polymarket"],
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/vincent/strategy") {
    sendJson(req, res, 200, { connected: false, strategy: null });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/vincent/trading-profile") {
    sendJson(req, res, 200, { connected: false, profile: null });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/shopify/status") {
    sendJson(req, res, 200, { connected: false, shop: null });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/shopify/products") {
    sendJson(req, res, 200, { products: [], total: 0, page: 1, pageSize: 25 });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/shopify/orders") {
    sendJson(req, res, 200, { orders: [], total: 0 });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/shopify/inventory") {
    sendJson(req, res, 200, { items: [], locations: [] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/shopify/customers") {
    sendJson(req, res, 200, { customers: [], total: 0 });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/hyperliquid/status") {
    sendJson(req, res, 200, stubHyperliquidStatus);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/hyperliquid/markets") {
    sendJson(req, res, 200, stubHyperliquidMarkets);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/hyperliquid/positions") {
    sendJson(req, res, 200, {
      accountAddress: null,
      positions: [],
      readBlockedReason:
        "Connect an account address to read Hyperliquid positions.",
      fetchedAt: null,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/hyperliquid/orders") {
    sendJson(req, res, 200, {
      accountAddress: null,
      orders: [],
      readBlockedReason: "Connect an account address to read open orders.",
      fetchedAt: null,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/polymarket/status") {
    sendJson(req, res, 200, stubPolymarketStatus);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/polymarket/markets") {
    sendJson(req, res, 200, {
      markets: [stubPolymarketMarket],
      source: { api: "gamma", endpoint: "/markets" },
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/polymarket/market") {
    sendJson(req, res, 200, {
      market: stubPolymarketMarket,
      source: { api: "gamma", endpoint: "/markets" },
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/polymarket/orderbook") {
    sendJson(req, res, 200, {
      tokenId: url.searchParams.get("token_id") ?? "yes-token",
      market: stubPolymarketMarket.id,
      assetId: null,
      bids: [{ price: "0.71", size: "100" }],
      asks: [{ price: "0.73", size: "100" }],
      bestBid: "0.71",
      bestBidSize: "100",
      bestAsk: "0.73",
      bestAskSize: "100",
      midpoint: "0.72",
      spread: "0.02",
      bidLevels: 1,
      askLevels: 1,
      lastTradePrice: "0.72",
      tickSize: "0.01",
      source: { api: "clob", endpoint: "/book" },
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/polymarket/orders") {
    sendJson(req, res, 200, {
      enabled: false,
      reason: "Trading is disabled in UI smoke.",
      requiredForTrading: [
        "POLYMARKET_PRIVATE_KEY",
        "CLOB_API_KEY",
        "CLOB_API_SECRET",
        "CLOB_API_PASSPHRASE",
      ],
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/polymarket/positions") {
    sendJson(req, res, 200, {
      positions: [],
      source: { api: "data", endpoint: "/positions" },
    });
    return;
  }

  if (url.pathname === "/api/conversations") {
    if (req.method === "GET") {
      sendJson(req, res, 200, { conversations: stubConversations });
      return;
    }
    if (req.method === "POST") {
      const body = (await readJsonBody(req)) || {};
      const conversation = createStubConversation({
        title: body.title,
        metadata: body.metadata,
      });
      sendJson(req, res, 200, { conversation });
      return;
    }
  }

  if (
    req.method === "POST" &&
    url.pathname === "/api/conversations/cleanup-empty"
  ) {
    const body = (await readJsonBody(req)) || {};
    const deleted = cleanupEmptyStubConversations({
      keepId: body.keepId,
    });
    sendJson(req, res, 200, { deleted });
    return;
  }

  const conversationMessagesMatch = url.pathname.match(
    /^\/api\/conversations\/([^/]+)\/messages(?:\/(stream|truncate))?$/,
  );
  if (conversationMessagesMatch) {
    const conversationId = decodeURIComponent(conversationMessagesMatch[1]);
    const action = conversationMessagesMatch[2] ?? null;
    const conversation = findStubConversation(conversationId);
    if (!conversation) {
      sendJson(req, res, 404, { error: "Conversation not found" });
      return;
    }

    if (req.method === "GET" && action === null) {
      sendJson(req, res, 200, {
        messages: stubConversationMessages.get(conversationId) ?? [],
      });
      return;
    }

    if (req.method === "POST" && action === "truncate") {
      stubConversationMessages.set(conversationId, []);
      conversation.updatedAt = nowIso();
      sendJson(req, res, 200, { ok: true, messages: [] });
      return;
    }

    if (req.method === "POST" && action === "stream") {
      const body = (await readJsonBody(req)) || {};
      appendStubMessage(conversationId, createStubMessage("user", body.text));
      const text = createDeterministicAssistantText({
        body,
        conversationId,
        transport: "sse",
      });
      appendStubMessage(conversationId, createStubMessage("assistant", text));
      sendSseHeaders(req, res);
      writeSseEvent(res, { type: "token", text, fullText: text });
      writeSseEvent(res, { type: "done", fullText: text, agentName: "Eliza" });
      res.end();
      return;
    }

    if (req.method === "POST" && action === null) {
      const body = (await readJsonBody(req)) || {};
      appendStubMessage(conversationId, createStubMessage("user", body.text));
      const text = createDeterministicAssistantText({
        body,
        conversationId,
        transport: "json",
      });
      appendStubMessage(conversationId, createStubMessage("assistant", text));
      sendJson(req, res, 200, { text, agentName: "Eliza" });
      return;
    }
  }

  const conversationMatch = url.pathname.match(
    /^\/api\/conversations\/([^/]+)$/,
  );
  if (conversationMatch) {
    const conversationId = decodeURIComponent(conversationMatch[1]);
    const conversation = findStubConversation(conversationId);
    if (!conversation) {
      sendJson(req, res, 404, { error: "Conversation not found" });
      return;
    }
    if (req.method === "PATCH") {
      const body = (await readJsonBody(req)) || {};
      if (typeof body.title === "string" && body.title.trim().length > 0) {
        conversation.title = body.title.trim();
      }
      if (
        Object.hasOwn(body, "metadata") &&
        body.metadata &&
        typeof body.metadata === "object" &&
        !Array.isArray(body.metadata)
      ) {
        conversation.metadata = body.metadata;
      }
      conversation.updatedAt = nowIso();
      sendJson(req, res, 200, { conversation });
      return;
    }
    if (req.method === "DELETE") {
      const index = stubConversations.findIndex(
        (item) => item.id === conversationId,
      );
      if (index >= 0) stubConversations.splice(index, 1);
      stubConversationMessages.delete(conversationId);
      sendJson(req, res, 200, { ok: true });
      return;
    }
  }

  const conversationGreetingMatch = url.pathname.match(
    /^\/api\/conversations\/([^/]+)\/greeting$/,
  );
  if (req.method === "POST" && conversationGreetingMatch) {
    const conversationId = decodeURIComponent(conversationGreetingMatch[1]);
    if (!findStubConversation(conversationId)) {
      sendJson(req, res, 404, { error: "Conversation not found" });
      return;
    }
    sendJson(req, res, 200, {
      text: "What would you like to check?",
      agentName: "Eliza",
      generated: false,
      persisted: true,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agents") {
    sendJson(req, res, 200, { agents: [] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/workbench/overview") {
    sendJson(req, res, 200, workbenchOverview());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/workbench/todos") {
    sendJson(req, res, 200, { todos: [], total: 0 });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/plugins") {
    sendJson(req, res, 200, { plugins: stubPlugins });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/runtime") {
    sendJson(req, res, 200, buildRuntimeSnapshot(url));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/runtime/mode") {
    sendJson(req, res, 200, {
      mode: "local",
      deploymentRuntime: "local",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/memories/stats") {
    sendJson(req, res, 200, stubMemoryStats);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/memories/feed") {
    sendJson(req, res, 200, stubMemoryFeedResponse);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/memories/browse") {
    const limit = Number(url.searchParams.get("limit") || "50");
    const offset = Number(url.searchParams.get("offset") || "0");
    sendJson(req, res, 200, {
      ...stubMemoryBrowseResponse,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname.startsWith("/api/memories/by-entity/")
  ) {
    const limit = Number(url.searchParams.get("limit") || "50");
    const offset = Number(url.searchParams.get("offset") || "0");
    sendJson(req, res, 200, {
      ...stubMemoryBrowseResponse,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/relationships/graph") {
    sendJson(req, res, 200, stubRelationshipsGraphResponse);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/relationships/people") {
    sendJson(req, res, 200, stubRelationshipsPeopleResponse);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/browser-workspace") {
    sendJson(req, res, 200, browserWorkspaceSnapshot());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/browser-workspace/tabs") {
    const body = (await readJsonBody(req)) || {};
    const urlValue = normalizeStubBrowserUrl(body.url || "about:blank");
    const title =
      typeof body.title === "string" && body.title.trim().length > 0
        ? body.title.trim()
        : inferStubBrowserTitle(urlValue);
    const timestamp = nowIso();
    const tab = {
      id: `stub-tab-${++browserWorkspaceCounter}`,
      title,
      url: urlValue,
      partition: "persist:ui-smoke",
      visible: body.show !== false,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastFocusedAt: body.show !== false ? timestamp : null,
    };
    if (tab.visible) {
      browserWorkspaceTabs = browserWorkspaceTabs.map((entry) => ({
        ...entry,
        visible: false,
      }));
    }
    browserWorkspaceTabs = [...browserWorkspaceTabs, tab];
    sendJson(req, res, 200, { tab });
    return;
  }

  const browserTabMatch =
    /^\/api\/browser-workspace\/tabs\/([^/]+)(?:\/(navigate|show|hide))?$/.exec(
      url.pathname,
    );
  if (browserTabMatch) {
    const tabId = decodeURIComponent(browserTabMatch[1]);
    const action = browserTabMatch[2] || null;
    const existing = browserWorkspaceTabs.find((tab) => tab.id === tabId);
    if (!existing) {
      sendJson(req, res, 404, { error: `Tab not found: ${tabId}` });
      return;
    }

    if (req.method === "DELETE" && !action) {
      browserWorkspaceTabs = browserWorkspaceTabs.filter(
        (tab) => tab.id !== tabId,
      );
      sendJson(req, res, 200, { closed: true });
      return;
    }

    if (req.method === "POST" && action === "show") {
      sendJson(req, res, 200, { tab: showBrowserWorkspaceTab(tabId) });
      return;
    }

    if (req.method === "POST" && action === "hide") {
      browserWorkspaceTabs = browserWorkspaceTabs.map((tab) =>
        tab.id === tabId
          ? { ...tab, visible: false, updatedAt: nowIso() }
          : tab,
      );
      sendJson(req, res, 200, {
        tab: browserWorkspaceTabs.find((tab) => tab.id === tabId),
      });
      return;
    }

    if (req.method === "POST" && action === "navigate") {
      const body = (await readJsonBody(req)) || {};
      const nextUrl = normalizeStubBrowserUrl(body.url);
      const nextUpdatedAt = nowIso();
      browserWorkspaceTabs = browserWorkspaceTabs.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              url: nextUrl,
              title: inferStubBrowserTitle(nextUrl),
              updatedAt: nextUpdatedAt,
              lastFocusedAt: nextUpdatedAt,
            }
          : tab,
      );
      sendJson(req, res, 200, {
        tab: browserWorkspaceTabs.find((tab) => tab.id === tabId),
      });
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/character") {
    sendJson(req, res, 200, { character: stubCharacter, agentName: "Eliza" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/character/history") {
    sendJson(req, res, 200, { history: [], total: 0 });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/character/experiences") {
    sendJson(req, res, 200, {
      data: stubExperiences,
      total: stubExperiences.length,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/relationships/activity") {
    sendJson(req, res, 200, { activity: [] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/documents") {
    sendJson(req, res, 200, {
      documents: [],
      total: 0,
      limit: parsePositiveInt(url.searchParams.get("limit"), 100),
      offset: parsePositiveInt(url.searchParams.get("offset"), 0),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/voice/profiles") {
    sendJson(req, res, 200, { profiles: [] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/subscription/status") {
    sendJson(req, res, 200, { providers: [] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/update/status") {
    sendJson(req, res, 200, {
      currentVersion: "0.0.0-ui-smoke",
      channel: "stable",
      installMethod: "source",
      updateAuthority: "manual",
      nextAction: "manual",
      canAutoUpdate: false,
      canExecuteUpdate: false,
      remoteDisplay: false,
      updateCommand: null,
      updateInstructions: null,
      updateAvailable: false,
      latestVersion: "0.0.0-ui-smoke",
      channels: {
        stable: "0.0.0-ui-smoke",
        beta: "0.0.0-ui-smoke",
        nightly: "0.0.0-ui-smoke",
      },
      distTags: {},
      lastCheckAt: null,
      error: null,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/permissions") {
    const permission = {
      id: "shell",
      status: "granted",
      lastChecked: Date.now(),
      canRequest: false,
      platform: process.platform,
    };
    sendJson(req, res, 200, {
      shell: permission,
      notifications: { ...permission, id: "notifications" },
      microphone: { ...permission, id: "microphone" },
      camera: { ...permission, id: "camera" },
      "screen-capture": { ...permission, id: "screen-capture" },
      accessibility: { ...permission, id: "accessibility" },
      "website-blocking": {
        ...permission,
        id: "website-blocking",
        status: "not-applicable",
      },
      _platform: process.platform,
      _shellEnabled: true,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/permissions/shell") {
    sendJson(req, res, 200, {
      id: "shell",
      status: "granted",
      lastChecked: Date.now(),
      canRequest: false,
      platform: process.platform,
    });
    return;
  }

  if (
    (req.method === "GET" || req.method === "PUT") &&
    url.pathname === "/api/secrets/manager/preferences"
  ) {
    if (req.method === "PUT") {
      await readJsonBody(req);
    }
    sendJson(req, res, 200, {
      preferences: { enabled: ["in-house"], routing: {} },
    });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/secrets/manager/backends"
  ) {
    sendJson(req, res, 200, {
      backends: [
        {
          id: "in-house",
          label: "Local (encrypted)",
          available: true,
          signedIn: true,
          detail: "UI smoke local vault",
          authMode: null,
        },
      ],
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/secrets/inventory") {
    const category = url.searchParams.get("category");
    sendJson(req, res, 200, {
      entries:
        category === "wallet"
          ? [
              {
                key: "EVM_PRIVATE_KEY",
                label: "EVM private key",
                category: "wallet",
                backend: "in-house",
                isSet: true,
                updatedAt: SMOKE_GENERATED_AT,
              },
              {
                key: "SOLANA_PRIVATE_KEY",
                label: "Solana private key",
                category: "wallet",
                backend: "in-house",
                isSet: true,
                updatedAt: SMOKE_GENERATED_AT,
              },
            ]
          : [],
    });
    return;
  }

  const secretInventoryMatch = /^\/api\/secrets\/inventory\/([^/]+)$/.exec(
    url.pathname,
  );
  if (secretInventoryMatch) {
    const key = decodeURIComponent(secretInventoryMatch[1]);
    if (req.method === "GET") {
      sendJson(req, res, 200, {
        ok: true,
        value: key.includes("SOLANA")
          ? "5HueCGU8rMjxEXxiPuD5BDuRa"
          : "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        source: "bare",
      });
      return;
    }
    if (req.method === "PUT" || req.method === "DELETE") {
      if (req.method === "PUT") {
        await readJsonBody(req);
      }
      sendJson(req, res, 200, { ok: true, key });
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/wallet/addresses") {
    sendJson(req, res, 200, { evmAddress: null, solanaAddress: null });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/wallet/config") {
    sendJson(req, res, 200, emptyWalletConfig);
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/wallet/config") {
    const body = (await readJsonBody(req)) || {};
    sendJson(req, res, 200, {
      ...emptyWalletConfig,
      selectedRpcProviders:
        body && typeof body === "object" && "selections" in body
          ? body.selections
          : emptyWalletConfig.selectedRpcProviders,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/wallet/keys") {
    sendJson(req, res, 200, {
      evmPrivateKeySet: true,
      solanaPrivateKeySet: true,
      evmAddress: "0x1234567890abcdef1234567890abcdef12345678",
      solanaAddress: "So11111111111111111111111111111111111111112",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/wallet/os-store") {
    sendJson(req, res, 200, {
      available: true,
      backend: "in-house",
      evmKeyInOsStore: true,
      solanaKeyInOsStore: true,
      envKeysPresent: false,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/wallet/os-store") {
    const body = (await readJsonBody(req)) || {};
    sendJson(req, res, 200, { ok: true, action: body.action ?? null });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/wallet/refresh-cloud") {
    sendJson(req, res, 200, {
      ok: true,
      imported: [],
      warnings: [],
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/wallet/primary") {
    const body = (await readJsonBody(req)) || {};
    sendJson(req, res, 200, { ok: true, ...body });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/wallet/generate") {
    const body = (await readJsonBody(req)) || {};
    sendJson(req, res, 200, {
      ok: true,
      chain: body.chain ?? "evm",
      source: body.source ?? "local",
      address:
        body.chain === "solana"
          ? "So11111111111111111111111111111111111111112"
          : "0x1234567890abcdef1234567890abcdef12345678",
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/wallet/export") {
    await readJsonBody(req);
    sendJson(req, res, 200, {
      evmPrivateKey:
        "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      solanaPrivateKey: "5HueCGU8rMjxEXxiPuD5BDuRa",
    });
    return;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/api/wallet/production-defaults"
  ) {
    await readJsonBody(req);
    sendJson(req, res, 200, {
      ok: true,
      updated: true,
      warnings: [],
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/wallet/balances") {
    sendJson(req, res, 200, emptyWalletBalances);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/wallet/nfts") {
    sendJson(req, res, 200, emptyWalletNfts);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/wallet/trading/profile") {
    sendJson(req, res, 200, emptyWalletTradingProfile);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/wallet/market-overview") {
    sendJson(req, res, 200, emptyWalletMarketOverview);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/stream/settings") {
    sendJson(req, res, 200, streamSettings());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/stream/settings") {
    const body = await readJsonBody(req);
    const settings =
      body &&
      typeof body === "object" &&
      body.settings &&
      typeof body.settings === "object"
        ? body.settings
        : {};
    sendJson(req, res, 200, streamSettings(settings));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/stream/status") {
    sendJson(req, res, 200, {
      isLive: false,
      isConnected: false,
      viewers: 0,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cloud/status") {
    sendJson(req, res, 200, {
      connected: false,
      enabled: false,
      cloudVoiceProxyAvailable: false,
      hasApiKey: false,
      reason: "runtime_not_started",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent/events") {
    sendJson(req, res, 200, {
      events: [],
      latestEventId: null,
      totalBuffered: 0,
      replayed: true,
    });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/computer-use/approvals/stream"
  ) {
    sendSseHeaders(req, res);
    writeSseEvent(res, {
      type: "snapshot",
      snapshot: emptyComputerUseApprovalSnapshot,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/computer-use/approvals") {
    sendJson(req, res, 200, emptyComputerUseApprovalSnapshot);
    return;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/api/computer-use/approval-mode"
  ) {
    sendJson(req, res, 200, {
      mode: emptyComputerUseApprovalSnapshot.mode,
    });
    return;
  }

  const computerUseApprovalMatch =
    /^\/api\/computer-use\/approvals\/([^/]+)$/.exec(url.pathname);
  if (req.method === "POST" && computerUseApprovalMatch) {
    const approvalId = decodeURIComponent(computerUseApprovalMatch[1]);
    const body = (await readJsonBody(req)) || {};
    sendJson(req, res, 200, {
      id: approvalId,
      command: "computer-use-command",
      approved: body.approved === true,
      cancelled: body.approved !== true,
      mode: emptyComputerUseApprovalSnapshot.mode,
      requestedAt: nowIso(),
      resolvedAt: nowIso(),
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/drop/status") {
    sendJson(req, res, 200, {
      dropEnabled: false,
      publicMintOpen: false,
      whitelistMintOpen: false,
      mintedOut: false,
      currentSupply: 0,
      maxSupply: 2138,
      shinyPrice: "0.1",
      userHasMinted: false,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/inbox/chats") {
    sendJson(req, res, 200, { chats: [], unreadCount: 0 });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/registry/status") {
    sendJson(req, res, 200, { connected: false, online: false });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/local-inference/downloads/stream"
  ) {
    sendSseHeaders(req, res);
    writeSseEvent(res, {
      type: "snapshot",
      downloads: emptyLocalInferenceHub.downloads,
      active: emptyLocalInferenceHub.active,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/local-inference/hub") {
    sendJson(req, res, 200, emptyLocalInferenceHub);
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/local-inference/hardware"
  ) {
    sendJson(req, res, 200, emptyLocalInferenceHardware);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/local-inference/catalog") {
    sendJson(req, res, 200, { models: [] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/local-inference/routing") {
    sendJson(req, res, 200, {
      registrations: [],
      preferences: {
        preferredProvider: {},
        policy: {},
      },
    });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/local-inference/installed"
  ) {
    sendJson(req, res, 200, { models: [] });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/local-inference/hf-search"
  ) {
    sendJson(req, res, 200, { models: [] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/local-inference/active") {
    sendJson(req, res, 200, emptyLocalInferenceActive);
    return;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/api/local-inference/downloads"
  ) {
    const body = (await readJsonBody(req)) || {};
    const modelId =
      typeof body.modelId === "string" && body.modelId.trim().length > 0
        ? body.modelId.trim()
        : typeof body.spec?.id === "string" && body.spec.id.trim().length > 0
          ? body.spec.id.trim()
          : "local-inference-model";
    sendJson(req, res, 200, {
      job: {
        jobId: `job-${modelId}`,
        modelId,
        state: "queued",
        received: 0,
        total: 0,
        bytesPerSec: 0,
        etaMs: null,
        startedAt: nowIso(),
        updatedAt: nowIso(),
      },
    });
    return;
  }

  const localInferenceDownloadMatch =
    /^\/api\/local-inference\/downloads\/([^/]+)$/.exec(url.pathname);
  if (req.method === "DELETE" && localInferenceDownloadMatch) {
    sendJson(req, res, 200, { cancelled: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/local-inference/active") {
    const body = (await readJsonBody(req)) || {};
    const modelId =
      typeof body.modelId === "string" && body.modelId.trim().length > 0
        ? body.modelId.trim()
        : null;
    sendJson(req, res, 200, {
      modelId,
      loadedAt: modelId ? nowIso() : null,
      status: modelId ? "ready" : "idle",
    });
    return;
  }

  if (
    req.method === "DELETE" &&
    url.pathname === "/api/local-inference/active"
  ) {
    sendJson(req, res, 200, emptyLocalInferenceActive);
    return;
  }

  const localInferenceInstalledMatch =
    /^\/api\/local-inference\/installed\/([^/]+)$/.exec(url.pathname);
  if (req.method === "DELETE" && localInferenceInstalledMatch) {
    sendJson(req, res, 200, { removed: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/coding-agents") {
    sendJson(req, res, 200, []);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/coding-agents/preflight") {
    sendJson(req, res, 200, {
      ok: true,
      missingTools: [],
      ready: true,
    });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/coding-agents/coordinator/status"
  ) {
    sendJson(req, res, 200, {
      supervisionLevel: "autonomous",
      taskCount: 0,
      tasks: [],
      pendingConfirmations: 0,
    });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/coding-agents/coordinator/threads"
  ) {
    sendJson(req, res, 200, { threads: [], total: 0 });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/lifeops/overview") {
    sendJson(req, res, 200, emptyLifeOpsOverview);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/lifeops/capabilities") {
    sendJson(req, res, 200, emptyLifeOpsCapabilities);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/lifeops/calendar/feed") {
    sendJson(req, res, 200, emptyLifeOpsCalendarFeed);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/lifeops/inbox") {
    sendJson(req, res, 200, emptyLifeOpsInbox);
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/lifeops/screen-time/summary"
  ) {
    sendJson(req, res, 200, emptyLifeOpsScreenTimeSummary);
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/lifeops/screen-time/breakdown"
  ) {
    sendJson(req, res, 200, emptyLifeOpsScreenTimeBreakdown);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/lifeops/social/summary") {
    sendJson(req, res, 200, emptyLifeOpsSocialSummary);
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/lifeops/connectors/google/status"
  ) {
    sendJson(req, res, 200, {
      connected: false,
      available: false,
      authUrl: null,
      lastSyncedAt: null,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/browser-bridge/settings") {
    sendJson(req, res, 200, { settings: emptyBrowserBridgeSettings });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/browser-bridge/companions"
  ) {
    sendJson(req, res, 200, { companions: [] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/browser-bridge/packages") {
    sendJson(req, res, 200, { status: emptyBrowserBridgePackageStatus });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/lifeops/app-state") {
    sendJson(req, res, 200, { enabled: lifeOpsAppEnabled });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/lifeops/app-state") {
    const body = (await readJsonBody(req)) || {};
    lifeOpsAppEnabled = body.enabled === true;
    sendJson(req, res, 200, { enabled: lifeOpsAppEnabled });
    return;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/api/lifeops/activity-signals"
  ) {
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/catalog/apps") {
    sendJson(req, res, 200, stubCatalogApps);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/apps") {
    sendJson(req, res, 200, []);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/apps/permissions") {
    sendJson(req, res, 200, []);
    return;
  }

  const appPermissionsMatch = /^\/api\/apps\/permissions\/([^/]+)$/.exec(
    url.pathname,
  );
  if (appPermissionsMatch) {
    const slug = decodeURIComponent(appPermissionsMatch[1]);
    if (req.method === "GET") {
      sendJson(req, res, 200, {
        slug,
        displayName: slug,
        requestedNamespaces: [],
        grantedNamespaces: [],
      });
      return;
    }
    if (req.method === "PUT") {
      const body = (await readJsonBody(req)) || {};
      sendJson(req, res, 200, {
        slug,
        displayName: slug,
        requestedNamespaces: [],
        grantedNamespaces: Array.isArray(body.namespaces)
          ? body.namespaces
          : [],
      });
      return;
    }
  }

  if (url.pathname === "/api/apps/favorites") {
    if (req.method === "GET") {
      sendJson(req, res, 200, { favoriteApps: smokeFavoriteApps });
      return;
    }

    if (req.method === "PUT") {
      const body = (await readJsonBody(req)) || {};
      const appName =
        typeof body.appName === "string" ? body.appName.trim() : "";
      if (appName) {
        const next = new Set(smokeFavoriteApps);
        if (body.isFavorite === false) {
          next.delete(appName);
        } else {
          next.add(appName);
        }
        smokeFavoriteApps = [...next];
      }
      sendJson(req, res, 200, { favoriteApps: smokeFavoriteApps });
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/apps/favorites/replace") {
    const body = (await readJsonBody(req)) || {};
    smokeFavoriteApps = Array.isArray(body.favoriteAppNames)
      ? body.favoriteAppNames.filter((name) => typeof name === "string")
      : [];
    sendJson(req, res, 200, { favoriteApps: smokeFavoriteApps });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/apps/overlay-presence") {
    const body = (await readJsonBody(req)) || {};
    sendJson(req, res, 200, {
      ok: true,
      app: typeof body.app === "string" ? body.app : null,
      present: body.present === true,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/skills") {
    sendJson(req, res, 200, emptySkillsResponse);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/skills/refresh") {
    sendJson(req, res, 200, { ok: true, ...emptySkillsResponse });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/skills/marketplace/search"
  ) {
    sendJson(req, res, 200, { results: [] });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/skills/marketplace/config"
  ) {
    sendJson(req, res, 200, { keySet: false });
    return;
  }

  if (
    req.method === "PUT" &&
    url.pathname === "/api/skills/marketplace/config"
  ) {
    sendJson(req, res, 200, { keySet: true });
    return;
  }

  if (
    req.method === "POST" &&
    (url.pathname === "/api/skills/marketplace/install" ||
      url.pathname === "/api/skills/marketplace/uninstall")
  ) {
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/apps/installed") {
    sendJson(req, res, 200, []);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/apps/runs") {
    sendJson(req, res, 200, []);
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/apps/screenshare/capabilities"
  ) {
    sendJson(req, res, 200, {
      platform: "smoke",
      capabilities: {
        screenshot: { available: true, tool: "screencapture" },
        headfulGui: { available: true, tool: "browser" },
        keyboard: { available: false, tool: "computer-use" },
      },
    });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/apps/screenshare/sessions"
  ) {
    sendJson(req, res, 200, {
      sessions: [
        {
          id: "smoke-session",
          label: "Smoke session",
          status: "active",
          createdAt: SMOKE_GENERATED_AT,
          updatedAt: SMOKE_GENERATED_AT,
          stoppedAt: null,
          platform: "smoke",
          frameCount: 1,
          inputCount: 0,
          lastFrameAt: SMOKE_GENERATED_AT,
          lastInputAt: null,
        },
      ],
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/logs") {
    sendJson(req, res, 200, stubLogsResponse);
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/__ui-smoke/unhandled-requests"
  ) {
    sendJson(req, res, 200, { requests: unhandledApiRequests });
    return;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/api/__ui-smoke/unhandled-requests/reset"
  ) {
    unhandledApiRequests.length = 0;
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/apps/info/")) {
    sendJson(req, res, 404, { error: "App not found" });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/apps/search")) {
    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const results = query
      ? stubCatalogApps.filter((app) =>
          [app.name, app.displayName, app.description, app.category]
            .join(" ")
            .toLowerCase()
            .includes(query),
        )
      : stubCatalogApps;
    sendJson(req, res, 200, results);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/apps/launch") {
    sendJson(req, res, 200, {
      pluginInstalled: true,
      needsRestart: false,
      displayName: "Smoke App",
      launchType: "connect",
      launchUrl: null,
      viewer: null,
      session: null,
      run: null,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/i18n/locale") {
    // Mirror the real public language-suggestion route
    // (packages/app-core/src/api/i18n-locale-routes.ts). The SPA polls this on
    // first paint; without it the stub's catch-all 501 spams console.error.
    sendJson(req, res, 200, { language: "en" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tts/first-run/speak") {
    // Onboarding synthesizes its scripted voice lines here and plays the bytes
    // as audio/wav. Return decodable silence so the live stack never logs a
    // 501; the real route (first-run-tts-route.ts) returns neural TTS audio.
    sendBinary(req, res, 200, "audio/wav", SILENT_WAV);
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    const request = recordUnhandledApiRequest(req, url);
    if (req.method === "HEAD") {
      sendEmpty(req, res, 501);
      return;
    }
    sendJson(req, res, 501, {
      error: `Unhandled UI smoke API route: ${request.method} ${request.path}`,
      fixture: "ui-smoke-api-stub",
      request,
    });
    return;
  }

  sendJson(req, res, 404, {
    error: `Unhandled ${req.method ?? "GET"} ${url.pathname}`,
  });
});

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => {
    sockets.delete(socket);
  });
});

const wsServer = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? `127.0.0.1:${port}`}`,
  );
  if (url.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  wsServer.handleUpgrade(req, socket, head, (ws) => {
    wsServer.emit("connection", ws, req);
  });
});

wsServer.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "ready" }));
  ws.on("message", () => {});
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    `[playwright-ui-smoke-api-stub] listening on http://127.0.0.1:${port}`,
  );
});

async function shutdown() {
  for (const client of wsServer.clients) {
    client.terminate();
  }
  wsServer.close();
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (
      signal === "SIGTERM" &&
      process.env.ELIZA_UI_SMOKE_STUB_IGNORE_SIGTERM === "1"
    ) {
      console.warn("[playwright-ui-smoke-api-stub] ignoring SIGTERM");
      return;
    }
    void shutdown();
  });
}
