import {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { KaminoService } from "../../services/kamino";
import { parseDepositMessage } from "../../utils/parser";
import Decimal from "decimal.js";
import { ObligationTypeTag } from "@kamino-finance/klend-sdk";

export const depositAction: Action = {
  name: "KAMINO_DEPOSIT",
  similes: [
    "COLLATERAL_DEPOSIT",
    "DEPOSIT_ON_KAMINO",
    "KAMINO_BORROW_DEPOSIT",
    "SUPPLY_COLLATERAL",
  ],
  description:
    "Deposit tokens as collateral into Kamino lend. This enables borrowing against the deposited assets. Use when the user wants to collateral before borrowing , or increase their collateral position.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService<KaminoService>("kamino-service");
    const isInitialized = service?.isInitialized();
    return isInitialized ?? false;
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
      const params = await parseDepositMessage(runtime, message, state);
      if (!params) {
        await callback?.({
          text: 'I need to know what token and how much you want to deposit as collateral. For example: "Deposit 10 SOL as collateral" or "Add 500 USDC collateral" .',
          actions: ["KAMINO_DEPOSIT"],
          error: true,
        });
        return { success: false, text: "Token name and amount not provided." };
      }

      const { token, amount, marketName } = params;
      const market = marketName
        ? service?.getMarket(marketName)
        : service?.getDefaultMarket();

      if (!market) {
        await callback?.({
          text: `Market "${marketName || "default"}" not found`,
          actions: ["KAMINO_DEPOSIT"],
          error: true,
        });
        return { success: false, text: "Market not found" };
      }

      const reserve = market.getFloatRateReserveBySymbol(token);
      if (!reserve) {
        await callback?.({
          text: `Reserve for ${token} not found.`,
          actions: ["KAMINO_DEPOSIT"],
          error: true,
        });
        return { success: false, text: "Reserve not found." };
      }

      const tokenMint = reserve.getLiquidityMint();
      const amountDecimal = new Decimal(amount);

      const action = await service?.buildDepositTxns(
        market.getName(),
        tokenMint,
        amountDecimal,
      );

      const tx = await service?.sendActionTransaction(action!);
      service?.invalidateObligationCache(
        market.getName(),
        ObligationTypeTag.Vanilla,
      );

      await callback?.({
        text: `Successfully deposited **${amount} ${token}** as collateral.\n\nTransaction: ${tx?.join(", ")}`,
        actions: ["KAMINO_DEPOSIT"],
        data: { token, amount, tx },
      });
      return { success: true, text: `Deposit successful : ${tx}` };
    } catch (error) {
      await callback?.({
        text: `Deposit failed: ${error}`,
        actions: ["KAMINO_DEPOSIT"],
        data: { error: String(error) },
      });
      return { success: false, text: String(error) };
    }
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "Deposit 10 SOL as collateral" } },
      {
        name: "{{agentName}}",
        content: {
          text: "Successfully deposited 10 SOL collateral...",
          actions: ["KAMINO_DEPOSIT"],
        },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "Add 500 USDC collateral" } },
      {
        name: "{{agentName}}",
        content: {
          text: "Successfully added 500 USDC as collateral...",
          actions: ["KAMINO_DEPOSIT"],
        },
      },
    ],
  ],
};
