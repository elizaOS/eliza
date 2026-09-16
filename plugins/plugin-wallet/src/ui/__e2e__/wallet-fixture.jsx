/** Deterministic populated Wallet surface for local mobile/desktop design QA. */
import { client } from "@elizaos/ui/api";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MockAppProvider } from "../../../../../packages/ui/src/storybook/mock-providers";
import { InventoryAppView } from "../components/InventoryAppView";
import "./wallet-fixture.css";

const EVM_ADDRESS = "0x1111111111111111111111111111111111111111";
const SOL_ADDRESS = "So1ana1111111111111111111111111111111111111";
const AERO_ADDRESS = "0xAERO000000000000000000000000000000000000";

const walletConfig = {
  evmAddress: EVM_ADDRESS,
  solanaAddress: SOL_ADDRESS,
  selectedRpcProviders: {
    evm: "alchemy",
    bsc: "quicknode",
    solana: "helius-birdeye",
  },
  legacyCustomChains: [],
  alchemyKeySet: true,
  infuraKeySet: false,
  ankrKeySet: false,
  heliusKeySet: true,
  birdeyeKeySet: true,
  evmChains: ["Ethereum", "Base"],
  evmBalanceReady: true,
  ethereumBalanceReady: true,
  baseBalanceReady: true,
  solanaBalanceReady: true,
};

const balances = {
  evm: {
    address: EVM_ADDRESS,
    chains: [
      {
        chain: "Ethereum",
        chainId: 1,
        nativeBalance: "1.25",
        nativeSymbol: "ETH",
        nativeValueUsd: "750",
        tokens: [
          {
            symbol: "USDC",
            name: "USD Coin",
            balance: "100",
            valueUsd: "100",
            decimals: 18,
            logoUrl: "",
            contractAddress: "0xUSDC00000000000000000000000000000000000000",
          },
          {
            symbol: "AERO",
            name: "Aerodrome",
            balance: "40",
            valueUsd: "80",
            decimals: 18,
            logoUrl: "",
            contractAddress: AERO_ADDRESS,
          },
        ],
        error: null,
      },
    ],
  },
  solana: {
    address: SOL_ADDRESS,
    solBalance: "2",
    solValueUsd: "300",
    tokens: [],
  },
};

const nfts = {
  evm: [
    {
      chain: "Base",
      nfts: [
        {
          name: "Agent NFT",
          description: "",
          imageUrl: "",
          collectionName: "Agents",
          contractAddress: "0xNFT0000000000000000000000000000000000000000",
          tokenId: "1",
          tokenType: "ERC721",
        },
      ],
    },
  ],
  solana: null,
};

const tradingProfile = {
  window: "30d",
  source: "all",
  generatedAt: "2026-08-26T12:00:00.000Z",
  summary: {
    totalSwaps: 4,
    buyCount: 2,
    sellCount: 2,
    settledCount: 4,
    successCount: 4,
    revertedCount: 0,
    tradeWinRate: 0.5,
    txSuccessRate: 1,
    winningTrades: 2,
    evaluatedTrades: 4,
    realizedPnlBnb: "1.5",
    volumeBnb: "12",
  },
  pnlSeries: [
    { day: "2026-08-22", realizedPnlBnb: "0.2", volumeBnb: "3", swaps: 1 },
    { day: "2026-08-23", realizedPnlBnb: "0.9", volumeBnb: "4", swaps: 2 },
    { day: "2026-08-24", realizedPnlBnb: "1.5", volumeBnb: "5", swaps: 1 },
  ],
  tokenBreakdown: [
    {
      tokenAddress: AERO_ADDRESS.toLowerCase(),
      symbol: "AERO",
      buyCount: 2,
      sellCount: 1,
      realizedPnlBnb: "1.2",
      volumeBnb: "8",
      tradeWinRate: 1,
      winningTrades: 2,
      evaluatedTrades: 2,
    },
    {
      tokenAddress:
        "0xUSDC00000000000000000000000000000000000000".toLowerCase(),
      symbol: "USDC",
      buyCount: 1,
      sellCount: 1,
      realizedPnlBnb: "-0.3",
      volumeBnb: "4",
      tradeWinRate: 0,
      winningTrades: 0,
      evaluatedTrades: 1,
    },
  ],
  recentSwaps: [
    {
      hash: "0xswap1",
      createdAt: "2026-08-25T12:00:00.000Z",
      source: "agent",
      side: "buy",
      status: "success",
      tokenAddress: AERO_ADDRESS.toLowerCase(),
      tokenSymbol: "AERO",
      inputAmount: "1",
      inputSymbol: "ETH",
      outputAmount: "20",
      outputSymbol: "AERO",
      explorerUrl: "https://basescan.org/tx/0xswap1",
      confirmations: 12,
    },
  ],
};

const source = {
  providerId: "coingecko",
  providerName: "CoinGecko",
  providerUrl: "https://www.coingecko.com",
  available: true,
  stale: false,
  error: null,
};
const marketOverview = {
  generatedAt: "2026-08-26T12:00:00.000Z",
  cacheTtlSeconds: 60,
  stale: false,
  sources: {
    prices: source,
    movers: source,
    predictions: {
      ...source,
      providerId: "polymarket",
      providerName: "Polymarket",
      providerUrl: "https://polymarket.com",
    },
  },
  prices: [],
  movers: [
    {
      id: "solana",
      symbol: "SOL",
      name: "Solana",
      priceUsd: 150,
      change24hPct: 7.5,
      marketCapRank: 5,
      imageUrl: null,
    },
  ],
  predictions: [],
};

client.getWalletTradingProfile = async (window) => ({
  ...tradingProfile,
  window: window ?? "30d",
});
client.getWalletMarketOverview = async () => marketOverview;

const noopAsync = async () => {};
const fixtureState = new URLSearchParams(window.location.search).get("state");
const populatedAppValue = {
  walletEnabled: true,
  walletAddresses: {
    evmAddress: EVM_ADDRESS,
    solanaAddress: SOL_ADDRESS,
  },
  walletConfig,
  walletBalances: balances,
  walletNfts: nfts,
  walletLoading: false,
  walletNftsLoading: false,
  walletConfigStatus: "ready",
  walletConfigError: null,
  walletBalancesStatus: "ready",
  walletBalancesError: null,
  walletNftsStatus: "ready",
  walletNftsError: null,
  walletError: null,
  loadWalletConfig: noopAsync,
  loadBalances: noopAsync,
  loadNfts: noopAsync,
  setState: () => {},
  setTab: () => {},
  setActionNotice: () => {},
};
const appValue =
  fixtureState === "empty"
    ? {
        ...populatedAppValue,
        walletAddresses: { evmAddress: null, solanaAddress: null },
        walletConfig: {
          ...walletConfig,
          walletSource: "none",
          evmAddress: null,
          solanaAddress: null,
          evmBalanceReady: false,
          ethereumBalanceReady: false,
          baseBalanceReady: false,
        },
        walletBalances: { evm: null, solana: null },
        walletNfts: { evm: [], solana: null },
      }
    : fixtureState === "error"
      ? {
          ...populatedAppValue,
          walletBalances: null,
          walletNfts: { evm: [], solana: null },
          walletBalancesStatus: "error",
          walletBalancesError:
            "Failed to fetch balances: API 500 internal_error",
        }
      : populatedAppValue;

const root = document.getElementById("root");
if (!root) throw new Error("Wallet fixture root is missing");

createRoot(root).render(
  <StrictMode>
    <MockAppProvider value={appValue}>
      <InventoryAppView />
    </MockAppProvider>
  </StrictMode>,
);
