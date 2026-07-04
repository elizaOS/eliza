import {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { KaminoService } from "../../services/kamino";
import { parseRepayMessage } from "../../utils/parser";
import { ObligationTypeTag } from "@kamino-finance/klend-sdk";
import Decimal from "decimal.js";
import { resolveMax } from "../../utils/resolveMax";

export const RepayAction: Action = {
  name: "KAMINO_REPAY",
  similes: [
    "DEBT_REPAY",
    "LOAN_REPAY",
    "KAMINO_LOAN_REPAY",
    "REPAY_BORROWS",
    "PAY_BACK",
  ],
  description:
    "Repay borrowed debt in Kamino Lend. Use when the user wants to pay back a loan, reduce their debt, or close a borrowing position partially or fully.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => {
    try {
      const service = runtime.getService<KaminoService>("kamino-service");
      if (!service?.isInitialized()) return false;

      const params = await parseRepayMessage(runtime, message, state);
      if (!params) return false;

      const market = params.marketName
        ? service.getMarket(params.marketName)
        : service.getDefaultMarket();
      const obligation = await service.getUserObligation(
        market?.getName()!,
        ObligationTypeTag.Vanilla,
      );

      if (!obligation) return false;

      return true;
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
    try {
      const service = runtime.getService<KaminoService>("kamino-service");

      const params = await parseRepayMessage(runtime, message, state);
      if (!params) {
        await callback!({
          text: 'I need to know what token and how much you want to repay. For example: "Repay 100 USDC" or "Pay back all my SOL debt".',
          actions: ["KAMINO_REPAY"],
        });
        return;
      }

      const { token, amount, marketName } = params;

      const market = marketName
        ? service?.getMarket(marketName)
        : service?.getDefaultMarket();

      const obligation = await service?.getUserObligation(
        market?.getName()!,
        ObligationTypeTag.Vanilla,
      );
      const reserve = market?.getFloatRateReserveBySymbol(token);

      if (!reserve) {
        await callback?.({
          text: `Reserve not found for ${token}`,
          actions: ["KAMINO_REPAY"],
          error: true,
        });
        return { success: false, text: "Reserve not found" };
      }

      const tokenMint = reserve?.getLiquidityMint();
      const amountDecimal = resolveMax(amount, obligation!, reserve);

      const action = await service?.buildRepayTxns(
        market?.getName()!,
        tokenMint!,
        amountDecimal,
      );

      const tx = await service?.sendActionTransaction(action!);
      service?.invalidateObligationCache(
        market?.getName()!,
        ObligationTypeTag.Vanilla,
      );
      await callback?.({
        text: `Repayed **${amount === "max" ? "all" : amount} ${token}**. Transaction ${tx}`,
        actions: ["KAMINO_REPAY"],
        data: { token, amount, tx },
      });
      return { success: true, text: `Repay successful : ${tx}` };
    } catch (error) {
      await callback?.({
        text: `Repay failed :  ${error}`,
        data: { error },
        error: true,
      });
      return { success: false, text: `Repay failed : ${error}` };
    }
  },
  examples: [
    [
      { name: "{{user}}", content: { text: "Repay 100 USDC" } },
      {
        name: "{{agent}}",
        content: {
          text: "Repayed 100 USDC from your loans...",
          actions: ["KAMINO_REPAY"],
        },
      },
    ],
    [
      { name: "{{user}}", content: { text: "Payback 20 SOL from my loans" } },
      {
        name: "{{agent}}",
        content: {
          text: "Payed back 20 SOL from your loans...",
          actions: ["KAMINO_REPAY"],
        },
      },
    ],
  ],
};
