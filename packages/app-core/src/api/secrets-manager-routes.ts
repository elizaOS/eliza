import type http from "node:http";
import {
  type BackendId,
  type BackendStatus,
  createManager,
  deleteSavedLogin,
  getAutofillAllowed,
  getSavedLogin,
  type InstallMethod,
  type ManagerPreferences,
  resolveRunnableMethods,
  type SecretsManager,
  setAutofillAllowed,
  setSavedLogin,
  type UnifiedLoginListEntry,
  type UnifiedLoginListResult,
  type UnifiedLoginReveal,
} from "@elizaos/vault";
import {
  _resetSecretsManagerInstallerForTesting,
  getSecretsManagerInstaller,
  type InstallableBackendId,
  type InstallJobEvent,
  type SecretsManagerInstaller,
  type SigninRequest,
} from "../services/secrets-manager-installer";
import { sharedVault } from "../services/vault-mirror";
import { sendJson, sendJsonError } from "./response";

/**
 * Routes that drive the Settings → Secrets Manager UI.
 *
 *   GET  /api/secrets/manager/preferences      → ManagerPreferences
 *   PUT  /api/secrets/manager/preferences      → save ManagerPreferences
 *   GET  /api/secrets/manager/backends         → BackendStatus[]
 *
 *   GET  /api/secrets/manager/install/methods  → per-backend, per-OS install methods
 *   POST /api/secrets/manager/install          → start install job → { jobId }
 *   GET  /api/secrets/manager/install/:jobId   → SSE stream of install events
 *
 *   POST /api/secrets/manager/signin           → run vendor signin, persist session
 *   POST /api/secrets/manager/signout          → drop persisted session
 *
 * Saved-login routes (in-app browser autofill):
 *
 *   GET    /api/secrets/logins                 → UnifiedLoginListEntry[] (no passwords)
 *                                                Aggregates in-house, 1Password, Bitwarden
 *   GET    /api/secrets/logins?domain=...      → filtered to one domain
 *   GET    /api/secrets/logins/reveal?source=...&identifier=...
 *                                              → reveal a single login (sensitive)
 *   POST   /api/secrets/logins                 → save / replace (in-house ONLY)
 *   DELETE /api/secrets/logins/:domain/:user   → remove (in-house ONLY)
 *   GET    /api/secrets/logins/:domain/autoallow  → boolean
 *   PUT    /api/secrets/logins/:domain/autoallow  → set boolean
 *
 * Why is CREATE in-house only? `op item create` and `bw create item` work
 * but require a vault path / folder id and structured field metadata that
 * a generic POST can't safely synthesize for the user. Adding an external
 * item is deferred to a future iteration with vendor-specific UI.
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
  if (!_manager) {
    // Reuse the shared vault: the saved-logins handlers in this file
    // (POST / autoallow / DELETE) write through `sharedVault()`, and
    // the manager's `listAllSavedLogins` must read the same `vault.json`
    // — separate vaults would silently disagree. The shared vault is
    // also where `mirrorPluginSensitiveToVault` writes plugin secrets,
    // so the manager's mutex chain stays unified.
    _manager = createManager({ vault: sharedVault() });
  }
  return _manager;
}

function getInstaller(): SecretsManagerInstaller {
  return getSecretsManagerInstaller(getManager());
}

/** Test hook: drop the cached manager. Production code must not call this. */
export function _resetSecretsManagerForTesting(): void {
  _manager = null;
  _resetSecretsManagerInstallerForTesting();
}

/** Test hook: inject a manager built around a test vault + stub exec. */
export function _setSecretsManagerForTesting(
  next: SecretsManager | null,
): void {
  _manager = next;
  _resetSecretsManagerInstallerForTesting();
}

const INSTALLABLE_BACKENDS: readonly InstallableBackendId[] = [
  "1password",
  "bitwarden",
  "protonpass",
];

