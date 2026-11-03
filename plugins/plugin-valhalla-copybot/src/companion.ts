import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { brainFor } from "./brain.ts";
import { refusesUnsafe } from "./chat.ts";
import { connectionView } from "./connection-routes.ts";
import { pnlView, stateView } from "./desk-view.ts";
import type { AgentEngine } from "./engine.ts";
import { tail4 } from "./net.ts";
import { parseSettings, type UserSettings } from "./user-settings.ts";

const PAIR_TTL_MS = 12 * 60 * 60 * 1000;
const pairs = new Map<string, number>();

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function issuePairToken(now = Date.now()): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now + PAIR_TTL_MS;
  pairs.set(token, expiresAt);
  return { token, expiresAt };
}

export function readPairToken(token: string, now = Date.now()): "ok" | "expired" | "missing" {
  const expiresAt = pairs.get(token);
  if (expiresAt == null) return "missing";
  if (expiresAt <= now) {
    pairs.delete(token);
    return "expired";
  }
  return "ok";
}

export function expirePairTokenForTests(token: string): void {
  pairs.set(token, 0);
}

export function isLoopback(address: string | undefined): boolean {
  const host = address ?? "";
  return host === "127.0.0.1" || host === "::1" || host === "::ffff:127.0.0.1";
}

/** The phone may call only the companion API. Wallet and transfer routes stay on the PC. */
export function phoneMayCall(pathname: string): boolean {
  if (/send|withdraw|transfer|sweep/i.test(pathname)) return false;
  return pathname.startsWith("/api/companion/");
}

export function phoneState(engine: AgentEngine): Record<string, unknown> {
  const state = stateView(engine);
  const pnl = pnlView(engine);
  return {
    status: engine.statusLine(),
    pnl: engine.pnlLine(),
    positions: engine.positionsLine(),
    running: state.running,
    readOnly: state.readOnly,
    buysPaused: state.buysPaused,
    live: state.live,
    equityUsd: state.equityUsd,
    equitySol: state.equitySol,
    tradingPnlUsd: pnl.tradingPnlUsd,
    wins: pnl.wins,
    losses: pnl.losses,
    openCount: engine.book.positions.length,
    wallet: tail4(engine.activePubkey()),
    connections: connectionView(engine).map((row) => ({
      label: row.label,
      state: row.state,
      ok: row.lastOk,
    })),
    health: engine.healthNow(),
    brain: brainFor(engine.dataDir).view(),
    repair: engine.repairLog.events[0] ?? null,
    settings: engine.settings,
    pendingSettings: engine.pendingSettings != null,
  };
}

export function suggestionFromText(
  text: string,
  current: UserSettings
): { settings: UserSettings } | { error: string } | null {
  if (refusesUnsafe(text)) return null;
  const lower = text.toLowerCase();
  if (!/setting|tweak|safer|smaller|larger|preset|stop|size|hold/.test(lower)) return null;
  let patch: Record<string, unknown> = {};
  if (/safer|safe preset|more safe/.test(lower)) patch = { preset: "safe" };
  else if (/aggressive/.test(lower)) patch = { preset: "aggressive" };
  else if (/balanced/.test(lower)) patch = { preset: "balanced" };
  else if (/smaller|reduce size|lower size/.test(lower)) {
    patch = { ticketMaxSol: Math.max(0.0125, current.ticketMaxSol / 2) };
  } else {
    return null;
  }
  const parsed = parseSettings({ ...current, ...patch }, current);
  if ("ok" in parsed) return { error: parsed.errors.join(" ") };
  return { settings: parsed };
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? "";
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk);
    size += buf.length;
    if (size > 20_000) throw new Error("body too large");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

export async function companionResponse(
  engine: AgentEngine,
  req: IncomingMessage,
  pathname: string,
  accessCode: string
): Promise<{ status: number; body: unknown }> {
  try {
    if (req.method === "POST" && pathname === "/api/companion/pair") {
      const body = await readJson(req);
      if (accessCode && !same(String(body.accessCode ?? ""), accessCode)) {
        return {
          status: 401,
          body: { ok: false, error: "Wrong access code.", tokenExpired: false },
        };
      }
      const issued = issuePairToken();
      return { status: 200, body: { ok: true, ...issued } };
    }
    const state = readPairToken(bearer(req));
    if (state !== "ok") {
      return {
        status: 401,
        body: {
          ok: false,
          error: "Pair again.",
          tokenExpired: state === "expired",
        },
      };
    }
    if (req.method === "GET" && pathname === "/api/companion/heartbeat") {
      return {
        status: 200,
        body: { ok: true, ...engine.heartbeat(), state: phoneState(engine) },
      };
    }
    if (req.method === "GET" && pathname === "/api/companion/state") {
      return { status: 200, body: { ok: true, state: phoneState(engine) } };
    }
    if (req.method === "POST" && pathname === "/api/companion/recover") {
      const result = engine.recoverFromPhone();
      return { status: 200, body: { ok: true, ...result } };
    }
    if (req.method === "POST" && pathname === "/api/companion/chat") {
      const body = await readJson(req);
      const text = String(body.text ?? "");
      const message = await engine.chat(text);
      const suggestion = suggestionFromText(text, engine.settings);
      if (!suggestion) return { status: 200, body: { ok: true, message, suggestion: null } };
      if ("error" in suggestion) {
        return {
          status: 200,
          body: { ok: true, message, suggestion: null, suggestionError: suggestion.error },
        };
      }
      return { status: 200, body: { ok: true, message, suggestion: suggestion.settings } };
    }
    if (req.method === "POST" && pathname === "/api/companion/settings") {
      const body = await readJson(req);
      if (body.confirm !== true) {
        return {
          status: 400,
          body: {
            ok: false,
            error: "Confirm the change on the phone.",
            settings: engine.settings,
          },
        };
      }
      const saved = await engine.saveSettings(body.settings, false);
      return { status: saved.ok ? 200 : 400, body: saved };
    }
    return { status: 404, body: { ok: false, error: "Unknown companion action." } };
  } catch (err) {
    return {
      status: 400,
      body: { ok: false, error: err instanceof Error ? err.message : "request failed" },
    };
  }
}
