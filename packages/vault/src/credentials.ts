/**
 * Saved-login helpers for in-app browser autofill.
 *
 * The browser tab preload detects login forms and asks the host for
 * matching credentials. The host reads them from the vault using the
 * helpers here. Storage layout:
 *
 *   creds.<domain>.<account>           → JSON-encoded SavedLoginRecord, sensitive
 *   creds.<domain>.__autoallow         → "1" / "0", non-sensitive (whitelist toggle)
 *
 * `<domain>` is the registrable hostname (e.g. `github.com`, no port).
 * `<account>` is the URL-encoded username (so `@`, `/`, `.` are safe in
 * the segment). Vault prefix matching uses dot segments, so listing
 * `creds.github.com` returns every account under that domain plus the
 * autoallow flag.
 *
 * Sensitive values are AES-GCM encrypted by the vault. Listing returns
 * metadata only — passwords are never copied into the listing payload.
 */

import type { Vault } from "./vault.js";

const PREFIX = "creds";
// Sentinel for the per-domain autoallow flag. The colon prefix is URL-
// encoded by `encodeAccount`, so a literal username `:autoallow` lives at
// `%3Aautoallow` and cannot collide with this sentinel.
const AUTOALLOW_SEGMENT = ":autoallow";

export interface SavedLogin {
  /** Registrable hostname, e.g. `github.com`. Lower-cased on write. */
  readonly domain: string;
  /** User identifier as typed: email, handle, etc. */
  readonly username: string;
  /** Plaintext password. Encrypted at rest by the vault. */
  readonly password: string;
  /** TOTP seed for sites with 2FA. */
  readonly otpSeed?: string;
  /** Free-form note. */
  readonly notes?: string;
  /** Unix ms of last write. Set by `setSavedLogin`. */
  readonly lastModified: number;
}

export interface SavedLoginSummary {
  readonly domain: string;
  readonly username: string;
  readonly lastModified: number;
}

/** Encode an account segment so vault key parsing stays unambiguous. */
function encodeAccount(username: string): string {
  return encodeURIComponent(username);
}

function decodeAccount(segment: string): string {
  return decodeURIComponent(segment);
}

/** Lower-case domains so `Github.com` and `github.com` collide. */
function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

function loginKey(domain: string, username: string): string {
  return `${PREFIX}.${normalizeDomain(domain)}.${encodeAccount(username)}`;
}

function autoallowKey(domain: string): string {
  return `${PREFIX}.${normalizeDomain(domain)}.${AUTOALLOW_SEGMENT}`;
}

/** Persist (or replace) a login. Stamps `lastModified` automatically. */
export async function setSavedLogin(
  vault: Vault,
  login: Omit<SavedLogin, "lastModified">,
): Promise<void> {
  if (login.domain.trim().length === 0) {
    throw new TypeError("setSavedLogin: domain required");
  }
  if (login.username.length === 0) {
    throw new TypeError("setSavedLogin: username required");
  }
  if (typeof login.password !== "string" || login.password.length === 0) {
    throw new TypeError("setSavedLogin: password required");
  }
  const record: SavedLogin = {
    domain: normalizeDomain(login.domain),
    username: login.username,
    password: login.password,
    ...(login.otpSeed ? { otpSeed: login.otpSeed } : {}),
    ...(login.notes ? { notes: login.notes } : {}),
    lastModified: Date.now(),
  };
  await vault.set(
    loginKey(login.domain, login.username),
    JSON.stringify(record),
    { sensitive: true },
  );
}

/** Read a login. Returns null when missing. */
export async function getSavedLogin(
  vault: Vault,
  domain: string,
  username: string,
): Promise<SavedLogin | null> {
  const key = loginKey(domain, username);
  const has = await vault.has(key);
  if (!has) return null;
  const raw = await vault.get(key);
  return parseLogin(raw);
}

/**
 * List logins. With no `domain`, returns every saved login summary
 * across the vault. With a domain, scopes to that hostname.
 *
 * Returns metadata only. The password values stay encrypted at rest;
 * callers must `getSavedLogin` to decrypt one entry at a time.
 */
export async function listSavedLogins(
  vault: Vault,
  domain?: string,
): Promise<readonly SavedLoginSummary[]> {
  const prefix = domain ? `${PREFIX}.${normalizeDomain(domain)}` : PREFIX;
  const keys = await vault.list(prefix);
  const summaries: SavedLoginSummary[] = [];
  for (const key of keys) {
    const parsed = parseLoginKey(key);
    if (!parsed) continue;
    if (parsed.account === AUTOALLOW_SEGMENT) continue;
    const descriptor = await vault.describe(key);
    if (!descriptor) continue;
    // describe() returns lastModified directly; we don't need to
    // decrypt the value to render the listing UI.
    summaries.push({
      domain: parsed.domain,
      username: decodeAccount(parsed.account),
      lastModified: descriptor.lastModified,
    });
  }
  return summaries;
}

/** Remove a single login. Idempotent. */
export async function deleteSavedLogin(
  vault: Vault,
  domain: string,
  username: string,
): Promise<void> {
  await vault.remove(loginKey(domain, username));
}

/** Read the autoallow flag for a domain. False when unset. */
export async function getAutofillAllowed(
  vault: Vault,
  domain: string,
): Promise<boolean> {
  const key = autoallowKey(domain);
  if (!(await vault.has(key))) return false;
  const raw = await vault.get(key);
  return raw === "1";
}

/** Toggle the autoallow flag. `true` skips consent on next autofill for that domain. */
export async function setAutofillAllowed(
  vault: Vault,
  domain: string,
  allowed: boolean,
): Promise<void> {
  await vault.set(autoallowKey(domain), allowed ? "1" : "0");
}

// ── internals ─────────────────────────────────────────────────────────

interface ParsedLoginKey {
  readonly domain: string;
  readonly account: string;
}

function parseLoginKey(key: string): ParsedLoginKey | null {
  // creds.<domain>.<account-or-flag>
  // We split on the first two dots: the first separates the prefix,
  // the second separates the domain from the account segment.
  if (!key.startsWith(`${PREFIX}.`)) return null;
  const rest = key.slice(PREFIX.length + 1);
  // The domain part itself contains dots (e.g. github.com), so the
  // account segment is everything after the LAST dot.
  const lastDot = rest.lastIndexOf(".");
  if (lastDot <= 0) return null;
  const domain = rest.slice(0, lastDot);
  const account = rest.slice(lastDot + 1);
  if (!domain || !account) return null;
  return { domain, account };
}

function parseLogin(raw: string): SavedLogin {
  const parsed = JSON.parse(raw) as Partial<SavedLogin>;
  if (
    typeof parsed.domain !== "string" ||
    typeof parsed.username !== "string" ||
    typeof parsed.password !== "string" ||
    typeof parsed.lastModified !== "number"
  ) {
    throw new Error(
      `vault credentials: stored entry is malformed (got keys: ${Object.keys(parsed).join(", ")})`,
    );
  }
  return {
    domain: parsed.domain,
    username: parsed.username,
    password: parsed.password,
    ...(parsed.otpSeed ? { otpSeed: parsed.otpSeed } : {}),
    ...(parsed.notes ? { notes: parsed.notes } : {}),
    lastModified: parsed.lastModified,
  };
}
