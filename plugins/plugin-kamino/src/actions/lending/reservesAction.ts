import {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { KaminoService } from "../../services/kamino";

export const ReserveAction: Action = {
  name: "KAMINO_RESERVES",
  similes: [
    "LIST_KAMINO_RESERVES",
    "SHOW_KAMINO_RESERVES",
    "KAMINO_APYS",
    "WHAT_ARE_THE_RATES",
    "LENDING_RATES",
  ],
  description:
    "List all available Kamino Lend reserves with current supply APY, borrow APY, LTV, and available liquidity. Use when the user asks about lending rates, borrowing rates, or wants to see what assets are available.",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService<KaminoService>("kamino-service");
    return service?.isInitialized() ?? false;
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
      const reserves = await service?.getAllReserves();

      if (!reserves || reserves?.length === 0) {
        await callback?.({
          text: "No reserves are currently available.",
          actions: ["KAMINO_RESERVES"],
          data: { reserves: [] },
        });
        return { success: false, text: `Reserves not found` };
      }

      const lines = reserves?.map((r) => {
        const type =
          r.depositEnabled && r.borrowEnabled
            ? "deposit + borrow"
            : r.depositEnabled
              ? "deposit only"
              : "borrow only";
        return `- **${r.symbol}** (${r.marketName}): Supply ${r.supplyAPY}% | Borrow ${r.borrowAPY}% | LTV ${r.ltv} | Available ${r.availableLiquidity} ${r.symbol} | ${type}`;
      });
      await callback?.({
        text: `Here are the current Kamino Lend reserves: ${lines?.join("\n")}`,
        actions: ["KAMINO_RESERVES"],
        data: { reserves },
      });
      return {
        success: true,
        text: "Fetching reserves successful",
        data: { reserves },
      };
    } catch (error) {
      await callback?.({
        text: `Failed to fetch reserves: ${error}`,
        actions: ["KAMINO_RESERVES"],
        data: { error: String(error) },
      });
      return { success: false, text: String(error) };
    }
  },

  examples: [
    [
      { name: "{{user}}", content: { text: "Show me available reserves" } },
      {
        name: "{{agent}}",
        content: {
          text: "Here are the current Kamino Lend reserves...",
          actions: ["KAMINO_RESERVES"],
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "List all the available reserves" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Here are the current Kamino Lend reserves with their APYs...",
          actions: ["KAMINO_RESERVES"],
        },
      },
    ],
  ],
};
