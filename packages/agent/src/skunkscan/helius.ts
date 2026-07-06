export type SolanaBalanceResult = {
  address: string;
  lamports: number;
  sol: number;
};

export type SolanaSignatureResult = {
  signature: string;
  slot?: number;
  blockTime?: number | null;
  err?: unknown;
};

export type SolanaOldestSignatureResult = {
  signature: string | null;
  blockTime: number | null;
  scannedTransactionCount: number;
  reachedOldestKnownTransaction: boolean;
};

export type SolanaParsedTransaction = {
  signature?: string;
  timestamp?: number;
  nativeTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    amount?: number;
  }>;
};

function getHeliusApiKey(): string {
  const apiKey = process.env.HELIUS_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("Missing HELIUS_API_KEY environment variable");
  }

  return apiKey;
}

function getHeliusRpcUrl(): string {
  const apiKey = getHeliusApiKey();
  return `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
}

function getHeliusApiUrl(path: string): string {
  const apiKey = getHeliusApiKey();
  return `https://api.helius.xyz${path}?api-key=${apiKey}`;
}

async function callHeliusRpc<T>(
  id: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const response = await fetch(getHeliusRpcUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`Helius request failed with status ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message ?? "Helius returned an error");
  }

  return data.result as T;
}

export async function getSolanaBalance(
  address: string,
): Promise<SolanaBalanceResult> {
  if (!address || address.trim().length === 0) {
    throw new Error("Wallet address is required");
  }

  const lamports = await callHeliusRpc<number>(
    "skunkscan-balance",
    "getBalance",
    [address.trim()],
  ).then((result: any) => result?.value);

  if (typeof lamports !== "number") {
    throw new Error("Invalid Helius balance response");
  }

  return {
    address: address.trim(),
    lamports,
    sol: lamports / 1_000_000_000,
  };
}

export async function getSolanaRecentSignatures(
  address: string,
  limit = 20,
): Promise<SolanaSignatureResult[]> {
  if (!address || address.trim().length === 0) {
    throw new Error("Wallet address is required");
  }

  const result = await callHeliusRpc<SolanaSignatureResult[]>(
    "skunkscan-signatures",
    "getSignaturesForAddress",
    [
      address.trim(),
      {
        limit,
      },
    ],
  );

  return Array.isArray(result) ? result : [];
}

export async function getSolanaOldestKnownSignature(
  address: string,
  maxPages = 20,
  pageSize = 1000,
): Promise<SolanaOldestSignatureResult> {
  if (!address || address.trim().length === 0) {
    throw new Error("Wallet address is required");
  }

  let before: string | undefined;
  let oldestSignature: SolanaSignatureResult | null = null;
  let scannedTransactionCount = 0;
  let reachedOldestKnownTransaction = false;

  for (let page = 0; page < maxPages; page += 1) {
    const options: {
      limit: number;
      before?: string;
    } = {
      limit: pageSize,
    };

    if (before) {
      options.before = before;
    }

    const signatures = await callHeliusRpc<SolanaSignatureResult[]>(
      `skunkscan-oldest-signature-${page + 1}`,
      "getSignaturesForAddress",
      [address.trim(), options],
    );

    if (!Array.isArray(signatures) || signatures.length === 0) {
      reachedOldestKnownTransaction = true;
      break;
    }

    scannedTransactionCount += signatures.length;
    oldestSignature = signatures[signatures.length - 1];

    if (signatures.length < pageSize) {
      reachedOldestKnownTransaction = true;
      break;
    }

    before = oldestSignature.signature;
  }

  return {
    signature: oldestSignature?.signature ?? null,
    blockTime:
      typeof oldestSignature?.blockTime === "number"
        ? oldestSignature.blockTime
        : null,
    scannedTransactionCount,
    reachedOldestKnownTransaction,
  };
}

export async function getSolanaParsedTransactions(
  signatures: string[],
): Promise<SolanaParsedTransaction[]> {
  const cleanedSignatures = signatures
    .map((signature) => signature.trim())
    .filter(Boolean);

  if (cleanedSignatures.length === 0) {
    return [];
  }

  const response = await fetch(getHeliusApiUrl("/v0/transactions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      transactions: cleanedSignatures,
    }),
  });

  if (!response.ok) {
    throw new Error(`Helius transaction parse failed with status ${response.status}`);
  }

  const data = await response.json();

  return Array.isArray(data) ? data : [];
}

export type SolanaTokenHolding = {
  mint: string;
  amount: number;
  decimals: number;
  rawAmount: string;
};

export async function getSolanaTokenHoldings(
  address: string,
): Promise<SolanaTokenHolding[]> {
  if (!address || address.trim().length === 0) {
    throw new Error("Wallet address is required");
  }

  const accounts = await callHeliusRpc<any[]>(
    "skunkscan-token-accounts",
    "getTokenAccountsByOwner",
    [
      address.trim(),
      {
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      },
      {
        encoding: "jsonParsed",
      },
    ],
  ).then((result: any) => result?.value);

  if (!Array.isArray(accounts)) {
    return [];
  }

  return accounts
    .map((account) => {
      const info = account?.account?.data?.parsed?.info;
      const tokenAmount = info?.tokenAmount;

      return {
        mint: String(info?.mint ?? ""),
        amount: Number(tokenAmount?.uiAmount ?? 0),
        decimals: Number(tokenAmount?.decimals ?? 0),
        rawAmount: String(tokenAmount?.amount ?? "0"),
      };
    })
    .filter((token) => token.mint && token.amount > 0);
}
