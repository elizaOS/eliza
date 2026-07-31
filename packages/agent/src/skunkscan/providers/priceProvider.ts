import { SupportedChain } from "../types";

export const WRAPPED_SOL_MINT =
  "So11111111111111111111111111111111111111112";

// The token ID the native asset is priced under on each chain, since the
// native balance is quoted the same way as any other token holding (e.g.
// Solana prices native SOL under its wrapped-SOL mint). Independent of
// *how* a price gets fetched for that ID - see providers/pricing/ for the
// chain-keyed TokenPriceProvider registry that does the actual fetching.
export const WRAPPED_NATIVE_ASSET_ID: Partial<Record<SupportedChain, string>> =
  {
    solana: WRAPPED_SOL_MINT,
  };
