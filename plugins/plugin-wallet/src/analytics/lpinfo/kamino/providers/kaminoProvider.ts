// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import type { KaminoService } from "../services/kaminoService";

// Kamino Lend Program constants
const KAMINO_LEND_PROGRAM_ID = "GzFgdRJXmawPhGeBsyRCDLx4jAKPsvbUqoqitzppkzkW";
const MAX_KAMINO_WALLETS = 5;
const MAX_KAMINO_POSITIONS = 10;
const MAX_KAMINO_MARKETS = 10;
const MAX_KAMINO_REPORT_CHARS = 8000;

type AccountLike = {
  id?: unknown;
  username?: unknown;
  name?: unknown;
  metawallets?: Array<{
    keypairs?: Record<string, { publicKey?: unknown }>;
  }>;
};

function getSolanaWalletAddresses(account: unknown): string[] {
  const walletAddresses: string[] = [];
  const accountData = account as AccountLike;

  if (!Array.isArray(accountData.metawallets)) {
    return walletAddresses;
  }

  for (const mw of accountData.metawallets) {
    if (!mw?.keypairs) {
      continue;
    }

    for (const [chain, kp] of Object.entries(mw.keypairs)) {
      if (chain === "solana" && kp.publicKey) {
        walletAddresses.push(String(kp.publicKey));
      }
    }
  }

  return walletAddresses;
}

function formatAccountForPrompt(account: unknown): string {
  if (!account) {
    return "account_status: not found";
  }

  const accountData = account as AccountLike;
  const lines = ["account_status: available"];
  const identifiers = {
    id: accountData.id,
    username: accountData.username,
    name: accountData.name,
  };

  for (const [key, value] of Object.entries(identifiers)) {
    if (value !== undefined && value !== null && value !== "") {
      lines.push(`${key}: ${formatPromptValue(value)}`);
    }
  }

  const solanaWallets = getSolanaWalletAddresses(account);
  lines.push(`solana_wallet_count: ${solanaWallets.length}`);
  solanaWallets.slice(0, MAX_KAMINO_WALLETS).forEach((wallet, index) => {
    lines.push(`solana_wallets[${index}]: ${wallet}`);
  });

  return lines.join("\n");
}

function formatPromptValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "N/A";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return String(value);
}

/**
 * Kamino Lending Protocol Provider
 * Provides information about Kamino lending positions and market data
 */
export const kaminoProvider: Provider = {
  name: "KAMINO_LENDING",
  description:
    "Provides information about Kamino lending protocol positions, market data, and available lending/borrowing opportunities",
  descriptionCompressed:
    "provide information Kamino lend protocol position, market data, available lending/borrow opportunity",
  dynamic: true,
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "OWNER" },
  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    console.log("KAMINO_LENDING provider called");

    let kaminoInfo = "";

    try {
      // Check if this is a DM (private message)
      const isDM = message.content.channelType?.toUpperCase() === "DM";
      if (isDM) {
        const account = await getAccountFromMessage(runtime, message);
        if (!account) {
          console.log("No account found for user");
          return {
            data: {},
            values: {} as Record<string, unknown>,
            text: "No account found for this user.",
          };
        }

        console.log("Account found, getting Kamino service...");

        // Get Kamino service with proper type casting
        const kaminoService = runtime.getService(
          "KAMINO_SERVICE",
        ) as unknown as KaminoService;
        if (!kaminoService) {
          console.log("Kamino service not available");
          return {
            data: {},
            values: {} as Record<string, unknown>,
            text: "Kamino service not available.",
          };
        }

        console.log("Kamino service found, generating report...");

        kaminoInfo += `=== KAMINO LENDING PROTOCOL REPORT ===\n\n`;

        // Get user's Kamino positions
        const userPositions = await getUserKaminoPositions(
          kaminoService,
          account,
        );
        const availableReserves =
          await getAvailableKaminoReserves(kaminoService);
        const marketOverview = await getKaminoMarketOverview(kaminoService);
        const discoveredMarkets =
          await getDiscoveredKaminoMarkets(kaminoService);

        // Generate enhanced response using LLM
        const enhancedReport = await generateEnhancedKaminoLendingReport(
          runtime,
          {
            account,
            userPositions,
            availableReserves,
            marketOverview,
            discoveredMarkets,
            kaminoService,
          },
        );

        kaminoInfo += enhancedReport.slice(0, MAX_KAMINO_REPORT_CHARS);
      } else {
        kaminoInfo =
          "Kamino lending protocol information is only available in private messages.";
      }
    } catch (error) {
      console.error("Error in Kamino provider:", error);
      kaminoInfo = `Error generating Kamino report: ${error instanceof Error ? error.message : "Unknown error"}`;
    }

    const data = {
      kaminoLending: kaminoInfo,
    };

    const text = `${kaminoInfo}\n`.slice(0, MAX_KAMINO_REPORT_CHARS);

    return {
      data,
      values: {} as Record<string, unknown>,
      text,
    };
  },
};

