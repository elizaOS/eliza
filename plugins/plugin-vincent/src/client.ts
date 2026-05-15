/**
 * Vincent domain methods — OAuth status, dashboard, and strategy settings.
 */

/**
 * Frontend client extensions are installed on the UI package's ElizaClient
 * prototype and exposed through a locally typed client wrapper.
 */
import { client as baseClient, ElizaClient } from "@elizaos/ui";
import type {
  VincentStartLoginResponse,
  VincentStatusResponse,
  VincentStrategyResponse,
  VincentStrategyUpdateRequest,
  VincentStrategyUpdateResponse,
  VincentTradingProfileResponse,
} from "./vincent-contracts";

export interface VincentClientMethods {
  vincentStartLogin(appName?: string): Promise<VincentStartLoginResponse>;
  vincentStatus(): Promise<VincentStatusResponse>;
  vincentDisconnect(): Promise<{ ok: boolean }>;
  vincentStrategy(): Promise<VincentStrategyResponse>;
  vincentUpdateStrategy(
    request: VincentStrategyUpdateRequest,
  ): Promise<VincentStrategyUpdateResponse>;
  vincentTradingProfile(): Promise<VincentTradingProfileResponse>;
}

const vincentPrototype = ElizaClient.prototype as ElizaClient &
  VincentClientMethods;

// ── Implementation ────────────────────────────────────────────────────

vincentPrototype.vincentStartLogin = async function (appName?: string) {
  return this.fetch("/api/vincent/start-login", {
    method: "POST",
    body: JSON.stringify({ appName: appName ?? "Eliza" }),
  });
};

vincentPrototype.vincentStatus = async function () {
  return this.fetch("/api/vincent/status");
};

vincentPrototype.vincentDisconnect = async function () {
  return this.fetch("/api/vincent/disconnect", { method: "POST" });
};

vincentPrototype.vincentStrategy = async function () {
  return this.fetch("/api/vincent/strategy");
};

vincentPrototype.vincentUpdateStrategy = async function (
  request: VincentStrategyUpdateRequest,
) {
  return this.fetch("/api/vincent/strategy", {
    method: "POST",
    body: JSON.stringify(request),
  });
};

vincentPrototype.vincentTradingProfile = async function () {
  return this.fetch("/api/vincent/trading-profile");
};

export const vincentClient = baseClient as typeof baseClient &
  VincentClientMethods;
