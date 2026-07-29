/**
 * Supplies bounded Aomi availability, connected-address, and pending-confirmation context to the planner.
 */
import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { AomiService } from "./service.js";

const MAX_PROVIDER_TEXT_CHARS = 1_500;

export const aomiProvider: Provider = {
  name: "aomi",
  description:
    "Aomi on-chain agent availability and pending wallet confirmation state.",
  descriptionCompressed:
    "Aomi on-chain delegation status and pending confirmed wallet request",
  contexts: ["finance", "crypto", "wallet", "onchain"],
  contextGate: { anyOf: ["finance", "crypto", "wallet", "onchain"] },
  roleGate: { minRole: "OWNER" },
  cacheStable: false,
  cacheScope: "turn",
  dynamic: true,
  position: -4,
  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    void _state;
    const service = runtime.getService<AomiService>(AomiService.serviceType);
    if (!service) {
      return {
        text: "## Aomi\nAomi service is not running.",
        values: { aomiReady: false },
      };
    }

    const status = service.status(String(message.roomId));
    const lines = [
      "## Aomi",
      `Endpoint: ${status.apiUrl}`,
      `App: ${status.app}`,
      `Wallet ready: ${status.walletReady ? "yes" : "no"}`,
      `EVM: ${status.evmAddress ?? "not configured"}`,
      `Solana: ${status.solanaAddress ?? "not configured"}`,
    ];
    if (status.pending) {
      lines.push(
        "",
        "A wallet request is awaiting this user's yes/no reply:",
        status.pending.preview,
      );
    }

    return {
      text: lines.join("\n").slice(0, MAX_PROVIDER_TEXT_CHARS),
      values: {
        aomiReady: true,
        aomiWalletReady: status.walletReady,
        aomiPendingConfirmation: status.pending !== null,
      },
      data: {
        app: status.app,
        walletReady: status.walletReady,
        pendingRequestKind: status.pending?.request.kind ?? null,
      },
    };
  },
};
