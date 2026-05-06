import type { ServerWebSocket } from "bun";
import type { BotAction, BotWorldState, SDKActionAck } from "./types.js";

// ── Public interface ────────────────────────────────────────────────

export interface GatewayOptions {
  port: number;
  hostname?: string;
  onLog?: (message: string) => void;
}

export interface GatewayHandle {
  port: number;
  stop(): void;
}

// ── Internal types ──────────────────────────────────────────────────

interface WsData {
  kind: "bot" | "sdk";
  username: string;
}

type GatewayWs = ServerWebSocket<WsData>;

interface BotStateMessage {
  type: "sdk_state";
  state: BotWorldState;
}

interface SDKActionMessage {
  type: "sdk_action";
  action: BotAction;
  id: string;
}

interface SDKActionAckMessage {
  type: "sdk_action_ack";
  id: string;
  success: boolean;
  message?: string;
}

type InboundMessage = BotStateMessage | SDKActionMessage | SDKActionAckMessage;

// ── Gateway ─────────────────────────────────────────────────────────

export function startGateway(options: GatewayOptions): GatewayHandle {
  const { port, hostname, onLog } = options;
  const log = onLog ?? (() => {});

  // Session maps — one connection per username per role
  const botSessions = new Map<string, GatewayWs>();
  const sdkSessions = new Map<string, GatewayWs>();
  const latestState = new Map<string, BotWorldState>();

  // ── Helpers ─────────────────────────────────────────────────────

  function parseRoute(
    url: string,
  ): { kind: "bot" | "sdk"; username: string } | null {
    try {
      const parsed = new URL(url, "http://localhost");
      const path = parsed.pathname;
      const username = parsed.searchParams.get("username");
      if (!username) return null;

      if (path === "/ws") return { kind: "bot", username };
      if (path === "/sdk") return { kind: "sdk", username };
      return null;
    } catch {
      return null;
    }
  }

  function removeSession(ws: GatewayWs): void {
    const { kind, username } = ws.data;
    const map = kind === "bot" ? botSessions : sdkSessions;
    // Only remove if this ws is still the current session for the username
    if (map.get(username) === ws) {
      map.delete(username);
      log(`[gateway] ${kind} disconnected: ${username}`);
    }
  }

  function handleTakeover(kind: "bot" | "sdk", username: string): void {
    const map = kind === "bot" ? botSessions : sdkSessions;
    const existing = map.get(username);
    if (existing) {
      log(
        `[gateway] ${kind} session takeover for ${username} — closing old connection`,
      );
      try {
        existing.close(4000, "session takeover");
      } catch {
        // already closed
      }
      map.delete(username);
    }
  }

  // ── HTTP handler ────────────────────────────────────────────────

  function handleHTTP(req: Request): Response | undefined {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (path === "/health") {
      return Response.json({ ok: true });
    }

    if (path === "/status") {
      return Response.json({
        bots: [...botSessions.keys()],
        sdks: [...sdkSessions.keys()],
      });
    }

    // /status/:username
    const statusMatch = path.match(/^\/status\/(.+)$/);
    if (statusMatch) {
      const username = decodeURIComponent(statusMatch[1]);
      const botConnected = botSessions.has(username);
      const sdkConnected = sdkSessions.has(username);
      const state = latestState.get(username);

      let stateSummary: Record<string, unknown> | null = null;
      if (state) {
        const player = state.player;
        stateSummary = {
          position: player
            ? { x: player.worldX, z: player.worldZ, level: player.level }
            : null,
          health: player ? { hp: player.hp, maxHp: player.maxHp } : null,
          combat: player
            ? {
                level: player.combatLevel,
                inCombat: player.inCombat,
                target: player.combatTarget,
              }
            : null,
          skills: state.skills ? state.skills.length : 0,
        };
      }

      return Response.json({
        username,
        botConnected,
        sdkConnected,
        hasState: state !== undefined,
        stateSummary,
      });
    }

    return undefined; // not an HTTP route we handle
  }

  // ── Message routing ─────────────────────────────────────────────

  function routeMessage(ws: GatewayWs, raw: string): void {
    const { kind, username } = ws.data;

    let msg: InboundMessage;
    try {
      msg = JSON.parse(raw) as InboundMessage;
    } catch {
      log(`[gateway] invalid JSON from ${kind}/${username}`);
      return;
    }

    if (kind === "bot") {
      // Bot client sends state updates
      if (msg.type === "sdk_state") {
        const stateMsg = msg as BotStateMessage;
        latestState.set(username, stateMsg.state);

        // Forward to matching SDK session
        const sdkWs = sdkSessions.get(username);
        if (sdkWs) {
          sdkWs.send(raw);
        }
        return;
      }

      // Bot client sends action acks
      if (msg.type === "sdk_action_ack") {
        const sdkWs = sdkSessions.get(username);
        if (sdkWs) {
          sdkWs.send(raw);
        }
        return;
      }

      log(`[gateway] unknown message type from bot/${username}: ${msg.type}`);
      return;
    }

    if (kind === "sdk") {
      // SDK sends actions
      if (msg.type === "sdk_action") {
        const botWs = botSessions.get(username);
        if (botWs) {
          botWs.send(raw);
        } else {
          // No bot client connected — send back a failure ack
          const ack: SDKActionAckMessage = {
            type: "sdk_action_ack",
            id: (msg as SDKActionMessage).id,
            success: false,
            message: "No bot client connected",
          };
          ws.send(JSON.stringify(ack));
        }
        return;
      }

      log(`[gateway] unknown message type from sdk/${username}: ${msg.type}`);
      return;
    }
  }

  // ── Server ──────────────────────────────────────────────────────

  const server = Bun.serve<WsData>({
    port,
    hostname: hostname ?? "0.0.0.0",

    fetch(req, server) {
      // Try WebSocket upgrade first
      const route = parseRoute(req.url);
      if (route) {
        const upgraded = server.upgrade(req, {
          data: { kind: route.kind, username: route.username },
        });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      // Fall through to HTTP
      const httpResponse = handleHTTP(req);
      if (httpResponse) return httpResponse;

      return new Response("Not found", { status: 404 });
    },

    websocket: {
      open(ws: GatewayWs) {
        const { kind, username } = ws.data;

        // Handle session takeover
        handleTakeover(kind, username);

        // Register
        const map = kind === "bot" ? botSessions : sdkSessions;
        map.set(username, ws);
        log(`[gateway] ${kind} connected: ${username}`);

        // If this is an SDK connecting and we have cached state, send it
        if (kind === "sdk") {
          const cachedState = latestState.get(username);
          if (cachedState) {
            const msg: BotStateMessage = {
              type: "sdk_state",
              state: cachedState,
            };
            ws.send(JSON.stringify(msg));
            log(`[gateway] sent cached state to sdk/${username}`);
          }
        }
      },

      message(ws: GatewayWs, message: string | Buffer) {
        const raw = typeof message === "string" ? message : message.toString();
        routeMessage(ws, raw);
      },

      close(ws: GatewayWs) {
        removeSession(ws);
      },

      drain(_ws: GatewayWs) {
        // backpressure relieved — no-op for now
      },
    },
  });

  const actualPort = server.port ?? port;
  log(`[gateway] listening on ${hostname ?? "0.0.0.0"}:${actualPort}`);

  return {
    port: actualPort,
    stop() {
      server.stop(true);
      botSessions.clear();
      sdkSessions.clear();
      latestState.clear();
      log("[gateway] stopped");
    },
  };
}
