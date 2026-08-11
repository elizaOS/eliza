// Raw Moralis REST calls for Ethereum data. Mirrors helius.ts's structure:
// small typed fetch functions, no SDK dependency (fetch() only, matching
// the existing pattern rather than adding @moralisweb3/* to package.json).
//
// Live-spot-checked against Vitalik Buterin's address
// (0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045, cross-checkable on
// Etherscan) - native balance, NFT holdings (normalized_metadata), token
// balances pagination, order=ASC oldest-transaction lookup, and
// transaction-history pagination cursor-threading all confirmed working.
//
// PR 4: transaction history (getEthereumTransactions, and therefore
// getEthereumOldestTransaction/getOldestTransaction/getTransactions) moved
// from GET /{address} to GET /wallets/{address}/history - live-confirmed to
// return pre-decoded native_transfers[] and erc20_transfers[] per
// transaction (from_address/to_address/value_formatted/direction, plus the
// token contract address on erc20_transfers), including entries with
// internal_transaction: true - i.e. native ETH moved via contract calls is
// already captured there, no separate internal_transactions decode needed.
// Confirmed on three real transaction shapes: a plain native receive, an
// ERC-20 airdrop, and a multi-leg Uniswap V2 Router swap. The raw
// internal_transactions field itself stayed empty even with
// include=internal_transactions passed - unused by this connector.
// Single-transaction-by-hash lookup (getEthereumTransaction, /transaction/
// {hash}) has NOT been live-verified to return these same rich fields -
// treated as a separate, still-partial path.
//
// PR 5: found (live, on Vitalik's wallet - 1774+ tokens) that
// /wallets/{address}/tokens's "too many ERC20 token balances" error
// fires on the very first call for a large enough wallet, regardless of
// the limit/cursor pagination PR 3.5 added - that fix helps wallets
// below whatever Moralis's absolute threshold is, but does nothing for
// wallets above it. getEthereumTokenHoldings now catches this specific
// condition and returns a partial/empty result with truncated: true
// instead of throwing, so one endpoint's hard limit doesn't abort the
// entire wallet investigation.

const MORALIS_BASE_URL = "https://deep-index.moralis.io/api/v2.2";

// Moralis's own `chain` query-parameter values - NOT the same strings as
// this codebase's internal SupportedChain identifiers ("ethereum"/"bnb").
// BSC in particular is "bsc" on the wire, not "bnb" - confirmed live and
// against Moralis's docs (chainList enum). "base" happens to match the
// internal SupportedChain identifier ("base") exactly - confirmed against
// Moralis's own chain-parameter enum, not assumed just because the
// strings look the same. Every exported function below takes this
// explicitly rather than defaulting to "eth", so a caller can never
// silently query the wrong chain.
export type MoralisEvmChain = "eth" | "bsc" | "base";

function getMoralisApiKey(): string {
  const apiKey = process.env.MORALIS_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      "Missing MORALIS_API_KEY environment variable",
    );
  }

  return apiKey;
}

// Thrown by callMoralisRest on any non-ok response, carrying Moralis's
// actual error message (when the body parses as JSON with one) rather
// than just the HTTP status - the generic status-only message this
// replaced is exactly what made a real, reproducible bug (the
// "too many ERC20 token balances" error) take a dedicated live
// diagnostic round-trip to root-cause instead of being obvious from the
// error text alone.
export class MoralisRequestError extends Error {
  readonly status: number;
  readonly moralisMessage: string | null;

  constructor(status: number, moralisMessage: string | null) {
    super(
      moralisMessage
        ? `Moralis request failed with status ${status}: ${moralisMessage}`
        : `Moralis request failed with status ${status}`,
    );
    this.name = "MoralisRequestError";
    this.status = status;
    this.moralisMessage = moralisMessage;
  }
}