/**
 * Get user's Kamino positions
 */
async function getUserKaminoPositions(
  kaminoService: KaminoService,
  account: unknown,
): Promise<string> {
  let positionsInfo = "📊 YOUR KAMINO POSITIONS:\n\n";

  try {
    // Extract wallet addresses from account
    const walletAddresses = getSolanaWalletAddresses(account);

    if (walletAddresses.length === 0) {
      positionsInfo += "No Solana wallets found in your account.\n\n";
      return positionsInfo;
    }

    // Get positions for each wallet
    for (const walletAddress of walletAddresses.slice(0, MAX_KAMINO_WALLETS)) {
      positionsInfo += `🔸 Wallet: ${walletAddress.slice(0, 8)}...${walletAddress.slice(-8)}\n`;

      try {
        // Get real positions from Kamino service
        const positions = await kaminoService.getUserPositions(walletAddress);

        if (positions.error) {
          positionsInfo += `   ❌ Error: ${positions.error}\n\n`;
        } else if (positions.message) {
          positionsInfo += `   ℹ️ ${positions.message}\n\n`;
        } else if (
          positions.lending.length === 0 &&
          positions.borrowing.length === 0
        ) {
          positionsInfo += "   No Kamino positions found.\n\n";

          // Show discovered markets info
          if (positions.markets && positions.markets.length > 0) {
            positionsInfo += `   🔍 Discovered ${positions.markets.length} Kamino markets\n`;
            positionsInfo += `   📊 User has ${positions.userAccounts || 0} token accounts\n\n`;
          }
        } else {
          // Display lending positions
          if (positions.lending.length > 0) {
            positionsInfo += `   💰 LENDING POSITIONS (${positions.lending.length}):\n\n`;

            for (const position of positions.lending.slice(
              0,
              MAX_KAMINO_POSITIONS,
            )) {
              positionsInfo += `   📈 ${position.token || "Unknown Token"}\n`;
              positionsInfo += `      Amount: ${position.amount?.toFixed(6) || "N/A"}\n`;
              positionsInfo += `      Value: $${position.value?.toFixed(2) || "N/A"}\n`;
              positionsInfo += `      APY: ${position.apy?.toFixed(2) || "N/A"}%\n`;
              positionsInfo += `      Market: ${position.market?.slice(0, 8)}...${position.market?.slice(-8) || "N/A"}\n\n`;
            }
          }

          // Display borrowing positions
          if (positions.borrowing.length > 0) {
            positionsInfo += `   💳 BORROWING POSITIONS (${positions.borrowing.length}):\n\n`;

            for (const position of positions.borrowing.slice(
              0,
              MAX_KAMINO_POSITIONS,
            )) {
              positionsInfo += `   📉 ${position.token || "Unknown Token"}\n`;
              positionsInfo += `      Amount: ${position.amount?.toFixed(6) || "N/A"}\n`;
              positionsInfo += `      Value: $${position.value?.toFixed(2) || "N/A"}\n`;
              positionsInfo += `      APY: ${position.apy?.toFixed(2) || "N/A"}%\n`;
              positionsInfo += `      Market: ${position.market?.slice(0, 8)}...${position.market?.slice(-8) || "N/A"}\n\n`;
            }
          }

          // Display total portfolio value
          if (positions.totalValue !== undefined) {
            positionsInfo += `   💼 TOTAL PORTFOLIO VALUE: $${positions.totalValue.toFixed(2)}\n\n`;
          }
        }
      } catch (error) {
        console.error(
          `Error fetching positions for wallet ${walletAddress}:`,
          error,
        );
        positionsInfo += "   Error fetching positions for this wallet.\n\n";
      }
    }
  } catch (error) {
    console.error("Error fetching user Kamino positions:", error);
    positionsInfo += "Error fetching positions. Please try again later.\n\n";
  }

  return positionsInfo;
}

