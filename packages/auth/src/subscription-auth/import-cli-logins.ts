/**
 * One-shot importer that lifts an existing Codex CLI (`~/.codex/auth.json`) or
 * Claude Code CLI (`~/.claude/.credentials.json`) subscription login into the
 * canonical eliza account store, so the AccountPool owns the refresh chain.
 *
 * Why this exists: without a linked account, every coding spawn rides the raw
 * machine-global CLI login. Those files have ONE-TIME-USE refresh tokens
 * (OpenAI and Anthropic both rotate-and-revoke on reuse), and multiple
 * uncoordinated refreshers — the planner backend, each spawned CLI, an
 * interactive session — race the same token; a stale replay revokes the whole
 * grant family ("refresh token was revoked, please log out and sign in again").
 * Once the login is a first-class account, the per-account refresh mutex, the
 * 5-minute keep-alive sweep, per-account CODEX_HOME materialization, and
 * rotated-token adoption keep exactly one owner of the chain — the de-auth
 * cadence goes away and multi-account/cycling become reachable.
 *
 * Non-destructive by default: the source CLI files are left in place (the CLIs
 * keep working); pass `retireSource` to rename them once the pool is proven, so
 * there is a single refresher.
 */

import { existsSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import type { AccountCredentialProvider } from "../types.js";
import { loadAccount, saveAccount } from "../account-storage.js";

function codexHomePath(): string {
  return path.join(
    process.env.CODEX_HOME || path.join(process.env.HOME || "", ".codex"),
    "auth.json",
  );
}

function claudeCredentialsPath(): string {
  return path.join(process.env.HOME || "", ".claude", ".credentials.json");
}

/** Decode a JWT's `exp` (seconds) into ms, or undefined when undecodable. */
function jwtExpiryMs(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(
        parts[1].replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf-8"),
    ) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export interface CliLoginImportResult {
  provider: AccountCredentialProvider;
  accountId: string;
  imported: boolean;
  reason: string;
}

/**
 * Import the Codex CLI's chatgpt-mode login. The CLI store shape is
 * `{ tokens: { access_token, refresh_token, id_token, account_id }, last_refresh }`.
 * `id_token` is REQUIRED so the materialized per-account CODEX_HOME can
 * authenticate in chatgpt mode.
 */
export function importCodexCliLogin(
  opts: { accountId?: string; retireSource?: boolean } = {},
): CliLoginImportResult {
  const provider: AccountCredentialProvider = "openai-codex";
  const accountId = opts.accountId ?? "default";
  const authPath = codexHomePath();
  if (!existsSync(authPath)) {
    return { provider, accountId, imported: false, reason: "no ~/.codex/auth.json" };
  }
  let parsed: {
    tokens?: {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      account_id?: string;
    };
    last_refresh?: string;
  };
  try {
    parsed = JSON.parse(readFileSync(authPath, "utf-8"));
  } catch {
    return { provider, accountId, imported: false, reason: "unparseable auth.json" };
  }
  const tokens = parsed.tokens;
  if (!tokens?.access_token || !tokens.refresh_token) {
    return { provider, accountId, imported: false, reason: "missing tokens" };
  }
  const materializedAt =
    typeof parsed.last_refresh === "string"
      ? Date.parse(parsed.last_refresh)
      : Number.NaN;
  const existing = loadAccount(provider, accountId);
  // Idempotent: skip when the store already holds this exact refresh token
  // (nothing changed) or a strictly newer record (the pool refreshed since).
  if (existing) {
    if (existing.credentials.refresh === tokens.refresh_token) {
      return { provider, accountId, imported: false, reason: "already current" };
    }
    if (Number.isFinite(materializedAt) && materializedAt <= existing.updatedAt) {
      return { provider, accountId, imported: false, reason: "store is newer" };
    }
  }
  const now = Date.now();
  saveAccount({
    id: accountId,
    providerId: provider,
    label: "Imported Codex CLI login",
    source: "oauth",
    credentials: {
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      // Undecodable exp ⇒ already-expired so the first getAccessToken refreshes
      // immediately with the (still valid) refresh token.
      expires: jwtExpiryMs(tokens.access_token) ?? now,
      ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(tokens.account_id ? { organizationId: tokens.account_id } : {}),
  });
  if (opts.retireSource) {
    try {
      renameSync(authPath, `${authPath}.imported-${now}`);
    } catch {
      // best-effort — the record is written regardless.
    }
  }
  return { provider, accountId, imported: true, reason: "imported" };
}

/**
 * Import the Claude Code CLI's Max login. The blob is either flat
 * (`{ accessToken, refreshToken, expiresAt, subscriptionType }`) or wrapped in
 * `{ claudeAiOauth: { ... } }`; both are accepted.
 *
 * ⚠ SHARED-GRANT HAZARD — read before calling from an auto-import path. Unlike
 * Codex (whose per-account CODEX_HOME isolates the pool from any interactive
 * `codex` use), a Claude Max login is almost always the SAME account the
 * operator runs Claude Code with. The pool and interactive Claude Code then
 * share ONE one-time-use refresh chain: when the pool's keep-alive sweep
 * refreshes the token, Anthropic rotates-and-revokes it and the interactive
 * Claude Code session's now-stale copy is kicked — the operator is silently
 * logged out (reproduced live). Only pool a Claude Max account DEDICATED to the
 * bot; the boot auto-import gates this behind ELIZA_POOL_CLAUDE_CLI_LOGIN=1 for
 * exactly this reason. This function itself is a safe library primitive — the
 * hazard is in WHERE it is called, not the mapping.
 */
export function importClaudeCliLogin(
  opts: { accountId?: string; retireSource?: boolean } = {},
): CliLoginImportResult {
  const provider: AccountCredentialProvider = "anthropic-subscription";
  const accountId = opts.accountId ?? "default";
  const credPath = claudeCredentialsPath();
  if (!existsSync(credPath)) {
    return { provider, accountId, imported: false, reason: "no ~/.claude/.credentials.json" };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(credPath, "utf-8"));
  } catch {
    return { provider, accountId, imported: false, reason: "unparseable credentials" };
  }
  const oauth = (
    parsed.claudeAiOauth && typeof parsed.claudeAiOauth === "object"
      ? parsed.claudeAiOauth
      : parsed
  ) as {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    subscriptionType?: string;
  };
  if (!oauth.accessToken || !oauth.refreshToken) {
    return { provider, accountId, imported: false, reason: "missing tokens" };
  }
  const existing = loadAccount(provider, accountId);
  if (existing && existing.credentials.refresh === oauth.refreshToken) {
    return { provider, accountId, imported: false, reason: "already current" };
  }
  const now = Date.now();
  saveAccount({
    id: accountId,
    providerId: provider,
    label: `Imported Claude ${oauth.subscriptionType ?? "Max"} login`,
    source: "oauth",
    credentials: {
      access: oauth.accessToken,
      refresh: oauth.refreshToken,
      expires: typeof oauth.expiresAt === "number" ? oauth.expiresAt : now,
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  if (opts.retireSource) {
    try {
      renameSync(credPath, `${credPath}.imported-${now}`);
    } catch {
      // best-effort.
    }
  }
  return { provider, accountId, imported: true, reason: "imported" };
}

/** Import whichever CLI logins are present. */
export function importAllCliLogins(
  opts: { retireSource?: boolean } = {},
): CliLoginImportResult[] {
  return [importCodexCliLogin(opts), importClaudeCliLogin(opts)];
}
