import type {
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { parseTokenInfoParams } from "../../token-info/params";
import {
  TOKEN_INFO_SERVICE_TYPE,
  type TokenInfoService,
} from "../../token-info/service";

function unavailable(
  callback: HandlerCallback | undefined,
  text: string,
  data: Record<string, unknown>,
): ActionResult {
  const dataAsContent = data as Parameters<HandlerCallback>[0]["data"];
  callback?.({ text, actions: ["WALLET"], data: dataAsContent });
  return {
    success: false,
    text,
    error: String(data.error ?? "BIRDEYE_SEARCH_UNAVAILABLE"),
    data: data as ActionResult["data"],
  };
}

/**
 * Folded into WALLET as `action=search_address`. Forces the TokenInfoService
 * route through the Birdeye provider with the `wallet` subaction so callers get
 * Birdeye portfolio data for a wallet address.
 */
export async function walletSearchAddressHandler(
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
  options?: HandlerOptions | Record<string, unknown>,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const service = runtime.getService(
    TOKEN_INFO_SERVICE_TYPE,
  ) as TokenInfoService | null;
  if (!service || typeof service.route !== "function") {
    return unavailable(callback, "Token info service is not available.", {
      actionName: "WALLET",
      subaction: "search_address",
      error: "SERVICE_UNAVAILABLE",
    });
  }

  const baseParams = parseTokenInfoParams(message, state, options);
  const params = {
    ...baseParams,
    target: "birdeye",
    subaction: "wallet" as const,
  };

  const routed = await service.route({
    runtime,
    message,
    state,
    options,
    params,
    callback,
  });

  if (routed.ok) {
    const result = routed.result;
    return {
      ...result,
      data: {
        ...(result.data ?? {}),
        actionName: "WALLET",
        subaction: "search_address",
        target: routed.provider.name,
      },
    };
  }

  return unavailable(callback, routed.detail, {
    actionName: "WALLET",
    subaction: "search_address",
    error: routed.error,
    detail: routed.detail,
    providers: routed.providers,
  });
}