async function handleMoralisResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let moralisMessage: string | null = null;

    try {
      const body = (await response.json()) as { message?: string };
      moralisMessage = typeof body.message === "string" ? body.message : null;
    } catch {
      // Body wasn't JSON (or was empty) - fall back to status-only.
    }

    throw new MoralisRequestError(response.status, moralisMessage);
  }

  return (await response.json()) as T;
}

async function callMoralisRest<T>(
  path: string,
  searchParams: Record<string, string> = {},
): Promise<T> {
  const apiKey = getMoralisApiKey();

  const url = new URL(`${MORALIS_BASE_URL}${path}`);

  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-API-Key": apiKey,
    },
  });

  return handleMoralisResponse<T>(response);
}

// POST variant, only needed for the batch token-price endpoint so far
// (every other Moralis call this file makes is a GET) - shares the same
// error handling as callMoralisRest via handleMoralisResponse.
async function callMoralisRestPost<T>(
  path: string,
  body: unknown,
  searchParams: Record<string, string> = {},
): Promise<T> {
  const apiKey = getMoralisApiKey();

  const url = new URL(`${MORALIS_BASE_URL}${path}`);

  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(body),
  });

  return handleMoralisResponse<T>(response);
}

const TOO_MANY_TOKEN_BALANCES_PATTERN = /too many erc20 token balances/i;

function isTooManyTokenBalancesError(error: unknown): boolean {
  return (
    error instanceof MoralisRequestError &&
    error.moralisMessage !== null &&
    TOO_MANY_TOKEN_BALANCES_PATTERN.test(error.moralisMessage)
  );
}

export type MoralisNativeBalanceResponse = {
  balance?: string;
};

export async function getEthereumBalance(
  address: string,
  chain: MoralisEvmChain,
): Promise<{ address: string; wei: string }> {
  if (!address || address.trim().length === 0) {
    throw new Error("Wallet address is required");
  }

  const walletAddress = address.trim();

  const data = await callMoralisRest<MoralisNativeBalanceResponse>(
    `/${walletAddress}/balance`,
    { chain },
  );

  return {
    address: walletAddress,
    wei: typeof data.balance === "string" ? data.balance : "0",
  };
}

export type MoralisWalletToken = {
  token_address?: string;
  symbol?: string;
  name?: string;
  decimals?: number | string;
  balance?: string;
  native_token?: boolean;
};

export type MoralisWalletTokensResponse = {
  result?: MoralisWalletToken[];
  cursor?: string | null;
};

export type EthereumTokenHolding = {
  contractAddress: string;
  symbol: string | null;
  name: string | null;
  decimals: number;
  rawAmount: string;
};

// Wallets with a large token count (heavily-airdropped addresses in
// particular) can't be returned in a single call - /wallets/{address}/tokens
// is cursor-paginated (confirmed live: an unpaginated call errors with
// "has too many ERC20 token balances for <chain>" once a wallet crosses
// some internal threshold). Walks pages the same way getOldestTransaction
// walks transaction history, capped so a pathological wallet can't loop
// forever.
const MAX_TOKEN_HOLDING_PAGES = 20;

export type EthereumTokenHoldingsResult = {
  holdings: EthereumTokenHolding[];
  // true when Moralis refused the endpoint outright ("too many ERC20
  // token balances") before any page could be served - live-confirmed on
  // Vitalik's wallet (1774+ tokens): the limit/cursor pagination below
  // does NOT help here, since the error fires on the very first call
  // regardless of page size. holdings will be empty (or a partial list,
  // if this happens after a few successful pages) rather than the true
  // full set - callers should surface this, not treat it as "this wallet
  // simply holds no tokens."
  truncated: boolean;
};

