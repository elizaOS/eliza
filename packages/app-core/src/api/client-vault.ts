/**
 * Vault domain methods — saved-login autofill for the in-app browser.
 *
 * Mirrors the wallet-shim contract: the in-tab preload sends
 * `__elizaVaultAutofillRequest` to the host, the host calls these
 * methods, then replies via `tag.executeJavascript("window.__elizaVaultReply(...)")`.
 */

import { ElizaClient } from "./client-base";

export interface SavedLoginRecord {
  domain: string;
  username: string;
  password: string;
  otpSeed?: string;
  notes?: string;
  lastModified: number;
}

export interface SavedLoginSummaryRecord {
  domain: string;
  username: string;
  lastModified: number;
}

declare module "./client-base" {
  interface ElizaClient {
    listSavedLogins(
      domain?: string,
    ): Promise<readonly SavedLoginSummaryRecord[]>;
    getSavedLogin(
      domain: string,
      username: string,
    ): Promise<SavedLoginRecord | null>;
    saveSavedLogin(input: {
      domain: string;
      username: string;
      password: string;
      otpSeed?: string;
      notes?: string;
    }): Promise<void>;
    deleteSavedLogin(domain: string, username: string): Promise<void>;
    getAutofillAllowed(domain: string): Promise<boolean>;
    setAutofillAllowed(domain: string, allowed: boolean): Promise<void>;
  }
}

ElizaClient.prototype.listSavedLogins = async function (
  this: ElizaClient,
  domain,
) {
  const path = domain
    ? `/api/secrets/logins?domain=${encodeURIComponent(domain)}`
    : "/api/secrets/logins";
  const out = (
    await this.fetch<{
      ok: boolean;
      logins: readonly SavedLoginSummaryRecord[];
    }>(path)
  ).logins;
  return out;
};

ElizaClient.prototype.getSavedLogin = async function (
  this: ElizaClient,
  domain,
  username,
) {
  const path = `/api/secrets/logins/${encodeURIComponent(domain)}/${encodeURIComponent(username)}`;
  const res = await this.fetch<{
    ok: boolean;
    login: SavedLoginRecord;
  }>(path, undefined, { allowNonOk: true });
  // `allowNonOk` returns the parsed body even on 404; the caller maps
  // a missing login to null. The fetch wrapper still throws on network
  // failures, which we propagate.
  if (!res?.ok) return null;
  return res.login;
};

ElizaClient.prototype.saveSavedLogin = async function (
  this: ElizaClient,
  input,
) {
  await this.fetch<{ ok: boolean }>("/api/secrets/logins", {
    method: "POST",
    body: JSON.stringify(input),
  });
};

ElizaClient.prototype.deleteSavedLogin = async function (
  this: ElizaClient,
  domain,
  username,
) {
  const path = `/api/secrets/logins/${encodeURIComponent(domain)}/${encodeURIComponent(username)}`;
  await this.fetch<{ ok: boolean }>(path, { method: "DELETE" });
};

ElizaClient.prototype.getAutofillAllowed = async function (
  this: ElizaClient,
  domain,
) {
  const path = `/api/secrets/logins/${encodeURIComponent(domain)}/autoallow`;
  const res = await this.fetch<{ ok: boolean; allowed: boolean }>(path);
  return res.allowed;
};

ElizaClient.prototype.setAutofillAllowed = async function (
  this: ElizaClient,
  domain,
  allowed,
) {
  const path = `/api/secrets/logins/${encodeURIComponent(domain)}/autoallow`;
  await this.fetch<{ ok: boolean }>(path, {
    method: "PUT",
    body: JSON.stringify({ allowed }),
  });
};
