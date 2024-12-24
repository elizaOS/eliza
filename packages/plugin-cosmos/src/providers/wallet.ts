import {
    IAgentRuntime,
    Memory,
    Provider,
    State
  } from "@ai16z/eliza";
  import { chains } from "chain-registry";
  import BigNumber from "bignumber.js";
  import NodeCache from "node-cache";
  import { getOfflineSignerProto as getOfflineSigner } from "cosmjs-utils";
  import { SigningStargateClient } from "@cosmjs/stargate";

  /**
   * Minimal CosmosChainInfo shape for demonstration.
   * Extend as needed to match your usage.
   */
  interface CosmosChainInfo {
    chain_name: string;
    denom?: string;
    decimals?: number;
    coingecko_id: string;
    bech32_prefix: string;
    apis?: {
      rpc?: Array<{ address: string }>;
    };
    fees?: {
      fee_tokens?: Array<{
        denom: string;
        average_gas_price?: number;
      }>;
    };
  }

  /**
   * Basic token interface for the portfolio
   */
  export interface CosmosToken {
    name: string;
    symbol: string;
    decimals: number;
    balance: string;
    uiAmount: string;
    priceUsd: string;
    valueUsd: string;
  }

  /**
   * Portfolio interface showing total USD plus an array of tokens
   */
  interface WalletPortfolio {
    totalUsd: string;
    tokens: Array<CosmosToken>;
  }

  export class WalletProvider implements Provider {
    private cache: NodeCache;
    private stargateClient: SigningStargateClient | null = null;
    private signerAddress: string | null = null;

    constructor(
      private mnemonic: string,
      private chainInfo: CosmosChainInfo
    ) {
    //   console.log("WalletProvider instantiated with chainInfo:", chainInfo);
      this.cache = new NodeCache({ stdTTL: 300 }); // 5-min TTL
    }

    /**
     * The Eliza framework calls this method to "get" data from the provider.
     * Here we simply fetch the user's formatted portfolio.
     */
    async get(
      runtime: IAgentRuntime,
      _message: Memory,
      _state?: State
    ): Promise<string | null> {
      try {
        return await this.getFormattedPortfolio(runtime);
      } catch (error) {
        console.error("Error in wallet provider get:", error);
        return null;
      }
    }

    /**
     * Connect once, returning a SigningStargateClient
     */
    public async connect(runtime: IAgentRuntime): Promise<SigningStargateClient> {
      if (this.stargateClient) return this.stargateClient;
      if (!this.mnemonic) {
        throw new Error("Cosmos wallet mnemonic not provided");
      }

      // Grab the first RPC in chainInfo.apis
      const rpcUrl = this.chainInfo.apis?.rpc?.[0]?.address;
      if (!rpcUrl) {
        throw new Error("No RPC endpoint specified in chainInfo");
      }

      const signer = await getOfflineSigner({
        mnemonic: this.mnemonic,
        chain: this.chainInfo,
      });

      const stargateClient = await SigningStargateClient.connectWithSigner(rpcUrl, signer);
      const [account] = await signer.getAccounts();
      this.signerAddress = account.address;
      this.stargateClient = stargateClient;

      console.log("Agent init with signer address: ", this.signerAddress)
      return stargateClient;
    }

    /**
     * Retrieves balance for a single token, fetches price, calculates portfolio
     * with additional checks to handle NaN or invalid values.
     */
    async fetchPortfolioValue(runtime: IAgentRuntime): Promise<WalletPortfolio> {
      const cacheKey = `portfolio-${this.chainInfo.chain_name}`;
      const cachedValue = this.cache.get<WalletPortfolio>(cacheKey);
      if (cachedValue) {
        console.log("Cache hit for fetchPortfolioValue");
        return cachedValue;
      }

      // Connect if not already
      const client = await this.connect(runtime);
      if (!this.signerAddress) {
        throw new Error("Signer address not available after connect");
      }

      // 1) Safely determine denom & decimals
      const denom = this.chainInfo.denom || "uosmo";

      // parse the decimals as an integer
      let decimals = parseInt(String(this.chainInfo.decimals), 10);
      if (isNaN(decimals) || decimals < 1) {
        console.warn(
          `Invalid or missing decimals (${this.chainInfo.decimals}), defaulting to 1`
        );
        decimals = 1;
      }

      // 2) Fetch all balances from the chain
      const balances = await client.getAllBalances(this.signerAddress);
      const baseTokenBalance = balances.find((b) => b.denom === denom);
      let rawBalance = baseTokenBalance?.amount ?? "0";

      // 3) Coingecko ID from chainInfo or fallback
      const cgID = this.chainInfo.coingecko_id || "osmosis";

      let tokenPriceUsd = await this.fetchTokenPrice(runtime, cgID);

      // 4) Ensure rawBalance is a valid number
      let balanceBN = new BigNumber(rawBalance);
      if (!balanceBN.isFinite()) {
        console.warn(`Invalid raw balance value: ${rawBalance}, defaulting to 0.`);
        balanceBN = new BigNumber(0);
      }

      // Also ensure tokenPriceUsd is numeric
      if (isNaN(tokenPriceUsd) || !tokenPriceUsd) {
        console.warn(`Invalid token price: ${tokenPriceUsd}, defaulting to 0.`);
        tokenPriceUsd = 0;
      }

      // 5) Convert minimal denom -> "1" denom
      const convertedBalance = balanceBN.shiftedBy(-decimals);
      const valueUsd = convertedBalance.multipliedBy(tokenPriceUsd).toFixed();

      // Construct a simple portfolio
      const portfolio: WalletPortfolio = {
        totalUsd: valueUsd,
        tokens: [
          {
            name: this.chainInfo.chain_name ?? "Cosmos Chain",
            symbol: denom.toUpperCase(),
            decimals,
            balance: balanceBN.toFixed(), // store the validated balance
            uiAmount: convertedBalance.toString(),
            priceUsd: String(tokenPriceUsd),
            valueUsd,
          },
        ],
      };

      this.cache.set(cacheKey, portfolio);
      return portfolio;
    }

    /**
     * Fetch price from Coingecko (or 0 if fails)
     */
    private async fetchTokenPrice(runtime: IAgentRuntime, cgID: string): Promise<number> {
      const cacheKey = `price-${cgID}`;
      const cachedPrice = this.cache.get<number>(cacheKey);
      if (cachedPrice !== undefined && cachedPrice) {
        return cachedPrice;
      }

      try {
        // For example: fetch OSMO price if cgID = "osmosis"
        const url = `https://api.coingecko.com/api/v3/simple/price?ids=${cgID}&vs_currencies=usd`;
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Error fetching price for ${cgID}. Status: ${response.status}`);
        }
        const data = await response.json();

        const price = data[cgID]?.usd ?? 0;
        this.cache.set(cacheKey, price);
        return price;
      } catch (error) {
        console.error("Error fetching token price:", error);
        return 0;
      }
    }

    /**
     * Format the portfolio into a text string
     */
    formatPortfolio(runtime: IAgentRuntime, portfolio: WalletPortfolio): string {
      let output = ``;
      output += `Chain: ${this.chainInfo.chain_name}\n`;

      if (this.signerAddress) {
        output += `Account Address: ${this.signerAddress}\n\n`;
      }

      const totalUsd = new BigNumber(portfolio.totalUsd).toFixed(2);
      output += `Total Value: $${totalUsd}\n\nToken Balances:\n`;

      for (const token of portfolio.tokens) {
        const valUsd = new BigNumber(token.valueUsd).toFixed(2);
        output += `${token.name} (${token.symbol}): ${token.uiAmount} ($${valUsd})\n`;
      }

      output += `\nMarket Prices:\n`;
      for (const token of portfolio.tokens) {
        const tokenPriceUsd = new BigNumber(token.priceUsd).toFixed(2);
        output += `${token.symbol}: $${tokenPriceUsd}\n`;
      }

      return output;
    }

    /**
     * Convenience method to fetch + format
     */
    async getFormattedPortfolio(runtime: IAgentRuntime): Promise<string> {
      try {
        const portfolio = await this.fetchPortfolioValue(runtime);
        return this.formatPortfolio(runtime, portfolio);
      } catch (error) {
        console.error("Error generating portfolio report:", error);
        return "Unable to fetch wallet information. Please try again later.";
      }
    }
  }

  /**
   * Single exported provider.
   * If COSMOS_RPC_URL is set, we create a local chainInfo.
   * Otherwise, we load chainInfo from chain-registry for chain_name.
   */
  const walletProvider: Provider = {
    get: async (runtime, message, state) => {
      try {
        // 1) Pull settings from environment or .env
        const mnemonic = runtime.getSetting("COSMOS_MNEMONIC");
        if (!mnemonic) {
          throw new Error("COSMOS_MNEMONIC not configured");
        }
        const coingeckoID = runtime.getSetting("COSMOS_COINGECKO_ID") || "osmosis";
        const chainName = runtime.getSetting("COSMOS_CHAIN_NAME") || "osmosis";

        // 2) Check if user provided a custom RPC via COSMOS_RPC_URL
        const customRpc = runtime.getSetting("COSMOS_RPC_URL");
        if (customRpc) {
          // Possibly read denom, decimals, and bech32_prefix from env or use defaults
          const customDenom = runtime.getSetting("COSMOS_CHAIN_DENOM") || "uosmo";
          // We'll parse the env decimals as integer, min 1 is enforced inside fetchPortfolioValue
          const customDecimals = Number(runtime.getSetting("COSMOS_CHAIN_DECIMALS") || 6);
          const bech32Prefix = runtime.getSetting("COSMOS_BECH32_PREFIX") || "osmo";

          // Example fallback average gas price
          const averageGasPrice = 0.025;

          // 2A) Construct a minimal chainInfo object from environment
          const localChainInfo: CosmosChainInfo = {
            chain_name: chainName,
            bech32_prefix: bech32Prefix,
            coingecko_id: coingeckoID,
            apis: { rpc: [{ address: customRpc }] },
            fees: {
              fee_tokens: [
                {
                  denom: customDenom,
                  average_gas_price: averageGasPrice
                }
              ]
            },
            denom: customDenom,
            decimals: customDecimals
          };

          const provider = new WalletProvider(mnemonic, localChainInfo);
          return provider.getFormattedPortfolio(runtime);
        } else {
          // 2B) Otherwise, load chainInfo from chain-registry
          const chainData = chains.find(c => c.chain_name === chainName);
          if (!chainData) {
            throw new Error(`Chain '${chainName}' not found in chain-registry`);
          }

          // Optionally store denom/decimals from chainData or env
          const chainDenom = chainData.fees?.fee_tokens?.[0]?.denom || "uosmo";
          // We'll parse from chainData, but min 1 is enforced inside fetchPortfolioValue
          const chainDecimals = chainData.decimals || 6;

          chainData.denom = chainDenom;
          chainData.decimals = chainDecimals;

          if (!chainData.coingecko_id) {
            chainData.coingecko_id = coingeckoID; // fallback
          }

          const provider = new WalletProvider(mnemonic, chainData as CosmosChainInfo);
          return provider.getFormattedPortfolio(runtime);
        }
      } catch (error) {
        console.error("Error in wallet provider:", error);
        return null;
      }
    },
  };

  export { walletProvider };
