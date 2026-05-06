/**
 * codex-auth — load, refresh, and atomically save the chatgpt CLI's
 * `~/.codex/auth.json` file. Used by the codex stealth reasoning backend.
 *
 * Refresh races between concurrent processes (e.g. Sol + nyx both noticing
 * an expired access_token at the same time) are guarded by an OS-level
 * lock file: `<auth-path>.lock`, created with O_CREAT|O_EXCL via
 * `fs.open(..., "wx")`. Stale locks (>30s old) are forcibly broken so a
 * crashed process can't deadlock the world.
 *
 * Saves are atomic: write to `<auth-path>.tmp.<pid>.<rand>` then `rename`.
 */

import { randomBytes } from "node:crypto";
import {
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_DELAY_MS = 100;
const LOCK_RETRY_MAX = 30;

export interface CodexAuth {
  OPENAI_API_KEY: string | null;
  auth_mode: "chatgpt" | "apikey";
  last_refresh: string;
  tokens: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id: string;
  };
}

// Allow tests to inject a fetch / clock without touching the global.
export interface CodexAuthDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

let injectedDeps: CodexAuthDeps = {};

export function __setCodexAuthDeps(deps: CodexAuthDeps): void {
  injectedDeps = deps;
}

export function __resetCodexAuthDeps(): void {
  injectedDeps = {};
}

function getFetch(): typeof fetch {
  return injectedDeps.fetch ?? fetch;
}

function nowMs(): number {
  return injectedDeps.now ? injectedDeps.now() : Date.now();
}

export function defaultAuthPath(): string {
  return join(homedir(), ".codex", "auth.json");
}

export async function loadCodexAuth(path?: string): Promise<CodexAuth> {
  const p = path ?? defaultAuthPath();
  const raw = await readFile(p, "utf8");
  const parsed = JSON.parse(raw) as Partial<CodexAuth>;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !parsed.tokens ||
    typeof parsed.tokens.access_token !== "string" ||
    typeof parsed.tokens.refresh_token !== "string" ||
    typeof parsed.tokens.id_token !== "string" ||
    typeof parsed.tokens.account_id !== "string"
  ) {
    throw new Error(`codex auth.json malformed at ${p}: missing tokens fields`);
  }
  return {
    OPENAI_API_KEY: parsed.OPENAI_API_KEY ?? null,
    auth_mode: parsed.auth_mode === "apikey" ? "apikey" : "chatgpt",
    last_refresh: parsed.last_refresh ?? new Date(0).toISOString(),
    tokens: {
      id_token: parsed.tokens.id_token,
      access_token: parsed.tokens.access_token,
      refresh_token: parsed.tokens.refresh_token,
      account_id: parsed.tokens.account_id,
    },
  };
}

/**
 * Atomic write: writes to `<path>.tmp.<pid>.<rand>` then renames over the
 * destination. `rename` is atomic on POSIX, so any concurrent reader sees
 * either the old contents or the new — never a partial file.
 */
export async function saveCodexAuth(
  auth: CodexAuth,
  path: string,
): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  const body = `${JSON.stringify(auth, null, 2)}\n`;
  await writeFile(tmp, body, { mode: 0o600 });
  try {
    await rename(tmp, path);
  } catch (err) {
    // best-effort cleanup if rename fails
    try {
      await unlink(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Decode a JWT's payload (no signature verification — we only need `exp`).
 * Returns null if the token isn't a valid JWT shape.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payloadPart = parts[1];
  if (!payloadPart) return null;
  // base64url → base64
  const b64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  try {
    const json = Buffer.from(b64 + pad, "base64").toString("utf8");
    const obj = JSON.parse(json) as Record<string, unknown>;
    return obj;
  } catch {
    return null;
  }
}

/**
 * True if `tokens.access_token` is past its `exp` claim (or within
 * `bufferSeconds` of it). If the token can't be decoded we treat it as
 * expired so refresh fires defensively.
 */
export function isExpired(auth: CodexAuth, bufferSeconds = 60): boolean {
  const payload = decodeJwtPayload(auth.tokens.access_token);
  if (!payload) return true;
  const exp = payload.exp;
  if (typeof exp !== "number") return true;
  const expMs = exp * 1000;
  return nowMs() + bufferSeconds * 1000 >= expMs;
}

// ---------------------------------------------------------------------------
// Lock acquisition
// ---------------------------------------------------------------------------

interface AcquiredLock {
  path: string;
  release: () => Promise<void>;
}

async function tryCreateLock(lockPath: string): Promise<AcquiredLock | null> {
  try {
    const fh = await open(lockPath, "wx", 0o600);
    try {
      await fh.writeFile(`${process.pid}\n`);
    } finally {
      await fh.close();
    }
    return {
      path: lockPath,
      release: async () => {
        try {
          await unlink(lockPath);
        } catch {
          /* lock already gone — ignore */
        }
      },
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return null;
    throw err;
  }
}

async function isLockStale(lockPath: string): Promise<boolean> {
  try {
    const st = await stat(lockPath);
    const age = nowMs() - st.mtimeMs;
    return age > LOCK_STALE_MS;
  } catch {
    // vanished — not stale, just gone
    return false;
  }
}

async function acquireLock(authPath: string): Promise<AcquiredLock> {
  const lockPath = `${authPath}.lock`;
  for (let attempt = 0; attempt < LOCK_RETRY_MAX; attempt++) {
    const lock = await tryCreateLock(lockPath);
    if (lock) return lock;

    // Existing lock — break it if it's stale.
    if (await isLockStale(lockPath)) {
      try {
        await unlink(lockPath);
      } catch {
        /* race with another reaper — try again */
      }
      continue;
    }

    await new Promise<void>((resolve) =>
      setTimeout(resolve, LOCK_RETRY_DELAY_MS),
    );
  }
  throw new Error(
    `codex-auth: could not acquire lock ${lockPath} after ${LOCK_RETRY_MAX} retries`,
  );
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
}

/**
 * Refresh the access_token using the stored refresh_token. Acquires a
 * file-level lock for the duration of the network call + write, so two
 * processes won't race on the same auth.json. After acquiring the lock
 * we re-read auth from disk in case another process refreshed first; if
 * the on-disk access_token is no longer expired, we return that and skip
 * the network call.
 */
export async function refreshCodexAuth(
  currentAuth: CodexAuth,
  path: string,
): Promise<CodexAuth> {
  const lock = await acquireLock(path);
  try {
    // Re-check after lock — another process may have refreshed already.
    try {
      const onDisk = await loadCodexAuth(path);
      if (!isExpired(onDisk)) {
        return onDisk;
      }
      currentAuth = onDisk;
    } catch {
      // missing or unreadable — fall through and refresh from current
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: currentAuth.tokens.refresh_token,
      client_id: OAUTH_CLIENT_ID,
    });

    const res = await getFetch()(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `codex-auth: refresh failed: ${res.status} ${res.statusText} ${text}`.trim(),
      );
    }

    const json = (await res.json()) as OAuthTokenResponse;
    if (!json || typeof json.access_token !== "string") {
      throw new Error("codex-auth: refresh response missing access_token");
    }

    const next: CodexAuth = {
      ...currentAuth,
      last_refresh: new Date(nowMs()).toISOString(),
      tokens: {
        ...currentAuth.tokens,
        access_token: json.access_token,
        refresh_token: json.refresh_token ?? currentAuth.tokens.refresh_token,
        id_token: json.id_token ?? currentAuth.tokens.id_token,
      },
    };

    await saveCodexAuth(next, path);
    return next;
  } finally {
    await lock.release();
  }
}
