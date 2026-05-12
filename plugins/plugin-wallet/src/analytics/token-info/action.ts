import type {
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { parseTokenInfoParams } from "./params";
import { TOKEN_INFO_SERVICE_TYPE, type TokenInfoService } from "./service";

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
    error: String(data.error ?? "TOKEN_INFO_UNAVAILABLE"),
    data: data as ActionResult["data"],
  };
}

/**
 * Folded into WALLET as `action=token_info`. Routes token-info queries through
 * the registered TokenInfoService providers (DexScreener, Birdeye, CoinGecko).
 */
export async function tokenInfoHandler(
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
      subaction: "token_info",
      error: "SERVICE_UNAVAILABLE",
    });
  }

  const params = parseTokenInfoParams(message, state, options);
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
        subaction: "token_info",
        target: routed.provider.name,
        supportedProviders: service.listProviders(),
      },
    };
  }

  return unavailable(callback, routed.detail, {
    actionName: "WALLET",
    subaction: "token_info",
    error: routed.error,
    detail: routed.detail,
    providers: routed.providers,
  });
}