/**
 * Get available Kamino reserves for lending/borrowing
 */
async function getAvailableKaminoReserves(
  kaminoService: KaminoService,
): Promise<string> {
  let reservesInfo = "🏦 AVAILABLE KAMINO RESERVES:\n\n";

  try {
    // Get real reserves from Kamino service
    const reserves = await kaminoService.getAvailableReserves();

    if (reserves.length === 0) {
      reservesInfo += "No reserves available at the moment.\n";
      reservesInfo += "This may be due to:\n";
      reservesInfo += "- Kamino SDK not being installed\n";
      reservesInfo += "- Network connectivity issues\n";
      reservesInfo += "- Service initialization problems\n\n";
      return reservesInfo;
    }

    // Show top reserves by supply APY
    const topLendingReserves = reserves
      .filter((r) => r.supplyApy > 0)
      .sort((a, b) => (b.supplyApy || 0) - (a.supplyApy || 0))
      .slice(0, 5); // Show top 5 lending opportunities

    if (topLendingReserves.length > 0) {
      reservesInfo += "💰 TOP LENDING OPPORTUNITIES:\n\n";

      for (const reserve of topLendingReserves) {
        reservesInfo += `🔸 ${reserve.symbol || "Unknown"}\n`;
        reservesInfo += `   Supply APY: ${reserve.supplyApy?.toFixed(2) || "N/A"}%\n`;
        reservesInfo += `   Borrow APY: ${reserve.borrowApy?.toFixed(2) || "N/A"}%\n`;
        reservesInfo += `   Total Supply: $${reserve.totalSupply?.toLocaleString() || "N/A"}\n`;
        reservesInfo += `   Total Borrow: $${reserve.totalBorrow?.toLocaleString() || "N/A"}\n`;
        reservesInfo += `   Utilization: ${(reserve.utilization * 100)?.toFixed(2) || "N/A"}%\n`;
        reservesInfo += `   Market: ${reserve.marketName || "Unknown"}\n\n`;
      }
    }

    reservesInfo += `Total reserves available: ${reserves.length}\n\n`;
  } catch (error) {
    console.error("Error fetching available Kamino reserves:", error);
    reservesInfo += "Error fetching reserves. Please try again later.\n\n";
  }

  return reservesInfo;
}

/**
 * Get Kamino market overview
 */
async function getKaminoMarketOverview(
  kaminoService: KaminoService,
): Promise<string> {
  let marketInfo = "📈 KAMINO MARKET OVERVIEW:\n\n";

  try {
    // Get real market overview from Kamino service
    const overview = await kaminoService.getMarketOverview();

    if (!overview) {
      marketInfo += "Market data not available at the moment.\n";
      marketInfo += "This may be due to:\n";
      marketInfo += "- Kamino SDK not being installed\n";
      marketInfo += "- Network connectivity issues\n";
      marketInfo += "- Service initialization problems\n\n";
      return marketInfo;
    }

    marketInfo += `📊 Total Markets: ${overview.totalMarkets}\n`;
    marketInfo += `💰 Total TVL: $${overview.totalTvl?.toLocaleString() || "N/A"}\n`;
    marketInfo += `💳 Total Borrowed: $${overview.totalBorrowed?.toLocaleString() || "N/A"}\n\n`;

    // Show top markets by TVL
    if (overview.markets && overview.markets.length > 0) {
      marketInfo += "🏆 TOP MARKETS BY TVL:\n\n";

      const topMarkets = overview.markets
        .sort((a, b) => (b.tvl || 0) - (a.tvl || 0))
        .slice(0, 3);

      for (const market of topMarkets) {
        marketInfo += `🔸 ${market.name || "Unknown Market"}\n`;
        marketInfo += `   TVL: $${market.tvl?.toLocaleString() || "N/A"}\n`;
        marketInfo += `   Borrowed: $${market.borrowed?.toLocaleString() || "N/A"}\n`;
        marketInfo += `   Utilization: ${(market.utilization * 100)?.toFixed(2) || "N/A"}%\n\n`;
      }
    }
  } catch (error) {
    console.error("Error fetching Kamino market overview:", error);
    marketInfo += "Error fetching market data. Please try again later.\n\n";
  }

  return marketInfo;
}

