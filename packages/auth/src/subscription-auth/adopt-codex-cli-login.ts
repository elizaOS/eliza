/**
 * Transactional adoption of a Codex CLI login (`CODEX_HOME/auth.json`) into the
 * account pool, with mandatory retirement of the source so exactly one refresher
 * owns the chain.
 *
 * OpenAI Codex refresh tokens are one-time-use (rotate-and-revoke on reuse): if
 * the pool adopts the login while the CLI's `auth.json` stays in place, both
 * sides eventually refresh the same chain, the second refresh replays a consumed
 * token, and OpenAI revokes the whole grant family. Adoption is therefore only
 * safe as an exclusive-ownership transfer.
 *
 * Ownership is established by retiring FIRST and reading SECOND: the source is
 * atomically renamed to an unpredictable retired path, and the credentials are
 * parsed from that retired inode. Whatever bytes the pool stores are exactly the
 * bytes that were removed from the CLI's read path — a concurrent atomic
 * replacement of `auth.json` (Codex's own write pattern) can race the rename,
 * but it can never produce a pool account whose tokens differ from the retired
 * file. A source that reappears after retirement means a live refresher is
 * still running; adoption fails typed (`adopt_codex.concurrent_refresher`)
 * rather than committing a chain another process is actively rotating.
 *
 * This is a deliberate, operator-invoked action (`eliza auth adopt-codex`),
 * never a boot-time auto-import. Claude Max adoption is intentionally not
 * provided: a Claude login is usually the account the operator runs Claude Code
 * with, and pooling it logs that session out — connect a dedicated Claude
 * account through the explicit OAuth flow instead.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { ElizaError, logger } from "@elizaos/core";
import { loadAccount, saveAccount } from "../account-storage.js";

/** Every failure mode, as the `code` on the thrown {@link ElizaError}. */
export const ADOPT_CODEX_ERROR_CODES = [
  "adopt_codex.invalid_account_id",
  "adopt_codex.no_source",
  "adopt_codex.source_stat_failed",
  "adopt_codex.not_regular_file",
  "adopt_codex.unreadable",
  "adopt_codex.invalid_tokens",
  "adopt_codex.account_exists",
  "adopt_codex.retire_failed",
  "adopt_codex.pool_write_failed",
  "adopt_codex.concurrent_refresher",
] as const;
export type AdoptCodexErrorCode = (typeof ADOPT_CODEX_ERROR_CODES)[number];

function adoptError(
  code: AdoptCodexErrorCode,
  message: string,
  context?: Record<string, unknown>,
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, {
    code,
    severity: "fatal",
    ...(context ? { context } : {}),
    ...(cause !== undefined ? { cause } : {}),
  });
}

// Pool account ids flow into both the pool filename and the retired-file
// suffix, so they are validated as a strict identifier at this public
// boundary: no separators, no traversal, no control characters, bounded
// length. Anything else is rejected before any filesystem effect.
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validateAccountId(accountId: string): void {
  if (
    typeof accountId !== "string" ||
    !ACCOUNT_ID_PATTERN.test(accountId) ||
    accountId === "." ||
    accountId === ".." ||
    accountId.includes("..")
  ) {
    throw adoptError(
      "adopt_codex.invalid_account_id",
      "Account id must be 1-64 chars of [A-Za-z0-9._-], starting alphanumeric, with no traversal sequences",
      { accountId: String(accountId).slice(0, 80) },
    );
  }
}

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
    // error-policy:J3 the JWT is untrusted input; an undecodable payload means
    // "no expiry available", which callers substitute with now().
    return undefined;
  }
}

export interface AdoptCodexOptions {
  /** Pool account id to create (default "default"). */
  accountId?: string;
  /** Overwrite an existing pool account with this id. Default false → error. */
  overwrite?: boolean;
  /**
   * The `CODEX_HOME` to adopt from. Defaults to the process's
   * `CODEX_HOME`/`~/.codex`. Explicit so a caller can adopt a per-account home
   * (e.g. `~/.codex-acct2`) without mutating process env.
   */
  codexHome?: string;
}

