import http from "node:http";
import { WebSocketServer } from "ws";

const port = Number(process.env.ELIZA_UI_SMOKE_API_PORT || "31337");
let browserWorkspaceCounter = 0;
let browserWorkspaceTabs = [];

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

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

  if (req.method === "HEAD" && url.pathname === "/api/avatar/vrm") {
    sendEmpty(req, res, 404);
    return;
  }

  if (req.method === "HEAD" && url.pathname === "/api/avatar/background") {
    sendEmpty(req, res, 404);
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

  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    sendJson(req, res, 200, {
      required: false,
      pairingEnabled: false,
      expiresAt: null,
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
    sendJson(req, res, 200, { connected: false, connectedAt: null });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/conversations") {
    sendJson(req, res, 200, { conversations: [] });
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
    sendJson(req, res, 200, { character: {}, agentName: "Chen" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/wallet/addresses") {
    sendJson(req, res, 200, { evmAddress: null, solanaAddress: null });
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
    sendJson(req, res, 200, {
      available: false,
      tasks: [],
      routines: [],
      habits: [],
      trajectories: [],
    });
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

  if (
    req.method === "POST" &&
    url.pathname === "/api/lifeops/activity-signals"
  ) {
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/apps") {
    sendJson(req, res, 200, []);
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

  if (req.method === "GET" && url.pathname.startsWith("/api/apps/info/")) {
    sendJson(req, res, 404, { error: "App not found" });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/apps/search")) {
    sendJson(req, res, 200, []);
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
