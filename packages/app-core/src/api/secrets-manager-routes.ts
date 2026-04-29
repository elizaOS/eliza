import type http from "node:http";
import {
  type BackendStatus,
  createManager,
  type ManagerPreferences,
} from "@elizaos/vault";
import { sendJson, sendJsonError } from "./response";

/**
 * Routes that drive the Settings → Secrets Manager UI.
 *
 *   GET /api/secrets/manager/preferences  → ManagerPreferences
 *   PUT /api/secrets/manager/preferences  → save ManagerPreferences
 *   GET /api/secrets/manager/backends     → BackendStatus[]
 *
 * The manager wraps `@elizaos/vault` and routes sensitive writes to
 * the user's chosen password manager (1Password / Proton / Bitwarden)
 * with `in-house` always available as the fallback.
 *
 * Each request constructs a fresh manager. Manager construction is
 * cheap (no I/O in constructor; lazy-loads on first use); a per-
 * process cache here would buy a few ms per request at the cost of
 * needing a test-only reset hook to avoid leaking state across
 * tests in the same process. Not worth it for a Settings route that
 * fires only when the user opens the modal.
 */

export async function handleSecretsManagerRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
): Promise<boolean> {
  if (!pathname.startsWith("/api/secrets/manager")) return false;
  const manager = createManager();

  if (method === "GET" && pathname === "/api/secrets/manager/backends") {
    const statuses = await manager.detectBackends();
    sendJson(res, 200, { ok: true, backends: statuses as BackendStatus[] });
    return true;
  }

  if (method === "GET" && pathname === "/api/secrets/manager/preferences") {
    const preferences = await manager.getPreferences();
    sendJson(res, 200, { ok: true, preferences });
    return true;
  }

  if (method === "PUT" && pathname === "/api/secrets/manager/preferences") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      sendJsonError(res, 400, "invalid JSON body");
      return true;
    }
    const prefs = (parsed as { preferences?: ManagerPreferences }).preferences;
    if (!prefs || typeof prefs !== "object") {
      sendJsonError(res, 400, "missing `preferences` field");
      return true;
    }
    await manager.setPreferences(prefs);
    const saved = await manager.getPreferences();
    sendJson(res, 200, { ok: true, preferences: saved });
    return true;
  }

  return false;
}
