import { SupportedChain } from "../types";

export const WRAPPED_SOL_MINT =
  "So11111111111111111111111111111111111111112";

// The token ID the native asset is priced under on each chain, since the
// native balance is quoted the same way as any other token holding (e.g.
// Solana prices native SOL under its wrapped-SOL mint). Independent of
// *how* a price gets fetched for that ID - see providers/pricing/ for the
// chain-keyed TokenPriceProvider registry that does the actual fetching.
// Bitcoin has no wrapped-native token the way EVM/Solana do - it's priced
// under its own UniversalAssetIdentifier.assetId instead (see
// chains/bitcoin.ts's BITCOIN_NATIVE_ASSET, which this string must match
// exactly).
export const BITCOIN_NATIVE_ASSET_PRICE_ID = "bitcoin:native:BTC";

// Canonical wrapped-native contract addresses, live-verified against
// Moralis's price endpoint (real, current prices returned for all three -
// not assumed from memory). Each is the standard, widely-used wrapped
// token for its chain - not something SkunkScan deployed or controls.
export const WETH_ETHEREUM_ADDRESS =
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
export const WBNB_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
export const WETH_BASE_ADDRESS = "0x4200000000000000000000000000000000000006";

export const WRAPPED_NATIVE_ASSET_ID: Partial<Record<SupportedChain, string>> =
  {
    solana: WRAPPED_SOL_MINT,
    bitcoin: BITCOIN_NATIVE_ASSET_PRICE_ID,
    ethereum: WETH_ETHEREUM_ADDRESS,
    bnb: WBNB_ADDRESS,
    base: WETH_BASE_ADDRESS,
  };
