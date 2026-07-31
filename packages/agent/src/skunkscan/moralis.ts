// Raw Moralis REST calls for Ethereum data. Mirrors helius.ts's structure:
// small typed fetch functions, no SDK dependency (fetch() only, matching
// the existing pattern rather than adding @moralisweb3/* to package.json).
//
// Endpoint shapes below are sourced from Moralis's published documentation
// (docs.moralis.com/web3-data-api/evm/reference/wallet-api, the v2.2
// changelog, and the Token Balances reference), not from a live call - no
// MORALIS_API_KEY is available in this environment. Field names should be
// spot-checked against a real response once a key is available; the
// parsing for each endpoint is kept in its own small function so any
// correction stays localized.

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
    throw new Error(
      `Moralis request failed with status ${response.status}`,
    );
  }

  return (await response.json()) as T;
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
};

export type EthereumTokenHolding = {
  contractAddress: string;
  symbol: string | null;
  name: string | null;
  decimals: number;
  rawAmount: string;
};

export async function getEthereumTokenHoldings(
  address: string,
): Promise<EthereumTokenHolding[]> {
  if (!address || address.trim().length === 0) {
    throw new Error("Wallet address is required");
  }

  const data = await callMoralisRest<MoralisWalletTokensResponse>(
    `/wallets/${address.trim()}/tokens`,
    { chain: "eth" },
  );

  const tokens = Array.isArray(data.result) ? data.result : [];

  return tokens
    .filter((token) => !token.native_token && token.token_address)
    .map((token) => ({
      contractAddress: String(token.token_address),
      symbol: token.symbol ?? null,
      name: token.name ?? null,
      decimals: Number(token.decimals ?? 18),
      rawAmount: typeof token.balance === "string" ? token.balance : "0",
    }))
    .filter((token) => token.contractAddress.length > 0);
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

export type MoralisWalletTransaction = {
  hash?: string;
  block_number?: string;
  block_timestamp?: string;
  from_address?: string;
  to_address?: string;
  value?: string;
  receipt_status?: string;
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
  };
}

export async function getEthereumTransactions(
  address: string,
  limit = 20,
  cursor?: string | null,
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

  const data = await callMoralisRest<MoralisWalletTransactionsResponse>(
    `/${walletAddress}`,
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
