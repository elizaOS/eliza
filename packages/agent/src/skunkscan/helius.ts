export type SolanaBalanceResult = {
  address: string;
  lamports: number;
  sol: number;
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

export async function getSolanaBalance(
  address: string,
): Promise<SolanaBalanceResult> {
  if (!address || address.trim().length === 0) {
    throw new Error("Wallet address is required");
  }

  const response = await fetch(getHeliusRpcUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "skunkscan-balance",
      method: "getBalance",
      params: [address.trim()],
    }),
  });

  if (!response.ok) {
    throw new Error(`Helius request failed with status ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message ?? "Helius returned an error");
  }

  const lamports = data.result?.value;

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
  limit = 20
): Promise<any[]> {

  const response = await fetch(getHeliusRpcUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "skunkscan-signatures",
      method: "getSignaturesForAddress",
      params: [
        address.trim(),
        {
          limit,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Helius request failed with status ${response.status}`
    );
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message ?? "Helius error");
  }

  return data.result ?? [];
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

  const response = await fetch(getHeliusRpcUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "skunkscan-token-accounts",
      method: "getTokenAccountsByOwner",
      params: [
        address.trim(),
        {
          programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        },
        {
          encoding: "jsonParsed",
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Helius request failed with status ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message ?? "Helius returned an error");
  }

  const accounts = data.result?.value;

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
