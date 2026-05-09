/**
 * Vincent domain methods — OAuth status, dashboard, and strategy settings.
 */

/**
 * Declaration merging must target the module that declares `ElizaClient`.
 * Import from the source module (`@elizaos/app-core/api/client-base`) — NOT
 * from the `@elizaos/app-core` barrel — to avoid a circular dependency.
 * `app-core/api/client.ts` imports this file (Vincent extension) AFTER
 * defining `ElizaClient` but BEFORE re-exporting it through the barrel, so
 * a barrel import here resolves to `undefined` when this file evaluates.
 * Going direct to the source module breaks the cycle.
 */
import { ElizaClient } from "@elizaos/app-core";
import type {
  VincentStartLoginResponse,
  VincentStatusResponse,
  VincentStrategyResponse,
  VincentStrategyUpdateRequest,
  VincentStrategyUpdateResponse,
  VincentTradingProfileResponse,
} from "./vincent-contracts";

declare module "@elizaos/app-core/api/client-base" {
  interface ElizaClient {
    vincentStartLogin(appName?: string): Promise<VincentStartLoginResponse>;
    vincentStatus(): Promise<VincentStatusResponse>;
    vincentDisconnect(): Promise<{ ok: boolean }>;
    vincentStrategy(): Promise<VincentStrategyResponse>;
    vincentUpdateStrategy(
      request: VincentStrategyUpdateRequest,
    ): Promise<VincentStrategyUpdateResponse>;
    vincentTradingProfile(): Promise<VincentTradingProfileResponse>;
  }
}

// ── Implementation ────────────────────────────────────────────────────

ElizaClient.prototype.vincentStartLogin = async function (appName?: string) {
  return this.fetch("/api/vincent/start-login", {
    method: "POST",
    body: JSON.stringify({ appName: appName ?? "Eliza" }),
  });
};

ElizaClient.prototype.vincentStatus = async function () {
  return this.fetch("/api/vincent/status");
};

ElizaClient.prototype.vincentDisconnect = async function () {
  return this.fetch("/api/vincent/disconnect", { method: "POST" });
};

ElizaClient.prototype.vincentStrategy = async function () {
  return this.fetch("/api/vincent/strategy");
};

ElizaClient.prototype.vincentUpdateStrategy = async function (
  request: VincentStrategyUpdateRequest,
) {
  return this.fetch("/api/vincent/strategy", {
    method: "POST",
    body: JSON.stringify(request),
  });
};

ElizaClient.prototype.vincentTradingProfile = async function () {
  return this.fetch("/api/vincent/trading-profile");
};
