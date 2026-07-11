/**
 * Steward trading provider for planner context. It exposes configured trading
 * capability and governed venue readiness without leaking bearer tokens,
 * tenant secrets, SDK payloads, or raw venue responses.
 */
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { StewardTradingService } from "../services/steward-trading-service.js";
import type { TradingCapability, Venue } from "../types/trade.js";

const VENUES = [
  "hyperliquid",
  "polymarket",
] as const satisfies readonly Venue[];

function serviceFromRuntime(
  runtime: IAgentRuntime,
): StewardTradingService | null {
  const service = runtime.getService(StewardTradingService.serviceType);
  if (
    service &&
    typeof (service as StewardTradingService).capability === "function" &&
    typeof (service as StewardTradingService).resolveAccount === "function"
  ) {
    return service as StewardTradingService;
  }
  return null;
}

function summarizeCapability(capability: TradingCapability): string {
  if (!capability.canTrade) return `Unavailable: ${capability.reason}`;
  return `${capability.kind} configured for agent ${capability.agentId ?? "unknown"}`;
}

export const stewardTradingProvider: Provider = {
  name: "stewardTrading",
  description:
    "Governed trading capability/session status for Hyperliquid and Polymarket.",
  descriptionCompressed:
    "Steward trading readiness for Hyperliquid/Polymarket; no secrets",
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  roleGate: { minRole: "OWNER" },
  cacheStable: false,
  cacheScope: "turn",
  dynamic: true,
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    void _message;
    void _state;
    const service = serviceFromRuntime(runtime);
    if (!service) {
      return {
        text: "## Steward Trading\nSteward trading service is not running.",
        values: { stewardTradingReady: false },
      };
    }

    const capability = service.capability();
    if (!capability.canTrade) {
      return {
        text: `## Steward Trading\n${summarizeCapability(capability)}`,
        values: {
          stewardTradingReady: false,
          stewardTradingCapability: capability.kind,
          stewardTradingReason: capability.reason,
        },
      };
    }

    const accounts = await Promise.all(
      VENUES.map(async (venue) => {
        const result = await service.resolveAccount(venue);
        return result.ok
          ? {
              venue,
              status: result.data.status,
              accountId: result.data.accountId,
              sessionId: result.audit.sessionId,
            }
          : {
              venue,
              status:
                result.error === "SESSION_REQUIRED"
                  ? "session_required"
                  : result.outcome,
              detail: result.detail,
              retryable: result.retryable,
            };
      }),
    );

    const lines = accounts.map((account) =>
      account.status === "active"
        ? `- ${account.venue}: active (${account.accountId})`
        : `- ${account.venue}: ${account.status}`,
    );
    return {
      text: `## Steward Trading\n${summarizeCapability(capability)}\n${lines.join("\n")}`,
      values: {
        stewardTradingReady: accounts.some(
          (account) => account.status === "active",
        ),
        stewardTradingCapability: capability.kind,
        stewardTradingAgentId: capability.agentId,
        stewardTradingAccounts: accounts,
      },
    };
  },
};
