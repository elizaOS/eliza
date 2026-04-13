import http from "node:http";
import { WebSocketServer } from "ws";

const port = Number(process.env.ELIZA_UI_SMOKE_API_PORT || "31337");

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
    sendJson(req, res, 200, { plugins: [] });
    return;
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
