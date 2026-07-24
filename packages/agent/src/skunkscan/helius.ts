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

export type SolanaParsedNativeTransfer = {
  fromUserAccount?: string;
  toUserAccount?: string;
  amount?: number;
};

export type SolanaParsedTokenTransfer = {
  fromUserAccount?: string;
  toUserAccount?: string;
  fromTokenAccount?: string;
  toTokenAccount?: string;
  tokenAmount?: number;
  mint?: string;
};

export type SolanaParsedTokenBalanceChange = {
  userAccount?: string;
  tokenAccount?: string;
  mint?: string;
  rawTokenAmount?: {
    tokenAmount?: string;
    decimals?: number;
  };
};

export type SolanaParsedAccountData = {
  account?: string;
  nativeBalanceChange?: number;
  tokenBalanceChanges?: SolanaParsedTokenBalanceChange[];
};

export type SolanaParsedInstruction = {
  accounts?: string[];
  data?: string;
  programId?: string;
  innerInstructions?: SolanaParsedInstruction[];
};

export type SolanaParsedTransaction = {
  description?: string;
  type?: string;
  source?: string;
  fee?: number;
  feePayer?: string;
  signature?: string;
  slot?: number;
  timestamp?: number;

  nativeTransfers?: SolanaParsedNativeTransfer[];
  tokenTransfers?: SolanaParsedTokenTransfer[];
  accountData?: SolanaParsedAccountData[];

  transactionError?: {
    error?: unknown;
  } | null;

  instructions?: SolanaParsedInstruction[];
};

function getHeliusApiKey(): string {
  const apiKey = process.env.HELIUS_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      "Missing HELIUS_API_KEY environment variable",
    );
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
    throw new Error(
      `Helius request failed with status ${response.status}`,
    );
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(
      data.error.message ??
        "Helius returned an error",
    );
  }

  return data.result as T;
}

