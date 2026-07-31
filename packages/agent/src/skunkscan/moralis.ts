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
): Promise<{ address: string; wei: string }> {
  if (!address || address.trim().length === 0) {
    throw new Error("Wallet address is required");
  }

  const walletAddress = address.trim();

  const data = await callMoralisRest<MoralisNativeBalanceResponse>(
    `/${walletAddress}/balance`,
    { chain: "eth" },
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
      chain: "eth",
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
};

export type EthereumNftHolding = {
  contractAddress: string;
  tokenId: string;
  name: string | null;
  imageUrl: string | null;
};

export async function getEthereumNftHoldings(
  address: string,
): Promise<EthereumNftHolding[]> {
  const walletAddress = address.trim();

  if (!walletAddress) {
    throw new Error("Wallet address is required");
  }

  const data = await callMoralisRest<MoralisWalletNftsResponse>(
    `/${walletAddress}/nft`,
    { chain: "eth", format: "decimal" },
  );

  const items = Array.isArray(data.result) ? data.result : [];

  return items
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
};

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
  };
}

export async function getEthereumTransactions(
  address: string,
  limit = 20,
  cursor?: string | null,
  order?: "ASC" | "DESC",
): Promise<{ transactions: EthereumTransaction[]; nextCursor: string | null }> {
  const walletAddress = address.trim();

  if (!walletAddress) {
    throw new Error("Wallet address is required");
  }

  const searchParams: Record<string, string> = {
    chain: "eth",
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
): Promise<EthereumTransaction | null> {
  const { transactions } = await getEthereumTransactions(address, 1, null, "ASC");

  return transactions[0] ?? null;
}

export async function getEthereumTransaction(
  transactionHash: string,
): Promise<EthereumTransaction | null> {
  const cleanedHash = transactionHash.trim();

  if (!cleanedHash) {
    throw new Error("Transaction hash is required");
  }

  const data = await callMoralisRest<MoralisWalletTransaction>(
    `/transaction/${cleanedHash}`,
    { chain: "eth" },
  );

  return toEthereumTransaction(data);
}
