/** Public Solana reads without loading a signer or transaction routes. */
import {
  type Action,
  ElizaError,
  fetchWithSsrfGuard,
  type JsonValue,
  type Plugin,
  readResponseWithLimit,
} from "@elizaos/core";
import { DexScreenerService } from "./dexscreener/service";

function address(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))
    throw new ElizaError("A Solana public address is required.", {
      code: "SOLANA_READ_ADDRESS_INVALID",
    });
  return value;
}

export async function readSolanaWallet(
  owner: string,
  options: { rpcUrl: string; signal?: AbortSignal },
) {
  owner = address(owner);
  const request = async (method: string, params: unknown[]) => {
    const { response, release } = await fetchWithSsrfGuard({
      url: options.rpcUrl,
      signal: options.signal,
      timeoutMs: 15_000,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      },
    });
    try {
      if (!response.ok)
        throw new ElizaError("The configured Solana RPC is unavailable.", {
          code: "SOLANA_READ_RPC_UNAVAILABLE",
        });
      const payload = JSON.parse(
        (await readResponseWithLimit(response, 1024 * 1024)).toString("utf8"),
      ) as {
        id?: unknown;
        error?: unknown;
        result?: { context?: JsonValue; value?: JsonValue };
      };
      if (payload.id !== 1 || payload.error || !payload.result)
        throw new ElizaError(
          "The configured Solana RPC returned an invalid response.",
          { code: "SOLANA_READ_RPC_INVALID" },
        );
      return payload.result;
    } finally {
      await release();
    }
  };
  const [balance, tokens] = await Promise.all([
    request("getBalance", [owner, { commitment: "confirmed" }]),
    request("getTokenAccountsByOwner", [
      owner,
      { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]),
  ]);
  if (
    typeof balance.value !== "number" ||
    !Number.isSafeInteger(balance.value) ||
    balance.value < 0 ||
    !Array.isArray(tokens.value)
  )
    throw new ElizaError(
      "The Solana balance or token response cannot be represented exactly.",
      { code: "SOLANA_READ_VALUE_INVALID" },
    );
  return {
    owner,
    lamports: String(balance.value),
    balanceContext: balance.context,
    tokenAccounts: tokens.value,
    tokenContext: tokens.context,
    sourceUrl: new URL(options.rpcUrl).origin,
    cluster: "Owner-configured RPC; cluster is not independently verified",
    retrievedAt: new Date().toISOString(),
    coverage:
      "Confirmed RPC snapshot and SPL Token program accounts. Token-2022, other programs, USD value and complete portfolio coverage are not claimed.",
  };
}

export const solanaWalletReadAction: Action = {
  name: "SOLANA_WALLET",
  similes: [],
  tags: ["resource:wallet", "capability:read"],
  contexts: ["general"],
  roleGate: { minRole: "GUEST" },
  description:
    "Read a public Solana balance and SPL Token accounts through the owner's configured RPC. No private key, signing, transfers or portfolio valuation.",
  parameters: [
    {
      name: "address",
      description: "Public Solana wallet address.",
      required: true,
      schema: { type: "string" },
    },
  ],
  validate: async () => true,
  handler: async (runtime, _message, _state, options) => {
    const params = options?.parameters as Record<string, unknown> | undefined;
    const rpcUrl = runtime.getSetting("SOLANA_RPC_URL");
    if (typeof rpcUrl !== "string" || !rpcUrl.trim())
      throw new ElizaError(
        "Configure your own SOLANA_RPC_URL for public wallet reads.",
        { code: "SOLANA_READ_RPC_REQUIRED" },
      );
    const data = await readSolanaWallet(address(params?.address), {
      rpcUrl,
      signal:
        options?.abortSignal instanceof AbortSignal
          ? options.abortSignal
          : undefined,
    });
    return {
      success: true,
      text: JSON.stringify(data),
      modelReplyRequired: true,
      data: {
        actionName: "SOLANA_WALLET",
        ...data,
        sources: [{ url: data.sourceUrl, text: JSON.stringify(data) }],
      },
    };
  },
};

export const solanaMarketsReadAction: Action = {
  name: "SOLANA_MARKETS",
  similes: [],
  tags: ["resource:markets", "capability:read"],
  contexts: ["general"],
  roleGate: { minRole: "GUEST" },
  description:
    "Read public Solana token pair snapshots through the existing DexScreener service. Preserves case-sensitive addresses; liquidity and DEX price are not an exchange quote or token launch guarantee.",
  parameters: [
    {
      name: "address",
      description: "Public Solana token mint address.",
      required: true,
      schema: { type: "string" },
    },
  ],
  validate: async () => true,
  handler: async (runtime, _message, _state, options) => {
    const params = options?.parameters as Record<string, unknown> | undefined;
    const token = address(params?.address);
    const service = runtime.getService<DexScreenerService>("dexscreener");
    if (!service)
      throw new ElizaError("The DexScreener service is unavailable.", {
        code: "SOLANA_MARKETS_SERVICE_UNAVAILABLE",
      });
    if (options?.abortSignal instanceof AbortSignal)
      options.abortSignal.throwIfAborted();
    const result = await service.getTokenPairsByChain("solana", token);
    if (options?.abortSignal instanceof AbortSignal)
      options.abortSignal.throwIfAborted();
    if (!result.success)
      throw new ElizaError(
        "The public Solana market snapshot is unavailable.",
        { code: "SOLANA_MARKETS_UNAVAILABLE" },
      );
    const data = {
      address: token,
      pairs: result.data,
      retrievedAt: new Date().toISOString(),
      sourceUrl: `https://dexscreener.com/solana/${token}`,
      coverage:
        "DEX provider snapshot; retrieval is not exchange quote time or listing verification.",
    };
    return {
      success: true,
      text: JSON.stringify(data),
      modelReplyRequired: true,
      data: {
        actionName: "SOLANA_MARKETS",
        ...data,
        sources: [{ url: data.sourceUrl, text: JSON.stringify(data) }],
      },
    };
  },
};

export const publicSolanaReadPlugin: Plugin = {
  name: "solana-public-read",
  description: "Read public Solana data without signer or transaction routes.",
  actions: [solanaWalletReadAction, solanaMarketsReadAction],
  services: [DexScreenerService],
};