export async function getSolanaBalance(
  address: string,
): Promise<SolanaBalanceResult> {
  if (!address || address.trim().length === 0) {
    throw new Error("Wallet address is required");
  }

  const walletAddress = address.trim();

  const lamports = await callHeliusRpc<number>(
    "skunkscan-balance",
    "getBalance",
    [walletAddress],
  ).then((result: any) => result?.value);

  if (typeof lamports !== "number") {
    throw new Error(
      "Invalid Helius balance response",
    );
  }

  return {
    address: walletAddress,
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

  const result =
    await callHeliusRpc<SolanaSignatureResult[]>(
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

  const walletAddress = address.trim();

  let before: string | undefined;
  let oldestSignature: SolanaSignatureResult | null =
    null;
  let scannedTransactionCount = 0;
  let reachedOldestKnownTransaction = false;

  for (
    let page = 0;
    page < maxPages;
    page += 1
  ) {
    const options: {
      limit: number;
      before?: string;
    } = {
      limit: pageSize,
    };

    if (before) {
      options.before = before;
    }

    const signatures =
      await callHeliusRpc<SolanaSignatureResult[]>(
        `skunkscan-oldest-signature-${page + 1}`,
        "getSignaturesForAddress",
        [walletAddress, options],
      );

    if (
      !Array.isArray(signatures) ||
      signatures.length === 0
    ) {
      reachedOldestKnownTransaction = true;
      break;
    }

    scannedTransactionCount += signatures.length;
    oldestSignature =
      signatures[signatures.length - 1];

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

  const response = await fetch(
    getHeliusApiUrl("/v0/transactions"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transactions: cleanedSignatures,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Helius transaction parse failed with status ${response.status}`,
    );
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
        programId:
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
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
      const info =
        account?.account?.data?.parsed?.info;

      const tokenAmount = info?.tokenAmount;

      return {
        mint: String(info?.mint ?? ""),
        amount: Number(
          tokenAmount?.uiAmount ?? 0,
        ),
        decimals: Number(
          tokenAmount?.decimals ?? 0,
        ),
        rawAmount: String(
          tokenAmount?.amount ?? "0",
        ),
      };
    })
    .filter(
      (token) =>
        token.mint.length > 0 &&
        token.amount > 0,
    );
}

export type SolanaNftHolding = {
  mint: string;
  name: string | null;
  collection: string | null;
  imageUrl: string | null;
};

type HeliusDasGrouping = {
  group_key?: string;
  group_value?: string;
  collection_metadata?: {
    name?: string;
  };
};

type HeliusDasFile = {
  uri?: string;
  mime?: string;
};

type HeliusDasAsset = {
  id?: string;
  interface?: string;
  content?: {
    metadata?: {
      name?: string;
    };
    links?: {
      image?: string;
    };
    files?: HeliusDasFile[];
  };
  grouping?: HeliusDasGrouping[];
};

type HeliusGetAssetsByOwnerResponse = {
  jsonrpc?: string;
  id?: string;
  result?: {
    total?: number;
    limit?: number;
    page?: number;
    items?: HeliusDasAsset[];
  };
  error?: {
    code?: number;
    message?: string;
  };
};

function isNftAsset(
  asset: HeliusDasAsset,
): boolean {
  const assetInterface = String(
    asset.interface ?? "",
  )
    .trim()
    .toLowerCase();

  return (
    assetInterface === "v1_nft" ||
    assetInterface === "programmablenft" ||
    assetInterface === "programmable_nft" ||
    assetInterface === "custom" ||
    assetInterface.includes("nft")
  );
}

function getNftCollection(
  asset: HeliusDasAsset,
): string | null {
  if (!Array.isArray(asset.grouping)) {
    return null;
  }

  const collectionGroup = asset.grouping.find(
    (group) =>
      group?.group_key === "collection",
  );

  if (!collectionGroup) {
    return null;
  }

  const collectionName =
    collectionGroup.collection_metadata?.name?.trim();

  if (collectionName) {
    return collectionName;
  }

  const collectionAddress =
    collectionGroup.group_value?.trim();

  return collectionAddress || null;
}

function getNftImageUrl(
  asset: HeliusDasAsset,
): string | null {
  const linkedImage =
    asset.content?.links?.image?.trim();

  if (linkedImage) {
    return linkedImage;
  }

  const files = asset.content?.files;

  if (!Array.isArray(files)) {
    return null;
  }

  const imageFile = files.find((file) => {
    const mime = file?.mime
      ?.trim()
      .toLowerCase();

    return (
      typeof mime === "string" &&
      mime.startsWith("image/") &&
      Boolean(file?.uri?.trim())
    );
  });

  if (imageFile?.uri?.trim()) {
    return imageFile.uri.trim();
  }

  const firstFileUrl = files.find(
    (file) => Boolean(file?.uri?.trim()),
  )?.uri;

  return firstFileUrl?.trim() || null;
}

export async function getSolanaNftHoldings(
  address: string,
): Promise<SolanaNftHolding[]> {
  const walletAddress = address.trim();

  if (!walletAddress) {
    throw new Error(
      "Wallet address is required",
    );
  }

  const response = await fetch(
    getHeliusRpcUrl(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "skunkscan-nft-holdings",
        method: "getAssetsByOwner",
        params: {
          ownerAddress: walletAddress,
          page: 1,
          limit: 100,
          displayOptions: {
            showFungible: false,
            showNativeBalance: false,
            showCollectionMetadata: true,
            showUnverifiedCollections: false,
          },
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Helius NFT request failed with status ${response.status}`,
    );
  }

  const data =
    (await response.json()) as
      HeliusGetAssetsByOwnerResponse;

  if (data.error) {
    throw new Error(
      `Helius NFT request failed: ${
        data.error.message ??
        "Unknown DAS API error"
      }`,
    );
  }

  const items = data.result?.items;

  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .filter(isNftAsset)
    .slice(0, 10)
    .map((asset) => ({
      mint: String(asset.id ?? "").trim(),
      name:
        asset.content?.metadata?.name?.trim() ||
        null,
      collection: getNftCollection(asset),
      imageUrl: getNftImageUrl(asset),
    }))
    .filter((nft) => nft.mint.length > 0);
}