/**
 * Get discovered Kamino markets
 */
async function getDiscoveredKaminoMarkets(
  kaminoService: KaminoService,
): Promise<string> {
  let marketsInfo = "🔍 DISCOVERED KAMINO MARKETS:\n\n";

  try {
    // Get discovered markets from Kamino service
    const markets = await kaminoService.discoverMarkets();

    if (markets.length === 0) {
      marketsInfo += "No markets discovered at the moment.\n\n";
      return marketsInfo;
    }

    marketsInfo += `📊 Total Markets Discovered: ${markets.length}\n\n`;

    // Display discovered markets
    marketsInfo += "🏪 DISCOVERED MARKET ADDRESSES:\n\n";

    for (let i = 0; i < Math.min(markets.length, MAX_KAMINO_MARKETS); i++) {
      const market = markets[i];
      marketsInfo += `${i + 1}. ${market.toString()}\n`;
    }

    marketsInfo += "\n";

    // Show market discovery statistics
    marketsInfo += "📈 MARKET DISCOVERY STATS:\n";
    marketsInfo += `• Program ID: ${KAMINO_LEND_PROGRAM_ID}\n`;
    marketsInfo += `• Discovery Method: Program Account Query\n`;
    marketsInfo += `• Data Size Filter: 1024 bytes\n`;
    marketsInfo += `• Discovery Time: ${new Date().toLocaleString()}\n\n`;
  } catch (error) {
    console.error("Error fetching discovered Kamino markets:", error);
    marketsInfo += "Error discovering markets. Please try again later.\n\n";
  }

  return marketsInfo;
}

/**
 * Generate enhanced Kamino lending report using LLM
 */
async function generateEnhancedKaminoLendingReport(
  runtime: IAgentRuntime,
  data: {
    account: unknown;
    userPositions: string;
    availableReserves: string;
    marketOverview: string;
    discoveredMarkets: string;
    kaminoService: KaminoService;
  },
): Promise<string> {
  try {
    // Create a focused prompt for the LLM
    const lendingPrompt = `You are a professional DeFi analyst specializing in Kamino Finance lending protocols. Generate a comprehensive, well-crafted lending analysis report for the user.

USER ACCOUNT DATA:
${formatAccountForPrompt(data.account)}

USER POSITIONS:
${data.userPositions}

AVAILABLE RESERVES:
${data.availableReserves}

MARKET OVERVIEW:
${data.marketOverview}

DISCOVERED MARKETS:
${data.discoveredMarkets}

Please generate a professional, engaging report that includes:

1. **Portfolio Summary** - Overview of the user's current Kamino lending positions and performance
2. **Market Analysis** - Current state of Kamino lending markets and opportunities
3. **Position Analysis** - Detailed breakdown of user's lending and borrowing positions
4. **Opportunity Assessment** - Analysis of the best lending and borrowing opportunities available
5. **Risk Management** - Key risks and considerations for the user's current positions
6. **Strategy Recommendations** - Specific, actionable recommendations for portfolio optimization
7. **Market Trends** - How current market conditions affect lending strategies

Format the report with:
- Clear sections with descriptive headers
- Use emojis for visual appeal and quick scanning
- Include specific numbers and percentages
- Provide professional but engaging tone
- Focus on actionable insights for this specific user
- Include relevant comparisons to market standards
- End with a concise summary and next steps

Make it comprehensive yet easy to read. Be specific about the user's data and provide clear, personalized insights about their Kamino lending situation.

Generate a professional Kamino lending analysis report:`;

    // Use LLM to generate the enhanced report
    const enhancedReport = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: lendingPrompt,
    });

    return (
      enhancedReport ||
      `${data.userPositions}\n\n${data.availableReserves}\n\n${data.marketOverview}\n\n${data.discoveredMarkets}`
    );
  } catch (error) {
    console.error("Error generating enhanced Kamino lending report:", error);
    return `${data.userPositions}\n\n${data.availableReserves}\n\n${data.marketOverview}\n\n${data.discoveredMarkets}`; // Fallback to original data
  }
}