export async function getEthereumTokenHoldings(
  address: string,
  chain: MoralisEvmChain,
  options: { excludeSpam?: boolean } = {},
): Promise<EthereumTokenHoldingsResult> {
  if (!address || address.trim().length === 0) {
    throw new Error("Wallet address is required");
  }

  const walletAddress = address.trim();
  const excludeSpam = options.excludeSpam ?? true;

  const allTokens: MoralisWalletToken[] = [];
  let cursor: string | null = null;
  let truncated = false;

  for (let page = 0; page < MAX_TOKEN_HOLDING_PAGES; page += 1) {
    const searchParams: Record<string, string> = {
      chain,
      limit: "100",
      exclude_spam: String(excludeSpam),
    };

    if (cursor) {
      searchParams.cursor = cursor;
    }

    let data: MoralisWalletTokensResponse;

    try {
      data = await callMoralisRest<MoralisWalletTokensResponse>(
        `/wallets/${walletAddress}/tokens`,
        searchParams,
      );
    } catch (error) {
      if (isTooManyTokenBalancesError(error)) {
        truncated = true;
        break;
      }

      throw error;
    }

    const results = Array.isArray(data.result) ? data.result : [];
    allTokens.push(...results);

    if (!data.cursor) {
      break;
    }

    cursor = data.cursor;
  }

  const holdings = allTokens
    .filter((token) => !token.native_token && token.token_address)
    .map((token) => ({
      contractAddress: String(token.token_address),
      symbol: token.symbol ?? null,
      name: token.name ?? null,
      decimals: Number(token.decimals ?? 18),
      rawAmount: typeof token.balance === "string" ? token.balance : "0",
    }))
    .filter((token) => token.contractAddress.length > 0);

  return { holdings, truncated };
}

export type MoralisNft = {
  token_address?: string;
  token_id?: string;
  name?: string;
  normalized_metadata?: {
    name?: string;
    image?: string;
  };
};

export type MoralisWalletNftsResponse = {
  result?: MoralisNft[];
  cursor?: string | null;
};

export type EthereumNftHolding = {
  contractAddress: string;
  tokenId: string;
  name: string | null;
  imageUrl: string | null;
};

export type EthereumNftHoldingsResult = {
  holdings: EthereumNftHolding[];
  // Same shape/meaning as EthereumTokenHoldingsResult.truncated - true when
  // MAX_NFT_HOLDING_PAGES was hit before the cursor ran out. Previously this
  // function made a single un-paginated call (live-confirmed: a real
  // 100+-NFT wallet, 0xd387a6e4e84a6c86bd90c158c6028a58cc8ac459, returns a
  // real cursor Moralis expected the caller to follow), silently dropping
  // everything past the first page with no signal to the caller - unlike
  // the token-holdings path, which already surfaced this correctly.
  truncated: boolean;
};

// Same pagination shape as getEthereumTokenHoldings's MAX_TOKEN_HOLDING_PAGES
// - a separate constant (not reused) so NFT and token page limits can be
// tuned independently, even though both currently land on the same 20 x 100
// = 2,000-item ceiling.
const MAX_NFT_HOLDING_PAGES = 20;

export async function getEthereumNftHoldings(
  address: string,
  chain: MoralisEvmChain,
): Promise<EthereumNftHoldingsResult> {
  const walletAddress = address.trim();

  if (!walletAddress) {
    throw new Error("Wallet address is required");
  }

  const allNfts: MoralisNft[] = [];
  let cursor: string | null = null;
  let truncated = false;

  for (let page = 0; page < MAX_NFT_HOLDING_PAGES; page += 1) {
    const searchParams: Record<string, string> = {
      chain,
      format: "decimal",
      limit: "100",
    };

    if (cursor) {
      searchParams.cursor = cursor;
    }

    const data = await callMoralisRest<MoralisWalletNftsResponse>(
      `/${walletAddress}/nft`,
      searchParams,
    );

    const results = Array.isArray(data.result) ? data.result : [];
    allNfts.push(...results);

    if (!data.cursor) {
      break;
    }

    cursor = data.cursor;

    if (page === MAX_NFT_HOLDING_PAGES - 1) {
      truncated = true;
    }
  }

  const holdings = allNfts
    .filter(
      (nft) =>
        typeof nft.token_address === "string" &&
        typeof nft.token_id === "string",
    )
    .map((nft) => ({
      contractAddress: String(nft.token_address),
      tokenId: String(nft.token_id),
      name: nft.normalized_metadata?.name ?? nft.name ?? null,
      imageUrl: nft.normalized_metadata?.image ?? null,
    }));

  return { holdings, truncated };
}

