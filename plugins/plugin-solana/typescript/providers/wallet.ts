import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { logger } from "@elizaos/core";
import BigNumber from "../bn";
import { SOLANA_WALLET_DATA_CACHE_KEY } from "../constants";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import { getWalletKey } from "../keypairUtils";
import type { WalletPortfolio } from "../types";

const spec = requireProviderSpec("wallet");

export const walletProvider: Provider = {
  name: spec.name,
  description: "your solana wallet information",
  dynamic: true,
  get: async (runtime: IAgentRuntime, _message: Memory, state: State): Promise<ProviderResult> => {
    try {
      const portfolioCache = await runtime.getCache<WalletPortfolio>(SOLANA_WALLET_DATA_CACHE_KEY);
      if (!portfolioCache) {
        logger.info("solana::wallet provider - portfolioCache is not ready");
        return { data: {}, values: {}, text: "" };
      }

      const { publicKey } = await getWalletKey(runtime, false);
      const pubkeyStr = publicKey ? ` (${publicKey.toBase58()})` : "";

      const portfolio = portfolioCache;
      const agentName = state.agentName ?? runtime.character.name ?? "The agent";
      const totalSol = portfolio.totalSol ?? "0";

      const values: Record<string, string> = {
        total_usd: new BigNumber(portfolio.totalUsd).toFixed(2),
        total_sol: totalSol,
      };

      portfolio.items.forEach((item, index) => {
        if (new BigNumber(item.uiAmount).isGreaterThan(0)) {
          values[`token_${index}_name`] = item.name;
          values[`token_${index}_symbol`] = item.symbol;
          values[`token_${index}_amount`] = new BigNumber(item.uiAmount).toFixed(6);
          values[`token_${index}_usd`] = new BigNumber(item.valueUsd).toFixed(2);
          values[`token_${index}_sol`] = item.valueSol ?? "0";
        }
      });

      if (portfolio.prices) {
        values.sol_price = new BigNumber(portfolio.prices.solana.usd).toFixed(2);
        values.btc_price = new BigNumber(portfolio.prices.bitcoin.usd).toFixed(2);
        values.eth_price = new BigNumber(portfolio.prices.ethereum.usd).toFixed(2);
      }

      let text = `\n\n${agentName}'s Main Solana Wallet${pubkeyStr}\n`;
      text += `Total Value: $${values.total_usd} (${values.total_sol} SOL)\n\n`;
      text += "Token Balances:\n";
      const nonZeroItems = portfolio.items.filter((item) =>
        new BigNumber(item.uiAmount).isGreaterThan(0)
      );

      if (nonZeroItems.length === 0) {
        text += "No tokens found with non-zero balance\n";
      } else {
        for (const item of nonZeroItems) {
          const valueUsd = new BigNumber(item.valueUsd).toFixed(2);
          const valueSol = item.valueSol ?? "0";
          text += `${item.name} (${item.symbol}): ${new BigNumber(item.uiAmount).toFixed(
            6
          )} ($${valueUsd} | ${valueSol} SOL)\n`;
        }
      }

      if (portfolio.prices) {
        text += "\nMarket Prices:\n";
        text += `SOL: $${values.sol_price}\n`;
        text += `BTC: $${values.btc_price}\n`;
        text += `ETH: $${values.eth_price}\n`;
      }

      const data = {
        totalUsd: portfolio.totalUsd,
        totalSol: portfolio.totalSol,
        items: portfolio.items,
        prices: portfolio.prices,
        lastUpdated: portfolio.lastUpdated,
      };

      return {
        data,
        values,
        text,
      };
    } catch (error) {
      logger.error(
        `Error in Solana wallet provider: ${error instanceof Error ? error.message : String(error)}`
      );
      return { data: {}, values: {}, text: "" };
    }
  },
};
