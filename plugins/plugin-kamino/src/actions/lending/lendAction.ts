import {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { KaminoService } from "../../services/kamino";
import { parseLendMessage } from "../../utils/parser";
import Decimal from "decimal.js";
import { ObligationTypeTag } from "@kamino-finance/klend-sdk";

export const LendAction: Action = {
  name: "KAMINO_LEND",
  similes: ["LEND_ON_KAMINO", "DEPOSIT_LEND", "EARN_YIELD"],
  description:
    "Lend (pure supply) tokens into Kamino Lend to earn supply APY. This does NOT use the tokens as collateral for borrowing. Use when the user wants to earn passive yield, supply liquidity, or lend assets without borrowing against them. Or if the user wants to deposit to lending pool.",
  validate: async (
    runtime: IAgentRuntime,
    memory: Memory,
  ): Promise<boolean> => {
    try {
      const service = runtime.getService<KaminoService>("kamino-service");
      if (!service?.isInitialized()) return false;
      if (!service.getAllMarkets().size) return false;
      const reserves = await service.getAllReserves();
      return reserves.length > 0 && !!service.getRpc();
    } catch {
      return false;
    }
  },
  handler: async (
    runtime: IAgentRuntime,
    memory: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback,
  ) => {
    const service = runtime.getService<KaminoService>("kamino-service");

    try {
      const params = await parseLendMessage(runtime, memory, state);
      if (!params) {
        await callback?.({
          text: 'I need to know what token and how much you want to lend. For example: "Lend 100 USDC" Or "Supply 50 SOL for yield".',
          actions: ["KAMINO_LEND"],
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
          text: `Market "${marketName}" not found.`,
          actions: ["KAMINO_LEND"],
          error: true,
        });
        return { success: false, text: "Market not found" };
      }

      const reserve = market.getFloatRateReserveBySymbol(token);
      if (!reserve) {
        await callback?.({
          text: `Reserve for ${token} not found in market ${market.getName()}.`,
          actions: ["KAMINO_LEND"],
          error: true,
        });
        return { success: false, text: "Reserve not found." };
      }

      const tokenMint = reserve.getLiquidityMint();
      const amountDecimal = new Decimal(amount);

      const action = await service?.buildLendTxns(
        marketName || "default",
        tokenMint,
        amountDecimal,
      );
      const tx = await service?.sendActionTransaction(action!);

      service?.invalidateObligationCache(
        marketName || "default",
        ObligationTypeTag.Lending,
      );

      await callback!({
        text: `Lending successful! **${amount} ${token}** deposited into Kamino Lend.\n\nTransaction: ${tx!.join(", ")}`,
        actions: ["KAMINO_LEND"],
        data: { token, amount, tx },
      });
      return { success: true, text: `Lending successful : ${tx}` };
    } catch (error) {
      await callback?.({
        text: `Lending failed: ${error}`,
        actions: ["KAMINO_LEND"],
        data: { error: String(error) },
      });
      return { success: false, text: String(error) };
    }
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "Lend 100 USDC" } },
      {
        name: "{{agentName}}",
        content: {
          text: "Successfully lent 100 USDC into Kamino Lend...",
          actions: ["KAMINO_LEND"],
        },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "Supply 50 SOL for yield" } },
      {
        name: "{{agentName}}",
        content: {
          text: "Successfully supplied 50 SOL...",
          actions: ["KAMINO_LEND"],
        },
      },
    ],
  ],
};