export interface AdoptCodexResult {
  accountId: string;
  organizationId?: string;
  /** Where the source auth.json was moved to (proof of retirement). */
  retiredTo: string;
}

interface CodexAuthTokens {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  account_id?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validate the parsed auth.json token block at runtime. Every field that flows
 * into `.split()` or the pool store must actually be a string — a numeric or
 * object-shaped token from a hand-edited file fails typed here instead of
 * surfacing as an untyped crash downstream.
 */
function validateTokens(parsed: unknown, sourceLabel: string): CodexAuthTokens {
  const tokens = (parsed as { tokens?: unknown } | null)?.tokens as
    | Record<string, unknown>
    | undefined;
  if (
    !tokens ||
    !isNonEmptyString(tokens.access_token) ||
    !isNonEmptyString(tokens.refresh_token) ||
    (tokens.id_token !== undefined && !isNonEmptyString(tokens.id_token)) ||
    (tokens.account_id !== undefined && !isNonEmptyString(tokens.account_id))
  ) {
    throw adoptError(
      "adopt_codex.invalid_tokens",
      `Codex login at ${sourceLabel} is missing string access/refresh tokens`,
      { source: sourceLabel },
    );
  }
  return tokens as unknown as CodexAuthTokens;
}

/**
 * Read a path that must be a regular file, opening with O_NOFOLLOW so a
 * symlink swapped in after the lstat is rejected rather than followed.
 */
function readRegularFile(filePath: string): string {
  let fd: number;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    throw adoptError(
      "adopt_codex.unreadable",
      `Could not open ${filePath} as a regular file`,
      { path: filePath },
      err,
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

export interface RestoreRetiredResult {
  restored: boolean;
  /** Set when the original path is occupied — restoring would clobber it. */
  reason?: "destination_occupied";
}

/**
 * Move a retired source back to its original path WITHOUT ever clobbering a
 * file that has appeared there since — `link()` fails with EEXIST on an
 * occupied destination, which makes the no-clobber check atomic rather than a
 * check-then-rename race. An occupied destination means a live refresher
 * recreated the login with a fresher chain; the retired copy must not replace
 * it.
 */
export function restoreRetiredSource(
  retiredTo: string,
  originalPath: string,
): RestoreRetiredResult {
  try {
    linkSync(retiredTo, originalPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { restored: false, reason: "destination_occupied" };
    }
    throw err;
  }
  unlinkSync(retiredTo);
  return { restored: true };
}

/**
 * Adopt the Codex CLI login into the pool and retire the source in one
 * transactional operation. Post-condition on success: the pool account exists,
 * the source auth.json is gone from the CLI's read path, and the pool
 * credentials are byte-identical to the retired file. On any failure nothing is
 * committed; where the source was already retired it is restored no-clobber, or
 * its retired location is surfaced in the error context.
 */
export function adoptCodexCliLogin(
  opts: AdoptCodexOptions = {},
): AdoptCodexResult {
  const accountId = opts.accountId ?? "default";
  validateAccountId(accountId);
  const provider = "openai-codex" as const;
  const authPath = opts.codexHome
    ? path.join(opts.codexHome, "auth.json")
    : codexAuthPath();

  // Source must exist and be a regular file (a symlink here could redirect the
  // retirement rename). Only ENOENT means "no login"; any other stat failure
  // (permissions, I/O) is its own failure mode, not a silent absence.
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(authPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw adoptError(
        "adopt_codex.no_source",
        `No Codex login at ${authPath}`,
        { path: authPath },
      );
    }
    throw adoptError(
      "adopt_codex.source_stat_failed",
      `Could not stat the Codex login at ${authPath}`,
      { path: authPath },
      err,
    );
  }
  if (!stat.isFile()) {
    throw adoptError(
      "adopt_codex.not_regular_file",
      `Codex login at ${authPath} is not a regular file; refusing to adopt`,
      { path: authPath },
    );
  }

  // No implicit overwrite of an existing pool account — checked before any
  // filesystem effect so a collision leaves the world untouched.
  const existing = loadAccount(provider, accountId);
  if (existing && !opts.overwrite) {
    throw adoptError(
      "adopt_codex.account_exists",
      `A pool account "${provider}/${accountId}" already exists; pass overwrite to replace it`,
      { provider, accountId },
    );
  }

  // Retire FIRST: atomically claim whatever inode is current. The retired name
  // carries 64 random bits so it is unpredictable (nothing else can pre-create
  // or guess it) and repeated adoptions can never clobber a prior retired
  // credential file.
  const retiredTo = `${authPath}.adopted-${randomBytes(8).toString("hex")}`;
  try {
    renameSync(authPath, retiredTo);
  } catch (err) {
    throw adoptError(
      "adopt_codex.retire_failed",
      `Could not retire the Codex source at ${authPath}; exclusive ownership not established`,
      { path: authPath, retiredTo },
      err,
    );
  }

  // Read SECOND, from the retired inode we exclusively own. This is what makes
  // the transfer race-free against Codex's atomic-replace refresh writes: the
  // bytes adopted are by construction the bytes retired.
  let tokens: CodexAuthTokens;
  try {
    const raw = readRegularFile(retiredTo);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw adoptError(
        "adopt_codex.unreadable",
        `Codex login at ${authPath} is not valid JSON`,
        { path: authPath, retiredTo },
        err,
      );
    }
    tokens = validateTokens(parsed, authPath);
  } catch (err) {
    const restore = restoreRetiredSource(retiredTo, authPath);
    if (!restore.restored) {
      logger.warn(
        `[auth] adoptCodexCliLogin: validation failed and the original path is occupied; the retired source remains at ${retiredTo}`,
      );
    }
    throw err;
  }

  // A source that reappeared between the rename and here means a live Codex
  // process wrote a fresh login — it is still refreshing the chain, and the
  // copy we just retired may already hold consumed tokens. Committing it to
  // the pool would set up the exact dual-refresher revocation this operation
  // exists to prevent.
  const sourceReappeared = (() => {
    try {
      lstatSync(authPath);
      return true;
    } catch {
      // error-policy:J3 ENOENT is the healthy outcome (the source stayed
      // retired); any other stat failure also reads as "not reappeared"
      // because this is a best-effort live-refresher detector, not a
      // correctness gate — the pool==retired invariant holds regardless.
      return false;
    }
  })();
  if (sourceReappeared) {
    throw adoptError(
      "adopt_codex.concurrent_refresher",
      `A live process recreated ${authPath} during adoption; stop every running codex process and retry. The retired copy remains at ${retiredTo}`,
      { path: authPath, retiredTo },
    );
  }

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
    const restore = restoreRetiredSource(retiredTo, authPath);
    if (!restore.restored) {
      // error-policy:J6 best-effort teardown — the pool write already failed
      // and the original path is occupied by a fresher login, so the retired
      // copy stays where it is (surfaced below); the original write failure is
      // the actionable error and is rethrown.
      logger.warn(
        `[auth] adoptCodexCliLogin: pool write failed and the original path is occupied; the retired source remains at ${retiredTo}`,
      );
    }
    throw adoptError(
      "adopt_codex.pool_write_failed",
      `Pool account write failed; the Codex source was ${restore.restored ? "restored" : `left retired at ${retiredTo}`}`,
      { path: authPath, retiredTo, restored: restore.restored },
      err,
    );
  }

  return {
    accountId,
    ...(tokens.account_id ? { organizationId: tokens.account_id } : {}),
    retiredTo,
  };
}
