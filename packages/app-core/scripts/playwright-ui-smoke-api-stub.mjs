import http from "node:http";
import { WebSocketServer } from "ws";

const port = Number(process.env.ELIZA_UI_SMOKE_API_PORT || "31337");
let browserWorkspaceCounter = 0;
let browserWorkspaceTabs = [];
let lifeOpsAppEnabled = true;
let conversationCounter = 0;
let messageCounter = 0;
const stubConversations = [];
const stubConversationMessages = new Map();
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
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
    name: "@elizaos/app-lifeops",
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
    name: "@elizaos/app-training",
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
    name: "@elizaos/app-companion",
    displayName: "Companion",
    description: "The companion overlay shell for ambient agent presence.",
    category: "social",
  }),
  stubCatalogApp({
    name: "@elizaos/app-shopify",
    displayName: "Shopify",
    description: "Manage Shopify store operations from the agent workspace.",
    category: "platform",
  }),
  stubCatalogApp({
    name: "@elizaos/app-vincent",
    displayName: "Vincent",
    description: "Manage Vincent DeFi account access and trading context.",
    category: "platform",
  }),
];

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

function createStubConversation({
  title = "New chat",
  metadata = {},
} = {}) {
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

function appendStubMessage(conversationId, message) {
  const messages = stubConversationMessages.get(conversationId) ?? [];
  messages.push(message);
  stubConversationMessages.set(conversationId, messages);
  const conversation = findStubConversation(conversationId);
  if (conversation) conversation.updatedAt = nowIso();
  return message;
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
    sendBinary(req, res, 200, "application/octet-stream", Buffer.alloc(0));
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

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(req, res, 200, { status: "ok" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/onboarding/status") {
    sendJson(req, res, 200, { complete: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/onboarding/options") {
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
    sendJson(req, res, 200, { onboardingComplete: true, status: "running" });
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

  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(req, res, 200, {
      cloud: { enabled: false },
      media: {},
      plugins: { entries: {} },
      ui: {},
      wallet: {},
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
      const text =
        "This is a stubbed QA response. The app surface is loaded and interactive.";
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
      const text =
        "This is a stubbed QA response. The app surface is loaded and interactive.";
      appendStubMessage(conversationId, createStubMessage("assistant", text));
      sendJson(req, res, 200, { text, agentName: "Eliza" });
      return;
    }
  }

  const conversationMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
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

  if (req.method === "GET" && url.pathname === "/api/wallet/addresses") {
    sendJson(req, res, 200, { evmAddress: null, solanaAddress: null });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/wallet/config") {
    sendJson(req, res, 200, emptyWalletConfig);
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

  if (req.method === "GET" && url.pathname === "/api/logs") {
    sendJson(req, res, 200, stubLogsResponse);
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

  if (url.pathname.startsWith("/api/")) {
    if (req.method === "HEAD") {
      sendEmpty(req, res, 200);
      return;
    }
    if (req.method === "GET") {
      sendJson(req, res, 200, {});
      return;
    }
    sendJson(req, res, 200, { ok: true });
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
    void shutdown();
  });
}
