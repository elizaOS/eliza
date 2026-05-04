/**
 * External credential adapters for password-manager backends.
 *
 * Reads Login items out of `op` (1Password) and `bw` (Bitwarden) using the
 * session token persisted by the secrets-manager installer at
 * `pm.<backend>.session`. Returns a uniform shape so the manager layer can
 * merge them with the in-house saved-logins list.
 *
 *   list*  → metadata only, never returns passwords
 *   reveal* → explicit second step, returns username + password (+ totp)
 *
 * The CLI is shelled out via an injected `ExecFn` so tests can stub the
 * subprocess without spawning real processes.
 */

import type { Vault } from "./vault.js";

export type ExternalLoginSource = "1password" | "bitwarden";

export interface ExternalLoginListEntry {
  readonly source: ExternalLoginSource;
  /** op item id / bw item id — opaque to callers. */
  readonly externalId: string;
  readonly title: string;
  readonly username: string;
  /** Best-effort registrable hostname extracted from urls[0]; null when none. */
  readonly domain: string | null;
  readonly url: string | null;
  /** Epoch ms; 0 when the backend didn't supply a timestamp. */
  readonly updatedAt: number;
}

export interface ExternalLoginReveal extends ExternalLoginListEntry {
  readonly password: string;
  readonly totp?: string;
}

export class BackendNotSignedInError extends Error {
  constructor(readonly source: ExternalLoginSource) {
    super(`[${source}] not signed in — sign in via Settings → Secrets storage`);
    this.name = "BackendNotSignedInError";
  }
}

/**
 * Subprocess executor injected by the manager (tests pass a stub).
 *
 * Mirrors `node:child_process.execFile` with promises: returns combined
 * stdout/stderr, throws on non-zero exit. The `env` option matters for
 * Bitwarden (BW_SESSION) — 1Password uses an explicit `--session` flag.
 */