export type MoralisNativeTransfer = {
  from_address?: string;
  to_address?: string;
  value?: string;
  value_formatted?: string;
  direction?: string;
  internal_transaction?: boolean;
  token_symbol?: string;
};

export type MoralisErc20Transfer = {
  token_name?: string;
  token_symbol?: string;
  token_decimals?: string | number;
  from_address?: string;
  to_address?: string;
  address?: string;
  value?: string;
  value_formatted?: string;
  direction?: string;
};

// Shape unconfirmed live (docs describe it only as "approval/revocation
// data") - read defensively in parseEthereumTransaction, never assumed.
export type MoralisContractInteraction = {
  address?: string;
  contract_address?: string;
  spender?: string;
};

// possible_spam and verified_collection are Moralis's own native spam/scam
// classification, confirmed live against the actual /wallets/{address}/
// history response (not just docs) - see isLikelySpamNftTransfer below for
// how this is used. Live-verified: possible_spam alone catches only ~44%
// of confirmed-spam NFT receipts on a real test wallet (4/9) - it's a real
// signal, not a complete one, which is why it's combined with the
// null-address-mint check rather than relied on alone.
export type MoralisNftTransfer = {
  token_address?: string;
  token_id?: string;
  token_name?: string;
  from_address?: string;
  to_address?: string;
  value?: string;
  direction?: string;
  possible_spam?: boolean;
  verified_collection?: boolean;
};

export type MoralisWalletTransaction = {
  hash?: string;
  block_number?: string;
  block_timestamp?: string;
  from_address?: string;
  to_address?: string;
  value?: string;
  receipt_status?: string;
  category?: string;
  summary?: string;
  native_transfers?: MoralisNativeTransfer[];
  erc20_transfers?: MoralisErc20Transfer[];
  contract_interactions?: MoralisContractInteraction[] | null;
  nft_transfers?: MoralisNftTransfer[];
};

export type MoralisWalletTransactionsResponse = {
  result?: MoralisWalletTransaction[];
  cursor?: string | null;
};

export type EthereumTransaction = {
  hash: string;
  blockNumber: number | null;
  blockTimestamp: number | null;
  fromAddress: string | null;
  toAddress: string | null;
  valueWei: string | null;
  status: "success" | "failed" | "unknown";
  nativeTransfers: MoralisNativeTransfer[];
  tokenTransfers: MoralisErc20Transfer[];
  contractInteractions: MoralisContractInteraction[];
  nftTransfers: MoralisNftTransfer[];
};

// The canonical EVM null/genesis address - already used the same way in
// exposure/staticRegistry.ts and labels/staticRegistry.ts ("Null:
// 0x000...000 (genesis/null address)"). Minting an NFT directly from this
// address (rather than a real seller/marketplace) is the single strongest
// signal found during live investigation: 7 of 9 confirmed-spam NFT
// receipts on a real test wallet were minted from this address.
const EVM_NULL_ADDRESS = "0x0000000000000000000000000000000000000000";