function isInstallableBackend(value: unknown): value is InstallableBackendId {
  return (
    typeof value === "string" &&
    (INSTALLABLE_BACKENDS as readonly string[]).includes(value)
  );
}

export async function handleSecretsManagerRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
): Promise<boolean> {
  if (
    !pathname.startsWith("/api/secrets/manager") &&
    !pathname.startsWith("/api/secrets/logins")
  ) {
    return false;
  }

  const manager = getManager();

  if (pathname.startsWith("/api/secrets/logins")) {
    return handleSavedLoginsRoute(req, res, pathname, method, manager);
  }

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

  // ── Install methods discovery ─────────────────────────────────────
  if (method === "GET" && pathname === "/api/secrets/manager/install/methods") {
    const out: Record<InstallableBackendId, readonly InstallMethod[]> = {
      "1password": [],
      bitwarden: [],
      protonpass: [],
    };
    for (const id of INSTALLABLE_BACKENDS) {
      out[id] = await resolveRunnableMethods(id);
    }
    sendJson(res, 200, { ok: true, methods: out });
    return true;
  }

  // ── Start install job ─────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/secrets/manager/install") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      sendJsonError(res, 400, "invalid JSON body");
      return true;
    }
    const { backendId, method: rawMethod } = parsed as {
      backendId?: unknown;
      method?: unknown;
    };
    if (!isInstallableBackend(backendId)) {
      sendJsonError(
        res,
        400,
        `invalid \`backendId\`; expected one of ${INSTALLABLE_BACKENDS.join(", ")}`,
      );
      return true;
    }
    if (!isInstallMethodPayload(rawMethod)) {
      sendJsonError(res, 400, "invalid `method` payload");
      return true;
    }
    if (rawMethod.kind === "manual") {
      sendJsonError(
        res,
        400,
        "manual install methods cannot be automated; open the docs URL instead",
      );
      return true;
    }
    // Verify the method is actually one of the runnable ones for this host
    // — prevents a UI bug or stale cache from invoking `npm` on a host
    // without npm.
    const allowed = await resolveRunnableMethods(backendId);
    const matched = allowed.find((m) => methodMatches(m, rawMethod));
    if (!matched) {
      sendJsonError(
        res,
        400,
        `install method ${rawMethod.kind}:${(rawMethod as { package?: string }).package ?? ""} is not available on this host`,
      );
      return true;
    }
    const installer = getInstaller();
    const snapshot = installer.startInstall(backendId, matched);
    sendJson(res, 202, { ok: true, jobId: snapshot.id });
    return true;
  }

  // ── SSE stream for one install job ────────────────────────────────
  const sseMatch = pathname.match(
    /^\/api\/secrets\/manager\/install\/([0-9a-f-]{36})$/,
  );
  if (method === "GET" && sseMatch) {
    const jobId = sseMatch[1];
    if (!jobId) {
      sendJsonError(res, 400, "missing job id");
      return true;
    }
    const installer = getInstaller();
    const snapshot = installer.getJob(jobId);
    if (!snapshot) {
      sendJsonError(res, 404, "unknown job id");
      return true;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 15_000);
    if (typeof heartbeat === "object" && "unref" in heartbeat) {
      heartbeat.unref();
    }

    const writeEvent = (event: InstallJobEvent) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === "done" || event.type === "error") {
        // Terminal event — close the stream so the client knows we're done.
        clearInterval(heartbeat);
        res.end();
      }
    };

    const unsubscribe = installer.subscribeJob(jobId, writeEvent);
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);
    req.on("aborted", cleanup);
    return true;
  }

  // ── Signin (non-streaming; runs to completion in one POST) ────────
  if (method === "POST" && pathname === "/api/secrets/manager/signin") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      sendJsonError(res, 400, "invalid JSON body");
      return true;
    }
    const request = parsed as Partial<SigninRequest> & { backendId?: unknown };
    if (!isInstallableBackend(request.backendId)) {
      sendJsonError(res, 400, "invalid `backendId`");
      return true;
    }
    if (typeof request.masterPassword !== "string" || !request.masterPassword) {
      sendJsonError(res, 400, "missing `masterPassword`");
      return true;
    }
    const installer = getInstaller();
    try {
      const result = await installer.signIn({
        backendId: request.backendId,
        masterPassword: request.masterPassword,
        ...(request.email ? { email: request.email } : {}),
        ...(request.secretKey ? { secretKey: request.secretKey } : {}),
        ...(request.signInAddress
          ? { signInAddress: request.signInAddress }
          : {}),
        ...(request.bitwardenClientId
          ? { bitwardenClientId: request.bitwardenClientId }
          : {}),
        ...(request.bitwardenClientSecret
          ? { bitwardenClientSecret: request.bitwardenClientSecret }
          : {}),
      });
      sendJson(res, 200, { ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "sign-in failed";
      sendJsonError(res, 400, message);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/secrets/manager/signout") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      sendJsonError(res, 400, "invalid JSON body");
      return true;
    }
    const id = (parsed as { backendId?: unknown }).backendId;
    if (!isInstallableBackend(id)) {
      sendJsonError(res, 400, "invalid `backendId`");
      return true;
    }
    const installer = getInstaller();
    await installer.signOut(id);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

// ── Saved-logins (in-app browser autofill) ────────────────────────

const LOGIN_PATH_RE = /^\/api\/secrets\/logins\/([^/]+)\/([^/]+)$/;
const LOGIN_AUTOALLOW_RE = /^\/api\/secrets\/logins\/([^/]+)\/autoallow$/;

function isUnifiedSource(
  v: unknown,
): v is "in-house" | "1password" | "bitwarden" {
  return v === "in-house" || v === "1password" || v === "bitwarden";
}

async function handleSavedLoginsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  manager: SecretsManager,
): Promise<boolean> {
  const vault = sharedVault();

  if (method === "GET" && pathname === "/api/secrets/logins") {
    const url = new URL(req.url ?? "", "http://localhost");
    const domain = url.searchParams.get("domain") ?? undefined;
    // The manager handles in-house vs external. Per-backend errors are
    // collected into `failures` so the UI can render a small warning row
    // without losing the entries that succeeded.
    const result: UnifiedLoginListResult = await manager.listAllSavedLogins(
      domain ? { domain } : {},
    );
    sendJson(res, 200, {
      ok: true,
      logins: result.logins as readonly UnifiedLoginListEntry[],
      failures: result.failures,
    });
    return true;
  }

  // Unified reveal endpoint. Replaces the legacy
  // `GET /api/secrets/logins/:domain/:user` which only knew about
  // in-house entries.
  if (method === "GET" && pathname === "/api/secrets/logins/reveal") {
    const url = new URL(req.url ?? "", "http://localhost");
    const source = url.searchParams.get("source");
    const identifier = url.searchParams.get("identifier");
    if (!isUnifiedSource(source)) {
      sendJsonError(
        res,
        400,
        "`source` must be one of: in-house, 1password, bitwarden",
      );
      return true;
    }
    if (!identifier) {
      sendJsonError(res, 400, "`identifier` is required");
      return true;
    }
    try {
      const reveal: UnifiedLoginReveal = await manager.revealSavedLogin(
        source,
        identifier,
      );
      sendJson(res, 200, { ok: true, login: reveal });
    } catch (err) {
      const message = err instanceof Error ? err.message : "reveal failed";
      sendJsonError(res, 404, message);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/secrets/logins") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      sendJsonError(res, 400, "invalid JSON body");
      return true;
    }
    const p = parsed as {
      domain?: unknown;
      username?: unknown;
      password?: unknown;
      otpSeed?: unknown;
      notes?: unknown;
    };
    if (typeof p.domain !== "string" || p.domain.trim().length === 0) {
      sendJsonError(res, 400, "`domain` is required");
      return true;
    }
    if (typeof p.username !== "string" || p.username.length === 0) {
      sendJsonError(res, 400, "`username` is required");
      return true;
    }
    if (typeof p.password !== "string" || p.password.length === 0) {
      sendJsonError(res, 400, "`password` is required");
      return true;
    }
    if (p.otpSeed !== undefined && typeof p.otpSeed !== "string") {
      sendJsonError(res, 400, "`otpSeed` must be a string when provided");
      return true;
    }
    if (p.notes !== undefined && typeof p.notes !== "string") {
      sendJsonError(res, 400, "`notes` must be a string when provided");
      return true;
    }
    await setSavedLogin(vault, {
      domain: p.domain,
      username: p.username,
      password: p.password,
      ...(typeof p.otpSeed === "string" ? { otpSeed: p.otpSeed } : {}),
      ...(typeof p.notes === "string" ? { notes: p.notes } : {}),
    });
    sendJson(res, 200, { ok: true });
    return true;
  }

  const autoallowMatch = pathname.match(LOGIN_AUTOALLOW_RE);
  if (autoallowMatch) {
    const rawDomain = autoallowMatch[1];
    if (!rawDomain) {
      sendJsonError(res, 400, "missing domain");
      return true;
    }
    const domain = decodeURIComponent(rawDomain);
    if (method === "GET") {
      const allowed = await getAutofillAllowed(vault, domain);
      sendJson(res, 200, { ok: true, allowed });
      return true;
    }
    if (method === "PUT") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        sendJsonError(res, 400, "invalid JSON body");
        return true;
      }
      const allowed = (parsed as { allowed?: unknown }).allowed;
      if (typeof allowed !== "boolean") {
        sendJsonError(res, 400, "`allowed` must be boolean");
        return true;
      }
      await setAutofillAllowed(vault, domain, allowed);
      sendJson(res, 200, { ok: true, allowed });
      return true;
    }
  }

  const match = pathname.match(LOGIN_PATH_RE);
  if (match) {
    const rawDomain = match[1];
    const rawUser = match[2];
    if (!rawDomain || !rawUser) {
      sendJsonError(res, 400, "missing path segment");
      return true;
    }
    const domain = decodeURIComponent(rawDomain);
    const username = decodeURIComponent(rawUser);

    if (method === "GET") {
      const login = await getSavedLogin(vault, domain, username);
      if (!login) {
        sendJsonError(res, 404, "no saved login for domain/username");
        return true;
      }
      sendJson(res, 200, { ok: true, login });
      return true;
    }

    if (method === "DELETE") {
      await deleteSavedLogin(vault, domain, username);
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  return false;
}

// ── Helpers ────────────────────────────────────────────────────────

function isInstallMethodPayload(value: unknown): value is InstallMethod {
  if (!value || typeof value !== "object") return false;
  const v = value as { kind?: unknown };
  if (v.kind === "brew") {
    const m = value as { kind: "brew"; package?: unknown; cask?: unknown };
    return typeof m.package === "string" && typeof m.cask === "boolean";
  }
  if (v.kind === "npm") {
    const m = value as { kind: "npm"; package?: unknown };
    return typeof m.package === "string";
  }
  if (v.kind === "manual") {
    const m = value as {
      kind: "manual";
      url?: unknown;
      instructions?: unknown;
    };
    return typeof m.url === "string" && typeof m.instructions === "string";
  }
  return false;
}

function methodMatches(a: InstallMethod, b: InstallMethod): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "brew" && b.kind === "brew") {
    return a.package === b.package && a.cask === b.cask;
  }
  if (a.kind === "npm" && b.kind === "npm") {
    return a.package === b.package;
  }
  if (a.kind === "manual" && b.kind === "manual") {
    return a.url === b.url;
  }
  return false;
}

// Re-export so callers (server.ts) keep importing one symbol.
export type { BackendId };
