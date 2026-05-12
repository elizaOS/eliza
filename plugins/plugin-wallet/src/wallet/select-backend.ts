import type { IAgentRuntime } from "@elizaos/core";
import type { WalletBackend } from "./backend.js";
import { LocalEoaBackend } from "./local-eoa-backend.js";
import { StewardBackend } from "./steward-backend.js";

export type WalletBackendMode = "local" | "steward" | "auto";

function readMode(runtime: IAgentRuntime): WalletBackendMode {
  const raw =
    runtime.getSetting("ELIZA_WALLET_BACKEND") ??
    process.env.ELIZA_WALLET_BACKEND ??
    "auto";
  if (raw === "local" || raw === "steward" || raw === "auto") {
    return raw;
  }
  return "auto";
}

function preferStewardInAuto(): boolean {
  if (process.env.ELIZA_WALLET_STEWARD_AUTO === "1") {
    return true;
  }
  return process.env.ELIZA_CLOUD_PROVISIONED === "1";
}

/**
 * Resolves the active wallet backend.
 *
 * - `local` — env keys only ({@link LocalEoaBackend}).
 * - `steward` — Steward API signing ({@link StewardBackend}).
 * - `auto` — Steward when cloud-provisioned or `ELIZA_WALLET_STEWARD_AUTO=1`, otherwise local.
 */
export async function resolveWalletBackend(
  runtime: IAgentRuntime,
): Promise<WalletBackend> {
  const mode = readMode(runtime);
  if (mode === "steward") {
    return StewardBackend.create(runtime);
  }
  if (mode === "local") {
    return LocalEoaBackend.create(runtime);
  }
  if (preferStewardInAuto()) {
    return StewardBackend.create(runtime);
  }
  return LocalEoaBackend.create(runtime);
}
