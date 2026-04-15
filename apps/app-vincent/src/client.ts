/**
 * Vincent domain methods — OAuth registration, token exchange, status, disconnect.
 */

/** Declaration merging must target the module that declares `ElizaClient` (see `declare module` below). */
import { ElizaClient } from "@elizaos/app-core/api/client-base";

// ── Types ─────────────────────────────────────────────────────────────

export interface VincentStatusResponse {
  connected: boolean;
  connectedAt: number | null;
}

// ── Declaration merging ───────────────────────────────────────────────

export interface VincentStartLoginResponse {
  authUrl: string;
  state: string;
  redirectUri: string;
}

declare module "@elizaos/app-core/api/client-base" {
  interface ElizaClient {
    vincentStartLogin(appName?: string): Promise<VincentStartLoginResponse>;
    vincentRegister(
      appName: string,
      redirectUris: string[],
    ): Promise<{ client_id: string }>;
    vincentExchangeToken(
      code: string,
      clientId: string,
      codeVerifier: string,
    ): Promise<{ ok: boolean; connected: boolean }>;
    vincentStatus(): Promise<VincentStatusResponse>;
    vincentDisconnect(): Promise<{ ok: boolean }>;
  }
}

// ── Implementation ────────────────────────────────────────────────────

ElizaClient.prototype.vincentStartLogin = async function (appName?: string) {
  return this.fetch("/api/vincent/start-login", {
    method: "POST",
    body: JSON.stringify({ appName: appName ?? "Eliza" }),
  });
};

ElizaClient.prototype.vincentRegister = async function (
  appName: string,
  redirectUris: string[],
) {
  return this.fetch("/api/vincent/register", {
    method: "POST",
    body: JSON.stringify({ appName, redirectUris }),
  });
};

ElizaClient.prototype.vincentExchangeToken = async function (
  code: string,
  clientId: string,
  codeVerifier: string,
) {
  return this.fetch("/api/vincent/token", {
    method: "POST",
    body: JSON.stringify({ code, clientId, codeVerifier }),
  });
};

ElizaClient.prototype.vincentStatus = async function () {
  return this.fetch("/api/vincent/status");
};

ElizaClient.prototype.vincentDisconnect = async function () {
  return this.fetch("/api/vincent/disconnect", { method: "POST" });
};
