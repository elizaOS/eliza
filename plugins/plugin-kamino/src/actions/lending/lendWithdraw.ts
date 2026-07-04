import {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { KaminoService } from "../../services/kamino";
import { parseLendWithdrawMessage } from "../../utils/parser";
import { ObligationTypeTag } from "@kamino-finance/klend-sdk";
import { resolveMax } from "../../utils/resolveMax";

export const LendWithdraw: Action = {
  name: "KAMINO_LEND_WITHDRAW",
  similes: [
    "LEND_WITHDRAW",
    "WITHDRAW_LEND_DEPOSITS",
    "WITHDRAW_FROM_KAMINO_LEND",
    "WITHDRAW_SUPPLY",
  ],
  description:
    "Withdraw deposits from a lending position in Kamino. Use when the user wants to exit their lending/supply position and reclaim their tokens plus earned interest.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => {
    try {
      const service = runtime.getService<KaminoService>("kamino-service");
      if (!service?.isInitialized()) return false;

      const params = await parseLendWithdrawMessage(runtime, message, state);
      if (!params) return false;

      let { marketName } = params;
      if (!marketName) marketName = "main";

      const userObligation = await service.getUserObligation(
        marketName,
        ObligationTypeTag.Lending,
      );
      return !!userObligation && userObligation.deposits.values.length > 0;
    } catch {
      return false;
    }
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback,
  ) => {
    const service = runtime.getService<KaminoService>("kamino-service");

    try {
      const params = await parseLendWithdrawMessage(runtime, message, state);
      if (!params) {
        await callback?.({
          text: 'I need to know what token and how much you want to withdraw. For example: "Withdraw 100 USDC from lending" or "Redeem all my SOL supply"',
          actions: ["KAMINO_LEND_WITHDRAW"],
          error: true,
        });
        return { success: false, text: "Token and amount not provided." };
      }
      const { token, amount, marketName } = params;
      const market = marketName
        ? service?.getMarket(marketName)
        : service?.getDefaultMarket();
      if (!market) {
        await callback?.({
          text: `Market ${marketName} not found.`,
          actions: ["KAMINO_LEND_WITHDRAW"],
          error: true,
        });
        return { success: false, text: "Market not found." };
      }
      const reserve = market?.getFloatRateReserveBySymbol(token);
      if (!reserve) {
        await callback?.({
          text: `Reserve for ${token} not found in ${market.getName()}`,
          actions: ["KAMINO_LEND_WITHDRAW"],
          error: true,
        });
        return { success: false, text: "Reserve not found" };
      }

      const tokenMint = reserve.getLiquidityMint();

      const obligation = await service?.getUserObligation(
        market.getName(),
        ObligationTypeTag.Lending,
      );
      if (!obligation) {
        await callback?.({
          text: `Can't find you lending obligation for ${marketName}`,
          actions: ["KAMINO_LEND_WITHDRAW"],
          error: true,
        });
        return { success: false, text: "User obligation not found." };
      }

      const amountDecimal = resolveMax(amount, obligation, reserve);
      const action = await service?.buildLendWithdrawTxns(
        market.getName(),
        tokenMint,
        amountDecimal!,
      );

      const tx = await service?.sendActionTransaction(action!);
      service?.invalidateObligationCache(
        market?.getName(),
        ObligationTypeTag.Lending,
      );

      await callback?.({
        text: `Withdraw of **${amount == "max" ? "all" : amount} ${token}** from Kamino lending is successful.\n\nTransaction: ${tx?.join(", ")}`,
        actions: ["KAMINO_LEND_WITHDRAW"],
        data: { token, amount, tx },
      });
      return { success: true, text: `Withdraw successful : ${tx}` };
    } catch (error) {
      await callback?.({
        text: `Withdraw failed: ${error}`,
        actions: ["KAMINO_LEND_WITHDRAW"],
        data: { error: String(error) },
      });
      return { success: false, text: String(error) };
    }
  },
  examples: [
    [
      { name: "{{user}}", content: { text: "Withdraw 50 USDC from lending" } },
      {
        name: "{{agentName}}",
        content: {
          text: "Withdraw of 50 USDC from Kamino lending is successful...",
          actions: ["KAMINO_LEND_WITHDRAW"],
        },
      },
    ],
    [
      { name: "{{user}}", content: { text: "Redeem all my SOL supply" } },
      {
        name: "{{agentName}}",
        content: {
          text: "Successfully redeemed all SOL...",
          actions: ["KAMINO_LEND_WITHDRAW"],
        },
      },
    ],
  ],
};