export type ExecFn = (
  cmd: string,
  args: readonly string[],
  opts: {
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly stdin?: string;
  },
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

// ── 1Password ─────────────────────────────────────────────────────────

/**
 * Raw shape of `op item list --categories Login --format=json`. Newer CLI
 * versions return an array of summary objects without `username` populated;
 * older versions occasionally include it. We always treat username/url as
 * optional in the summary and enrich via `op item get -` piping.
 */
interface OnePasswordListItem {
  readonly id: string;
  readonly title?: string;
  readonly category?: string;
  readonly updated_at?: string;
  readonly urls?: ReadonlyArray<{
    readonly href?: string;
    readonly primary?: boolean;
  }>;
  readonly additional_information?: string;
}

interface OnePasswordEnrichedItem extends OnePasswordListItem {
  readonly fields?: ReadonlyArray<{
    readonly id?: string;
    readonly label?: string;
    readonly purpose?: string;
    readonly value?: string;
    readonly type?: string;
  }>;
}

export async function listOnePasswordLogins(
  vault: Vault,
  exec: ExecFn,
): Promise<readonly ExternalLoginListEntry[]> {
  const sessionArgs = await readOnePasswordSessionArgs(vault, exec);

  // Step 1: list Login items as JSON. `--format=json` is the documented
  // machine-readable form; the example in `op item list --help` chains it
  // into `op item get -` which is what we do for username enrichment.
  // When 1Password desktop integration is active, `sessionArgs` is empty
  // and the CLI authenticates via the desktop app.
  const listOut = await exec(
    "op",
    [...sessionArgs, "item", "list", "--categories", "Login", "--format=json"],
    { timeoutMs: 10_000 },
  );
  const items = parseJsonArray<OnePasswordListItem>(listOut.stdout);

  if (items.length === 0) return [];

  // The 1Password CLI exposes the username as `additional_information` on
  // every Login item summary. No per-item enrichment needed for the list
  // view. Reveal still calls `op item get <id>` to fetch the password.
  const out: ExternalLoginListEntry[] = [];
  for (const item of items) {
    const url = pickPrimaryUrl(item.urls);
    const username =
      typeof item.additional_information === "string"
        ? item.additional_information
        : "";
    out.push({
      source: "1password",
      externalId: item.id,
      title:
        typeof item.title === "string" && item.title.length > 0
          ? item.title
          : item.id,
      username,
      domain: url ? extractHostname(url) : null,
      url: url ?? null,
      updatedAt: parseDate(item.updated_at),
    });
  }
  return out;
}

export async function revealOnePasswordLogin(
  vault: Vault,
  exec: ExecFn,
  externalId: string,
): Promise<ExternalLoginReveal> {
  if (!externalId)
    throw new TypeError("revealOnePasswordLogin: externalId required");
  const sessionArgs = await readOnePasswordSessionArgs(vault, exec);

  // `op item get <id> --format=json` includes the full `fields` array with
  // values for username/password/totp.
  const out = await exec(
    "op",
    [...sessionArgs, "item", "get", externalId, "--format=json"],
    { timeoutMs: 10_000 },
  );
  const item = parseJsonObject<OnePasswordEnrichedItem>(out.stdout);

  const username = pickOnePasswordUsername(item) ?? "";
  const password = pickOnePasswordField(item, "password") ?? "";
  const totp =
    pickOnePasswordField(item, "one-time password") ??
    pickOnePasswordField(item, "totp");
  const url = pickPrimaryUrl(item.urls);

  if (!password) {
    throw new Error(`[1password] item ${externalId} has no password field`);
  }

  const reveal: ExternalLoginReveal = {
    source: "1password",
    externalId: item.id,
    title:
      typeof item.title === "string" && item.title.length > 0
        ? item.title
        : item.id,
    username,
    domain: url ? extractHostname(url) : null,
    url: url ?? null,
    updatedAt: parseDate(item.updated_at),
    password,
    ...(totp ? { totp } : {}),
  };
  return reveal;
}

function pickOnePasswordUsername(
  item: OnePasswordEnrichedItem | undefined,
): string | null {
  if (!item?.fields) return null;
  // `purpose: "USERNAME"` is the canonical marker for the Login.username slot.
  const byPurpose = item.fields.find(
    (f) => f.purpose === "USERNAME" && typeof f.value === "string",
  );
  if (byPurpose?.value) return byPurpose.value;
  // Fallback: label-based match for older CLIs.
  const byLabel = item.fields.find(
    (f) => f.label === "username" && typeof f.value === "string",
  );
  return byLabel?.value ?? null;
}

function pickOnePasswordField(
  item: OnePasswordEnrichedItem,
  label: string,
): string | null {
  if (!item.fields) return null;
  if (label === "password") {
    const byPurpose = item.fields.find(
      (f) => f.purpose === "PASSWORD" && typeof f.value === "string",
    );
    if (byPurpose?.value) return byPurpose.value;
  }
  const lowered = label.toLowerCase();
  const match = item.fields.find(
    (f) =>
      typeof f.label === "string" &&
      f.label.toLowerCase() === lowered &&
      typeof f.value === "string",
  );
  return match?.value ?? null;
}

// ── Bitwarden ─────────────────────────────────────────────────────────

interface BitwardenItem {
  readonly id: string;
  readonly name?: string;
  readonly type?: number; // 1 = login
  readonly revisionDate?: string;
  readonly login?: {
    readonly username?: string | null;
    readonly password?: string | null;
    readonly totp?: string | null;
    readonly uris?: ReadonlyArray<{ readonly uri?: string }> | null;
  };
}

export async function listBitwardenLogins(
  vault: Vault,
  exec: ExecFn,
): Promise<readonly ExternalLoginListEntry[]> {
  const session = await readSessionToken(vault, "bitwarden");

  // `bw list items` returns ALL items (logins, secure notes, cards, etc.).
  // Filter to type === 1 (login) on the JS side; bw doesn't accept a category
  // filter on the list command.
  const out = await exec("bw", ["list", "items"], {
    env: { ...process.env, BW_SESSION: session },
    timeoutMs: 15_000,
  });
  const items = parseJsonArray<BitwardenItem>(out.stdout);

  const result: ExternalLoginListEntry[] = [];
  for (const item of items) {
    if (item.type !== 1 || !item.login) continue;
    const url = pickBitwardenUrl(item.login.uris ?? null);
    result.push({
      source: "bitwarden",
      externalId: item.id,
      title:
        typeof item.name === "string" && item.name.length > 0
          ? item.name
          : item.id,
      username:
        typeof item.login.username === "string" ? item.login.username : "",
      domain: url ? extractHostname(url) : null,
      url: url ?? null,
      updatedAt: parseDate(item.revisionDate),
    });
  }
  return result;
}

export async function revealBitwardenLogin(
  vault: Vault,
  exec: ExecFn,
  externalId: string,
): Promise<ExternalLoginReveal> {
  if (!externalId)
    throw new TypeError("revealBitwardenLogin: externalId required");
  const session = await readSessionToken(vault, "bitwarden");

  const out = await exec("bw", ["get", "item", externalId], {
    env: { ...process.env, BW_SESSION: session },
    timeoutMs: 10_000,
  });
  const item = parseJsonObject<BitwardenItem>(out.stdout);
  if (item.type !== 1 || !item.login) {
    throw new Error(`[bitwarden] item ${externalId} is not a login`);
  }
  const password = item.login.password ?? "";
  if (!password) {
    throw new Error(`[bitwarden] item ${externalId} has no password`);
  }
  const url = pickBitwardenUrl(item.login.uris ?? null);
  return {
    source: "bitwarden",
    externalId: item.id,
    title:
      typeof item.name === "string" && item.name.length > 0
        ? item.name
        : item.id,
    username:
      typeof item.login.username === "string" ? item.login.username : "",
    domain: url ? extractHostname(url) : null,
    url: url ?? null,
    updatedAt: parseDate(item.revisionDate),
    password,
    ...(item.login.totp ? { totp: item.login.totp } : {}),
  };
}

function pickBitwardenUrl(
  uris: ReadonlyArray<{ readonly uri?: string }> | null,
): string | null {
  if (!uris || uris.length === 0) return null;
  for (const u of uris) {
    if (typeof u.uri === "string" && u.uri.length > 0) return u.uri;
  }
  return null;
}

// ── Shared helpers ────────────────────────────────────────────────────

async function readSessionToken(
  vault: Vault,
  source: ExternalLoginSource,
): Promise<string> {
  const key = `pm.${source}.session`;
  if (!(await vault.has(key))) throw new BackendNotSignedInError(source);
  const token = (await vault.get(key)).trim();
  if (!token) throw new BackendNotSignedInError(source);
  return token;
}

/**
 * Resolve op-invocation args (account + session) for one CLI call.
 *
 * 1Password 8's `op` CLI refuses to pick a default account when more than
 * one is registered — `op whoami` exits 1 with "account is not signed in"
 * even when the desktop app integration is fully active. The fix: probe
 * `op account list` once, pick the first registered account's shorthand,
 * and pass `--account=<shorthand>` on every subsequent call. Then desktop
 * integration triggers the normal Touch ID flow and the session-token
 * fallback is only used when no account is registered at all.
 *
 * Returns `["--account=<sh>"]` for desktop-app and
 * `["--account=<sh>", "--session=<token>"]` for session-token.
 */
async function readOnePasswordSessionArgs(
  vault: Vault,
  exec: ExecFn,
): Promise<readonly string[]> {
  const account = await readDefaultOpAccount(exec);
  const accountArg = account ? [`--account=${account}`] : [];
  if (await isOnePasswordDesktopActiveWithExec(exec, accountArg)) {
    return accountArg;
  }
  const session = await readSessionToken(vault, "1password");
  return [...accountArg, `--session=${session}`];
}

async function readDefaultOpAccount(exec: ExecFn): Promise<string | null> {
  try {
    const out = await exec("op", ["account", "list", "--format=json"], {
      timeoutMs: 3000,
    });
    const accounts = parseJsonArray<{
      readonly shorthand?: string;
      readonly url?: string;
      readonly account_uuid?: string;
    }>(out.stdout);
    for (const a of accounts) {
      if (typeof a.shorthand === "string" && a.shorthand.length > 0) {
        return a.shorthand;
      }
      // Fall back to the URL hostname as the shorthand 1Password generates
      // (e.g. "my" for my.1password.com) when shorthand is absent.
      if (typeof a.url === "string") {
        const sub = a.url.split(".")[0];
        if (sub) return sub;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function isOnePasswordDesktopActiveWithExec(
  exec: ExecFn,
  accountArg: readonly string[],
): Promise<boolean> {
  // `op whoami` is special — even with desktop integration active, it
  // refuses to run without a session token. A real vault query (e.g.
  // `op vault list --format=json`) IS handled by desktop session
  // delegation. Probe with that instead.
  if (accountArg.length === 0) return false;
  try {
    await exec("op", [...accountArg, "vault", "list", "--format=json"], {
      timeoutMs: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

function pickPrimaryUrl(
  urls:
    | ReadonlyArray<{ readonly href?: string; readonly primary?: boolean }>
    | undefined,
): string | null {
  if (!urls || urls.length === 0) return null;
  const primary = urls.find(
    (u) => u.primary === true && typeof u.href === "string",
  );
  if (primary?.href) return primary.href;
  for (const u of urls) {
    if (typeof u.href === "string" && u.href.length > 0) return u.href;
  }
  return null;
}

function extractHostname(url: string): string | null {
  try {
    const parsed = new URL(url.includes("://") ? url : `https://${url}`);
    const host = parsed.hostname.toLowerCase();
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

function parseDate(value: string | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function parseJsonArray<T>(raw: string): readonly T[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error("expected JSON array, got non-array");
  }
  return parsed as readonly T[];
}

function parseJsonObject<T>(raw: string): T {
  const trimmed = raw.trim();
  if (trimmed.length === 0)
    throw new Error("expected JSON object, got empty output");
  const parsed: unknown = JSON.parse(trimmed);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected JSON object, got non-object");
  }
  return parsed as T;
}

/**
 * Production `ExecFn` wrapping `node:child_process.execFile`. Tests inject
 * stubs instead of using this. Lives here so callers can `import` a single
 * default rather than wiring `child_process` themselves.
 */
export function defaultExecFn(): ExecFn {
  // Lazy require so the test environment doesn't accidentally run real
  // subprocesses if a test forgets to inject a stub.
  return async (cmd, args, opts) => {
    const childProcess = await import("node:child_process");
    return new Promise((resolve, reject) => {
      const child = childProcess.execFile(
        cmd,
        [...args],
        {
          ...(opts.env ? { env: opts.env } : {}),
          timeout: opts.timeoutMs ?? 10_000,
          maxBuffer: 16 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }
          // `encoding: "utf8"` forces stdout/stderr to strings.
          resolve({ stdout, stderr });
        },
      );
      if (opts.stdin !== undefined && child.stdin) {
        child.stdin.write(opts.stdin);
        child.stdin.end();
      }
    });
  };
}
