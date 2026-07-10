/**
 * Explicit, transactional adoption of a Codex CLI login (`~/.codex/auth.json`)
 * into the account pool, with mandatory retirement of the source so exactly one
 * process owns the refresh chain.
 *
 * Why the transactional retirement is mandatory: OpenAI Codex refresh tokens are
 * ONE-TIME-USE (rotate-and-revoke on reuse). If the pool adopts the login but
 * the CLI's `~/.codex/auth.json` is left in place, BOTH the pool and any later
 * `codex` invocation refresh the same chain; the second refresh replays a
 * consumed token and OpenAI revokes the whole grant family. Adoption is only
 * safe if it establishes EXCLUSIVE ownership — the source is retired (renamed
 * out of the CLI's read path) as part of the same operation, and the operation
 * HARD-FAILS if that exclusivity cannot be guaranteed rather than silently
 * leaving two refreshers.
 *
 * This is a deliberate, operator-invoked action — never a boot-time auto-import.
 * Auto-adopting a shared machine login is exactly the unsafe pattern this
 * replaces. Claude Max adoption is intentionally NOT provided here: a Claude
 * login is almost always the account the operator runs Claude Code with, and
 * pooling it silently logs that session out; connect a dedicated Claude account
 * through the explicit OAuth flow instead.
 */

import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { loadAccount, saveAccount } from "../account-storage.js";

function codexAuthPath(): string {
  return path.join(
    process.env.CODEX_HOME || path.join(process.env.HOME || "", ".codex"),
    "auth.json",
  );
}

/** Decode a JWT `exp` (seconds) into ms; undefined when undecodable. */
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

export class AdoptCodexError extends Error {
  constructor(
    message: string,
    readonly code:
      | "no_source"
      | "not_regular_file"
      | "unreadable"
      | "missing_tokens"
      | "account_exists"
      | "retire_failed",
  ) {
    super(message);
    this.name = "AdoptCodexError";
  }
}

export interface AdoptCodexOptions {
  /** Pool account id to create (default "default"). */
  accountId?: string;
  /** Overwrite an existing pool account with this id. Default false → error. */
  overwrite?: boolean;
  /**
   * The `CODEX_HOME` path to adopt from. Defaults to the process's
   * `CODEX_HOME`/`~/.codex`. Explicit here so a caller can adopt a per-account
   * home (e.g. `~/.codex-acct2`) without mutating process env.
   */
  codexHome?: string;
}

export interface AdoptCodexResult {
  accountId: string;
  organizationId?: string;
  /** Where the source auth.json was moved to (proof of retirement). */
  retiredTo: string;
}

interface CodexAuthJson {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

/**
 * Read a file that MUST be a regular file (not a symlink or special file),
 * opening with O_NOFOLLOW so a symlink at the path is rejected rather than
 * followed. Prevents a hostile symlink from redirecting the read/rename.
 */
function readRegularFile(filePath: string): string {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(filePath);
  } catch {
    throw new AdoptCodexError(
      `No Codex login at ${filePath}`,
      "no_source",
    );
  }
  if (!stat.isFile()) {
    throw new AdoptCodexError(
      `Codex login at ${filePath} is not a regular file (symlink or special file); refusing to adopt`,
      "not_regular_file",
    );
  }
  // O_NOFOLLOW (0o400000 on Linux) rejects a symlink swapped in after the
  // lstat; combined with the isFile() check this closes the TOCTOU window.
  const O_NOFOLLOW = 0o400000;
  let fd: number;
  try {
    fd = openSync(filePath, 0 /* O_RDONLY */ | O_NOFOLLOW);
  } catch {
    throw new AdoptCodexError(
      `Codex login at ${filePath} could not be opened as a regular file`,
      "unreadable",
    );
  }
  try {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(64 * 1024);
    let n: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard read loop
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    return Buffer.concat(chunks).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Adopt the Codex CLI login into the pool AND retire the source in one
 * transactional operation. Post-condition on success: the pool account exists
 * and the source auth.json no longer exists at its original path — so the CLI
 * (and any other refresher) can no longer read or rotate that chain. On any
 * failure NOTHING is committed (the pool account is only written after the
 * source is exclusively owned, and a failed source-retire throws before the
 * account is written).
 */
export function adoptCodexCliLogin(
  opts: AdoptCodexOptions = {},
): AdoptCodexResult {
  const accountId = opts.accountId ?? "default";
  const provider = "openai-codex" as const;
  const authPath = opts.codexHome
    ? path.join(opts.codexHome, "auth.json")
    : codexAuthPath();

  // 1. Read the source as a strictly-regular file (symlink-safe).
  const raw = readRegularFile(authPath);
  let parsed: CodexAuthJson;
  try {
    parsed = JSON.parse(raw) as CodexAuthJson;
  } catch {
    throw new AdoptCodexError(
      `Codex login at ${authPath} is not valid JSON`,
      "unreadable",
    );
  }
  const tokens = parsed.tokens;
  if (!tokens?.access_token || !tokens.refresh_token) {
    throw new AdoptCodexError(
      `Codex login at ${authPath} is missing access/refresh tokens`,
      "missing_tokens",
    );
  }

  // 2. No implicit overwrite of an existing pool account.
  const existing = loadAccount(provider, accountId);
  if (existing && !opts.overwrite) {
    throw new AdoptCodexError(
      `A pool account "${provider}/${accountId}" already exists; pass overwrite to replace it`,
      "account_exists",
    );
  }

  // 3. Establish EXCLUSIVE ownership FIRST: retire the source by renaming it out
  //    of the CLI's read path. If this fails we cannot guarantee the CLI won't
  //    keep refreshing the chain, so we hard-fail WITHOUT writing the pool
  //    account — leaving the world unchanged (the source stays put).
  const retiredTo = `${authPath}.adopted-${jwtExpiryMs(tokens.access_token) ?? "0"}-${accountId}`;
  try {
    renameSync(authPath, retiredTo);
  } catch (err) {
    throw new AdoptCodexError(
      `Could not retire the Codex source at ${authPath} (exclusive ownership not established): ${err instanceof Error ? err.message : String(err)}`,
      "retire_failed",
    );
  }

  // 4. Source is now exclusively ours — write the pool account. If this throws
  //    (it should not; saveAccount is a local atomic write), restore the source
  //    so we never strand the operator with neither a working CLI nor a pool
  //    account.
  try {
    const now = Date.now();
    saveAccount({
      id: accountId,
      providerId: provider,
      label: "Adopted Codex CLI login",
      source: "oauth",
      credentials: {
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires: jwtExpiryMs(tokens.access_token) ?? now,
        ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(tokens.account_id ? { organizationId: tokens.account_id } : {}),
    });
  } catch (err) {
    try {
      renameSync(retiredTo, authPath);
    } catch {
      // best-effort restore; surface the original write failure regardless.
    }
    throw err;
  }

  return {
    accountId,
    ...(tokens.account_id ? { organizationId: tokens.account_id } : {}),
    retiredTo,
  };
}
