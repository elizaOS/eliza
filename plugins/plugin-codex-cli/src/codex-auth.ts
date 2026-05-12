/** Load, refresh, and atomically save codex CLI ChatGPT OAuth cache. */
import { randomBytes } from "node:crypto";
import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
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
    typeof parsed.tokens.refresh_token !== "string"
  ) {
    throw new Error(`codex auth.json malformed at ${p}: missing access/refresh token fields`);
  }
  return {
    OPENAI_API_KEY: parsed.OPENAI_API_KEY ?? null,
    auth_mode: parsed.auth_mode === "apikey" ? "apikey" : "chatgpt",
    last_refresh: parsed.last_refresh ?? new Date(0).toISOString(),
    tokens: {
      id_token: typeof parsed.tokens.id_token === "string" ? parsed.tokens.id_token : "",
      access_token: parsed.tokens.access_token,
      refresh_token: parsed.tokens.refresh_token,
      account_id: typeof parsed.tokens.account_id === "string" ? parsed.tokens.account_id : "",
    },
  };
}

export async function saveCodexAuth(auth: CodexAuth, path: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  try {
    await rename(tmp, path);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  try {
    return JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function isExpired(auth: CodexAuth, bufferSeconds = 60): boolean {
  const payload = decodeJwtPayload(auth.tokens.access_token);
  const exp = payload?.exp;
  if (typeof exp !== "number") return true;
  return nowMs() + bufferSeconds * 1000 >= exp * 1000;
}

interface AcquiredLock {
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
      release: async () => {
        try {
          await unlink(lockPath);
        } catch {
          // already gone
        }
      },
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw err;
  }
}

async function isLockStale(lockPath: string): Promise<boolean> {
  try {
    return nowMs() - (await stat(lockPath)).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

async function acquireLock(authPath: string): Promise<AcquiredLock> {
  const lockPath = `${authPath}.lock`;
  for (let attempt = 0; attempt < LOCK_RETRY_MAX; attempt++) {
    const lock = await tryCreateLock(lockPath);
    if (lock) return lock;
    if (await isLockStale(lockPath)) {
      try {
        await unlink(lockPath);
      } catch {
        // race with another process
      }
      continue;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
  }
  throw new Error(`codex-auth: could not acquire lock ${lockPath} after ${LOCK_RETRY_MAX} retries`);
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
}

export async function refreshCodexAuth(currentAuth: CodexAuth, path: string): Promise<CodexAuth> {
  const lock = await acquireLock(path);
  try {
    try {
      const onDisk = await loadCodexAuth(path);
      if (!isExpired(onDisk)) return onDisk;
      currentAuth = onDisk;
    } catch {
      // fall back to current auth
    }

    const res = await getFetch()(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: currentAuth.tokens.refresh_token,
        client_id: OAUTH_CLIENT_ID,
      }).toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`codex-auth: refresh failed: ${res.status} ${res.statusText} ${text}`.trim());
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
