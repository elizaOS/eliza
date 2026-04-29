import type http from "node:http";
import {
  type BackendStatus,
  createManager,
  type ManagerPreferences,
  type SecretsManager,
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
 * Per-process singleton. Two concurrent PUT requests must serialise
 * through the same `VaultImpl` mutex; a per-request `createManager()`
 * would yield independent in-process locks pointing at the same disk
 * file, racing each other on the read-modify-write cycle. Tests that
 * need a fresh manager (e.g. tmpdir vault per case) call
 * `_resetSecretsManagerForTesting()` between cases.
 */
let _manager: SecretsManager | null = null;

function getManager(): SecretsManager {
  if (!_manager) _manager = createManager();
  return _manager;
}

/** Test hook: drop the cached manager. Production code must not call this. */
export function _resetSecretsManagerForTesting(): void {
  _manager = null;
}

export async function handleSecretsManagerRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
): Promise<boolean> {
  if (!pathname.startsWith("/api/secrets/manager")) return false;
  const manager = getManager();

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
