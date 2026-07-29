/**
 * Resolves the Aomi endpoint, app routing, and default-chain settings from the Eliza runtime.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";

export interface AomiConfig {
  readonly apiUrl: string;
  readonly apiKey?: string;
  readonly app: string;
  readonly applicationId?: string;
  readonly chainId: number;
  readonly evmRpcUrl?: string;
}

function optionalString(
  runtime: IAgentRuntime,
  key: string,
): string | undefined {
  const value = runtime.getSetting(key);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function positiveInteger(
  value: string | number | boolean | object | null | undefined,
  fallback: number,
): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readAomiConfig(runtime: IAgentRuntime): AomiConfig {
  const apiUrl =
    optionalString(runtime, "AOMI_API_URL") ?? "https://api.aomi.dev";
  let normalizedUrl: string;
  try {
    normalizedUrl = new URL(apiUrl).toString().replace(/\/$/, "");
  } catch (cause) {
    // error-policy:J2 A malformed operator setting needs a classified cause.
    throw new ElizaError("AOMI_API_URL must be an absolute URL.", {
      code: "AOMI_INVALID_API_URL",
      context: { apiUrl },
      cause,
      severity: "fatal",
    });
  }

  return {
    apiUrl: normalizedUrl,
    apiKey: optionalString(runtime, "AOMI_API_KEY"),
    app: optionalString(runtime, "AOMI_APP") ?? "default",
    applicationId: optionalString(runtime, "AOMI_APPLICATION_ID"),
    chainId: positiveInteger(runtime.getSetting("AOMI_CHAIN_ID"), 1),
    evmRpcUrl: optionalString(runtime, "AOMI_EVM_RPC_URL"),
  };
}