// Validated, narrow-scope spam signal (Ethereum/BSC/Base only - Solana has
// no equivalent and is out of scope here): possible_spam is Moralis's own
// flag OR the transfer was minted directly from the null address. Combined
// because live testing showed possible_spam alone misses real spam (5 of 9
// confirmed-spam receipts on one test wallet were NOT flagged), while
// null-address-mint alone would miss anything Moralis's own detector does
// catch that isn't a direct mint.
//
// Deliberately does NOT include: verified_collection (live-tested, proven
// unreliable - a real mass-distribution spam collection, "World Cups"/
// WCUPS, showed verified_collection: true because it uses OpenSea's own
// verified SeaDrop minting standard), transaction-level category (also
// live-tested and proven unreliable - all 98 of that same spam wallet's
// entries were categorized "nft purchase" by Moralis, indistinguishable
// from a genuine collector's real purchases), or same-contract/multi-
// sender counting (live-tested against real collector wallets and produced
// confirmed false positives - a real trader legitimately buying multiple
// items of the same blue-chip collection from different sellers looks
// identical to mass-distribution by this measure alone). The
// "mass-distribution disguised as real marketplace activity" pattern this
// leaves uncaught is a known, deliberately deferred gap - see the
// transparency note this feeds into wallet.ts.
export function isLikelySpamNftTransfer(
  transfer: MoralisNftTransfer,
): boolean {
  return (
    transfer.possible_spam === true ||
    transfer.from_address?.toLowerCase() === EVM_NULL_ADDRESS
  );
}

// A transaction is classified spam only when EVERY nft transfer within it
// matches the spam signal - conservative on purpose, so a transaction
// mixing spam and non-spam content (or NFT activity alongside real
// native/token transfers) is never misclassified.
export function isLikelySpamNftTransaction(
  transaction: EthereumTransaction,
): boolean {
  return (
    transaction.nftTransfers.length > 0 &&
    transaction.nftTransfers.every(isLikelySpamNftTransfer)
  );
}

