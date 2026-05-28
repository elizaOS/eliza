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
 * `<account>` is the URL-encoded username with dots escaped too. Vault
 * prefix matching uses dot segments, so listing `creds.github.com`
 * returns every account under that domain plus the autoallow flag.
 *
 * Sensitive values are AES-GCM encrypted by the vault. Listing returns
 * metadata only — passwords are never copied into the listing payload.
 */
import type { Vault } from "./vault.js";
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
/** Persist (or replace) a login. Stamps `lastModified` automatically. */
export declare function setSavedLogin(vault: Vault, login: Omit<SavedLogin, "lastModified">): Promise<void>;
/** Read a login. Returns null when missing. */
export declare function getSavedLogin(vault: Vault, domain: string, username: string): Promise<SavedLogin | null>;
/**
 * List logins. With no `domain`, returns every saved login summary
 * across the vault. With a domain, scopes to that hostname.
 *
 * Returns metadata only. The password values stay encrypted at rest;
 * callers must `getSavedLogin` to decrypt one entry at a time.
 */
export declare function listSavedLogins(vault: Vault, domain?: string): Promise<readonly SavedLoginSummary[]>;
/** Remove a single login. Idempotent. */
export declare function deleteSavedLogin(vault: Vault, domain: string, username: string): Promise<void>;
/** Read the autoallow flag for a domain. False when unset. */
export declare function getAutofillAllowed(vault: Vault, domain: string): Promise<boolean>;
/** Toggle the autoallow flag. `true` skips consent on next autofill for that domain. */
export declare function setAutofillAllowed(vault: Vault, domain: string, allowed: boolean): Promise<void>;
//# sourceMappingURL=credentials.d.ts.map