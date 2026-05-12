/**
 * Vault domain methods — saved-login autofill for the in-app browser.
 *
 * Mirrors the wallet-shim contract: the in-tab preload sends
 * `__elizaVaultAutofillRequest` to the host, the host calls these
 * methods, then replies via `tag.executeJavascript("window.__elizaVaultReply(...)")`.
 *
 * The list endpoint aggregates entries from every signed-in backend:
 * in-house vault, 1Password, and Bitwarden. Each entry carries a
 * `source` + `identifier` pair so callers can reveal credentials
 * uniformly via `revealSavedLogin(source, identifier)`.
 */

import { ElizaClient } from "./client-base";

export type SavedLoginSource = "in-house" | "1password" | "bitwarden";

export interface SavedLoginListRecord {
  source: SavedLoginSource;
  identifier: string;
  domain: string | null;
  username: string;
  title: string;
  updatedAt: number;
}

export interface SavedLoginListFailure {
  source: "1password" | "bitwarden";
  message: string;
}

export interface SavedLoginRevealRecord {
  source: SavedLoginSource;
  identifier: string;
  username: string;
  password: string;
  totp?: string;
  domain: string | null;
}

declare module "./client-base" {
  interface ElizaClient {
    listSavedLogins(domain?: string): Promise<{
      logins: readonly SavedLoginListRecord[];
      failures: readonly SavedLoginListFailure[];
    }>;
    revealSavedLogin(
      source: SavedLoginSource,
      identifier: string,
    ): Promise<SavedLoginRevealRecord>;
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
  const res = await this.fetch<{
    ok: boolean;
    logins: readonly SavedLoginListRecord[];
    failures: readonly SavedLoginListFailure[];
  }>(path);
  return { logins: res.logins, failures: res.failures };
};

ElizaClient.prototype.revealSavedLogin = async function (
  this: ElizaClient,
  source,
  identifier,
) {
  const params = new URLSearchParams({ source, identifier });
  const path = `/api/secrets/logins/reveal?${params.toString()}`;
  const res = await this.fetch<{
    ok: boolean;
    login: SavedLoginRevealRecord;
  }>(path);
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