function toUnixSeconds(isoTimestamp: string | undefined): number | null {
  if (!isoTimestamp) {
    return null;
  }

  const parsed = Date.parse(isoTimestamp);

  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function toEthereumTransaction(
  transaction: MoralisWalletTransaction,
): EthereumTransaction | null {
  if (!transaction.hash) {
    return null;
  }

  return {
    hash: transaction.hash,
    blockNumber:
      typeof transaction.block_number === "string"
        ? Number(transaction.block_number)
        : null,
    blockTimestamp: toUnixSeconds(transaction.block_timestamp),
    fromAddress: transaction.from_address ?? null,
    toAddress: transaction.to_address ?? null,
    valueWei: transaction.value ?? null,
    status:
      transaction.receipt_status === "1"
        ? "success"
        : transaction.receipt_status === "0"
          ? "failed"
          : "unknown",
    nativeTransfers: Array.isArray(transaction.native_transfers)
      ? transaction.native_transfers
      : [],
    tokenTransfers: Array.isArray(transaction.erc20_transfers)
      ? transaction.erc20_transfers
      : [],
    contractInteractions: Array.isArray(transaction.contract_interactions)
      ? transaction.contract_interactions
      : [],
    nftTransfers: Array.isArray(transaction.nft_transfers)
      ? transaction.nft_transfers
      : [],
  };
}

export async function getEthereumTransactions(
  address: string,
  chain: MoralisEvmChain,
  limit = 20,
  cursor?: string | null,
  order?: "ASC" | "DESC",
): Promise<{ transactions: EthereumTransaction[]; nextCursor: string | null }> {
  const walletAddress = address.trim();

  if (!walletAddress) {
    throw new Error("Wallet address is required");
  }

  const searchParams: Record<string, string> = {
    chain,
    limit: String(limit),
  };

  if (cursor) {
    searchParams.cursor = cursor;
  }

  if (order) {
    searchParams.order = order;
  }

  const data = await callMoralisRest<MoralisWalletTransactionsResponse>(
    `/wallets/${walletAddress}/history`,
    searchParams,
  );

  const results = Array.isArray(data.result) ? data.result : [];

  const transactions = results
    .map(toEthereumTransaction)
    .filter((transaction): transaction is EthereumTransaction => transaction !== null);

  return {
    transactions,
    nextCursor: data.cursor ?? null,
  };
}

// Live-verified (against Vitalik's address, matching Etherscan's actual
// 2015-09-28 first-transaction date): order=ASC&limit=1 returns the
// wallet's oldest transaction directly in a single call. This replaced
// an earlier page-walking-with-a-cap approach that silently returned
// the last transaction seen within a capped scan window as "oldest" -
// which is wrong for any wallet with more history than the cap covers
// (confirmed broken on this exact wallet before this fix).
export async function getEthereumOldestTransaction(
  address: string,
  chain: MoralisEvmChain,
): Promise<EthereumTransaction | null> {
  const { transactions } = await getEthereumTransactions(
    address,
    chain,
    1,
    null,
    "ASC",
  );

  return transactions[0] ?? null;
}

export async function getEthereumTransaction(
  transactionHash: string,
  chain: MoralisEvmChain,
): Promise<EthereumTransaction | null> {
  const cleanedHash = transactionHash.trim();

  if (!cleanedHash) {
    throw new Error("Transaction hash is required");
  }

  const data = await callMoralisRest<MoralisWalletTransaction>(
    `/transaction/${cleanedHash}`,
    { chain },
  );

  return toEthereumTransaction(data);
}

export type MoralisTokenPriceResult = {
  tokenAddress?: string;
  usdPrice?: number;
};

// Moralis hard-caps this endpoint at 100 tokens per call ("tokens must
// contain not more than 100 elements", confirmed live: a 464-token request
// against a real, heavily-active wallet - PancakeSwap V2 Router - and a
// 433-token request against a real Base wallet both got a 400 at this
// exact message with 101+ tokens, succeeded at 100). This is NOT a rare
// edge case - both real test wallets already used elsewhere in this
// project exceed 100 distinct token holdings, so chunking is required for
// this function to work at all on realistic wallets, not just an
// optimization for unusually large ones.
const MAX_TOKENS_PER_PRICE_REQUEST = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

// Batch endpoint, not one call per token (see providers/pricing/evm.ts) -
// live-confirmed flat 100 CU per call regardless of count up to the 100-
// token cap above (tested at 2, 5, 30, and 50 tokens in one call, all
// exactly 100 CU - a single-token call via the non-batch
// /erc20/{address}/price endpoint alone costs 50 CU, so batching even two
// tokens together is already cheaper per-token). Each result item carries
// its own tokenAddress (lowercased by Moralis) rather than relying on
// response-array order matching request-array order, so callers must match
// by address, not index. One chunk's failure doesn't fail the others - a
// wallet with 400+ tokens still gets prices for the chunks that succeeded
// rather than an all-or-nothing result.
export async function getEthereumTokenPrices(
  tokenAddresses: string[],
  chain: MoralisEvmChain,
): Promise<Record<string, number | null>> {
  const uniqueAddresses = Array.from(
    new Set(
      tokenAddresses
        .map((address) => address.trim().toLowerCase())
        .filter(Boolean),
    ),
  );

  if (uniqueAddresses.length === 0) {
    return {};
  }

  const pricesByAddress: Record<string, number | null> = {};

  for (const address of uniqueAddresses) {
    pricesByAddress[address] = null;
  }

  const addressChunks = chunk(uniqueAddresses, MAX_TOKENS_PER_PRICE_REQUEST);

  for (const addressChunk of addressChunks) {
    let results: MoralisTokenPriceResult[];

    try {
      results = await callMoralisRestPost<MoralisTokenPriceResult[]>(
        "/erc20/prices",
        {
          tokens: addressChunk.map((address) => ({ token_address: address })),
        },
        { chain },
      );
    } catch {
      // This chunk's addresses stay null (already defaulted above) -
      // other chunks still get a chance to succeed.
      continue;
    }

    for (const result of results) {
      const address = result.tokenAddress?.toLowerCase();

      if (address && typeof result.usdPrice === "number") {
        pricesByAddress[address] = result.usdPrice;
      }
    }
  }

  return pricesByAddress;
}
