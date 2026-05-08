import type { HandlerOptions, IAgentRuntime } from "@elizaos/core";
import { resolveLinearAccountId } from "../accounts";

export function getLinearActionOptions(
  options?: HandlerOptions | Record<string, unknown>,
): Record<string, unknown> {
  const direct = (options ?? {}) as Record<string, unknown>;
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as Record<string, unknown>)
      : {};
  return { ...direct, ...parameters };
}

export function getLinearAccountId(
  runtime: IAgentRuntime,
  options?: HandlerOptions | Record<string, unknown>,
): string {
  return resolveLinearAccountId(runtime, getLinearActionOptions(options));
}

export const linearAccountIdParameter = {
  name: "accountId",
  description:
    "Optional Linear account id from LINEAR_ACCOUNTS. Defaults to LINEAR_DEFAULT_ACCOUNT_ID or the legacy single API key.",
  required: false,
  schema: { type: "string" as const },
};
