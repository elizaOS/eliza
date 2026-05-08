import type { IAgentRuntime, ITokenDataService } from "@elizaos/core";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  type Address,
  type Chain,
  encodeFunctionData,
  parseAbi,
  parseUnits,
} from "viem";
import * as viemChains from "viem/chains";
import type { WalletBackendService } from "../services/wallet-backend-service.js";
import type {
  WalletChainHandler,
  WalletRouterContext,
  WalletRouterExecution,
  WalletRouterParams,
} from "../types/wallet-router.js";
import { buildSendTxParams } from "./evm/actions/helpers";
import { SwapAction } from "./evm/actions/swap";
import { TransferAction } from "./evm/actions/transfer";
import { routeEvmBridge } from "./evm/bridge-router";
import { DEFAULT_CHAINS, NATIVE_TOKEN_ADDRESS } from "./evm/constants";
import { initWalletProvider } from "./evm/providers/wallet";
import type { SupportedChain, Transaction } from "./evm/types";
import BigNumber from "./solana/bn";
import { SOLANA_SERVICE_NAME } from "./solana/constants";
import { getWalletKey } from "./solana/keypairUtils";
import type { SolanaService } from "./solana/service";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOLANA_DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

function getRuntimeSetting(runtime: IAgentRuntime, key: string): string | null {
  const value = runtime.getSetting(key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseBoolSetting(value: string | number | boolean | null): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const str = String(value).toLowerCase().trim();
  return str === "true" || str === "1" || str === "yes";
}

function configuredEvmChains(runtime: IAgentRuntime): Array<{
  readonly key: string;
  readonly chain: Chain;
}> {
  const settings = runtime.character?.settings;
  const configured =
    settings &&
    typeof settings === "object" &&
    "chains" in settings &&
    settings.chains &&
    typeof settings.chains === "object" &&
    "evm" in settings.chains &&
    Array.isArray(settings.chains.evm)
      ? settings.chains.evm.filter(
          (chain): chain is string => typeof chain === "string",
        )
      : [...DEFAULT_CHAINS];

  const out: Array<{ key: string; chain: Chain }> = [];
  for (const key of configured) {
    const chain = (viemChains as Record<string, Chain | undefined>)[key];
    if (chain?.id) {
      out.push({ key, chain });
    }
  }
  return out;
}

function evmAliases(key: string, chain: Chain): string[] {
  const aliases = new Set<string>([
    key,
    chain.name,
    String(chain.id),
    chain.nativeCurrency.symbol,
  ]);
  if (key === "mainnet") {
    aliases.add("ethereum");
    aliases.add("eth");
  }
  return [...aliases];
}

function isEvmAddress(value: string): value is Address {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isNativeEvmToken(value: string | undefined, chain: Chain): boolean {
  if (!value) return true;
  const normalized = value.toLowerCase();
  return (
    normalized === "native" ||
    normalized === "eth" ||
    normalized === chain.nativeCurrency.symbol.toLowerCase() ||
    normalized === NATIVE_TOKEN_ADDRESS.toLowerCase()
  );
}

async function resolveTokenViaService(
  service: ITokenDataService | null,
  token: string,
  chain: string,
): Promise<string | null> {
  if (!service) return null;
  const results = await service.searchTokens(token, chain, 5);
  const match = results.find((candidate) => {
    const maybe = candidate as { address?: unknown; symbol?: unknown };
    return (
      typeof maybe.address === "string" &&
      (String(maybe.symbol ?? "").toLowerCase() === token.toLowerCase() ||
        maybe.address.toLowerCase() === token.toLowerCase())
    );
  });
  const address = (match as { address?: unknown } | undefined)?.address;
  return typeof address === "string" ? address : null;
}

async function resolveEvmTokenAddress(
  token: string | undefined,
  chainKey: string,
  chain: Chain,
  context: WalletRouterContext,
): Promise<Address> {
  if (isNativeEvmToken(token, chain)) {
    return NATIVE_TOKEN_ADDRESS;
  }
  if (token && isEvmAddress(token)) {
    return token;
  }
  if (token) {
    const resolved = await resolveTokenViaService(
      context.tokenDataService,
      token,
      chainKey,
    );
    if (resolved && isEvmAddress(resolved)) {
      return resolved;
    }
  }
  throw new Error(
    `Token "${token ?? "native"}" must be an EVM address or a resolvable ${chain.name} token symbol.`,
  );
}

function transactionToExecution(
  tx: Transaction,
  params: WalletRouterParams,
  chainKey: string,
  chain: Chain,
): WalletRouterExecution {
  return {
    status: "submitted",
    chain: chainKey,
    chainId: String(chain.id),
    subaction: params.subaction,
    dryRun: false,
    mode: params.mode,
    transactionHash: tx.hash,
    from: tx.from,
    to: tx.to,
    amount: params.amount,
    fromToken: params.fromToken,
    toToken: params.toToken,
    metadata: {
      value: tx.value.toString(),
      data: tx.data,
      chainId: tx.chainId ?? chain.id,
    },
  };
}

async function executeEvmTransfer(
  params: WalletRouterParams,
  context: WalletRouterContext,
  chainKey: string,
  chain: Chain,
): Promise<WalletRouterExecution> {
  const recipient = params.recipient;
  if (!recipient || !isEvmAddress(recipient)) {
    throw new Error("recipient must be a valid EVM address.");
  }

  const walletProvider = await initWalletProvider(context.runtime);
  const token = await resolveEvmTokenAddress(
    params.fromToken,
    chainKey,
    chain,
    context,
  );

  if (token === NATIVE_TOKEN_ADDRESS) {
    const action = new TransferAction(walletProvider);
    const tx = await action.transfer({
      fromChain: chainKey as SupportedChain,
      toAddress: recipient,
      amount: params.amount ?? "",
      token: params.fromToken,
    });
    return transactionToExecution(tx, params, chainKey, chain);
  }

  const walletClient = walletProvider.getWalletClient(
    chainKey as SupportedChain,
  );
  const account = walletClient.account;
  if (!account) {
    throw new Error("Wallet account is not available.");
  }

  const publicClient = walletProvider.getPublicClient(
    chainKey as SupportedChain,
  );
  const decimalsAbi = parseAbi(["function decimals() view returns (uint8)"]);
  const decimals = Number(
    await publicClient.readContract({
      address: token,
      abi: decimalsAbi,
      functionName: "decimals",
      authorizationList: undefined,
    }),
  );
  const transferAbi = parseAbi([
    "function transfer(address,uint256) returns (bool)",
  ]);
  const data = encodeFunctionData({
    abi: transferAbi,
    functionName: "transfer",
    args: [recipient, parseUnits(params.amount ?? "", decimals)],
  });

  const hash = await walletClient.sendTransaction(
    buildSendTxParams({
      account,
      to: token,
      value: 0n,
      data,
      chain,
    }),
  );

  return {
    status: "submitted",
    chain: chainKey,
    chainId: String(chain.id),
    subaction: params.subaction,
    dryRun: false,
    mode: params.mode,
    transactionHash: hash,
    from: account.address,
    to: recipient,
    amount: params.amount,
    fromToken: token,
    metadata: {
      token,
      decimals,
      value: "0",
      data,
    },
  };
}

async function executeEvmSwap(
  params: WalletRouterParams,
  context: WalletRouterContext,
  chainKey: string,
  chain: Chain,
): Promise<WalletRouterExecution> {
  const walletProvider = await initWalletProvider(context.runtime);
  const fromToken = await resolveEvmTokenAddress(
    params.fromToken,
    chainKey,
    chain,
    context,
  );
  const toToken = await resolveEvmTokenAddress(
    params.toToken,
    chainKey,
    chain,
    context,
  );

  const action = new SwapAction(walletProvider);
  const tx = await action.swap({
    chain: chainKey as SupportedChain,
    fromToken,
    toToken,
    amount: params.amount ?? "",
  });
  return transactionToExecution(
    {
      ...tx,
      chainId: tx.chainId ?? chain.id,
    },
    {
      ...params,
      fromToken,
      toToken,
    },
    chainKey,
    chain,
  );
}

function createEvmHandler(key: string, chain: Chain): WalletChainHandler {
  const aliases = evmAliases(key, chain);
  return {
    chainId: String(chain.id),
    chain: key,
    name: chain.name,
    aliases,
    supportedActions: ["transfer", "swap", "bridge"],
    tokens: [
      {
        symbol: chain.nativeCurrency.symbol,
        address: NATIVE_TOKEN_ADDRESS,
        decimals: chain.nativeCurrency.decimals,
        native: true,
      },
    ],
    signer: {
      required: true,
      kind: "evm",
      source: "WalletBackend EVM signer or EVM_PRIVATE_KEY",
      description: "Required only for execute mode.",
    },
    dryRun: {
      supported: true,
      supportedActions: ["transfer", "swap", "bridge"],
      description:
        "Prepare mode and dry-run return route metadata without signing.",
    },
    async execute(params, context) {
      if (params.subaction === "transfer") {
        return executeEvmTransfer(params, context, key, chain);
      }
      if (params.subaction === "swap") {
        return executeEvmSwap(params, context, key, chain);
      }
      if (params.subaction === "bridge") {
        return routeEvmBridge(params, context, key, chain);
      }
      throw new Error(`${chain.name} does not support ${params.subaction}.`);
    },
  };
}

function resolveSolanaMint(token: string | undefined): string {
  if (!token) return SOL_MINT;
  const normalized = token.trim();
  if (
    normalized.toLowerCase() === "sol" ||
    normalized.toLowerCase() === "native" ||
    normalized === SOL_MINT
  ) {
    return SOL_MINT;
  }
  return normalized;
}

function getSolanaConnection(runtime: IAgentRuntime): Connection {
  const service = runtime.getService(
    SOLANA_SERVICE_NAME,
  ) as SolanaService | null;
  if (service) {
    return service.getConnection();
  }
  const rpcUrl =
    getRuntimeSetting(runtime, "SOLANA_RPC_URL") ?? SOLANA_DEFAULT_RPC;
  return new Connection(rpcUrl);
}

async function getSolanaTokenDecimals(
  connection: Connection,
  mintAddress: string,
): Promise<number> {
  if (mintAddress === SOL_MINT) {
    return 9;
  }
  const mintPublicKey = new PublicKey(mintAddress);
  const tokenAccountInfo = await connection.getParsedAccountInfo(mintPublicKey);

  if (
    tokenAccountInfo.value &&
    typeof tokenAccountInfo.value.data === "object" &&
    "parsed" in tokenAccountInfo.value.data
  ) {
    const parsedInfo = tokenAccountInfo.value.data.parsed?.info;
    if (parsedInfo && typeof parsedInfo.decimals === "number") {
      return parsedInfo.decimals;
    }
  }

  throw new Error(`Unable to fetch token decimals for ${mintAddress}`);
}

async function executeSolanaTransfer(
  params: WalletRouterParams,
  context: WalletRouterContext,
): Promise<WalletRouterExecution> {
  if (!params.recipient) {
    throw new Error("recipient is required for Solana transfer.");
  }
  const { keypair: senderKeypair } = await getWalletKey(context.runtime, true);
  if (!senderKeypair) {
    throw new Error("Solana keypair is not available.");
  }
  const connection = getSolanaConnection(context.runtime);
  const recipientPubkey = new PublicKey(params.recipient);
  const tokenMint = resolveSolanaMint(params.fromToken);
  const instructions: TransactionInstruction[] = [];

  if (tokenMint === SOL_MINT) {
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: senderKeypair.publicKey,
        toPubkey: recipientPubkey,
        lamports: Math.round(Number(params.amount) * LAMPORTS_PER_SOL),
      }),
    );
  } else {
    const mintPubkey = new PublicKey(tokenMint);
    const decimals = await getSolanaTokenDecimals(connection, tokenMint);
    const adjustedAmount = BigInt(
      new BigNumber(params.amount ?? "0")
        .multipliedBy(new BigNumber(10).pow(decimals))
        .integerValue()
        .toFixed(0),
    );
    const senderAta = getAssociatedTokenAddressSync(
      mintPubkey,
      senderKeypair.publicKey,
    );
    const recipientAta = getAssociatedTokenAddressSync(
      mintPubkey,
      recipientPubkey,
    );
    const recipientAtaInfo = await connection.getAccountInfo(recipientAta);
    if (!recipientAtaInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          senderKeypair.publicKey,
          recipientAta,
          recipientPubkey,
          mintPubkey,
        ),
      );
    }
    instructions.push(
      createTransferInstruction(
        senderAta,
        recipientAta,
        senderKeypair.publicKey,
        adjustedAmount,
      ),
    );
  }

  const latestBlockhash = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: senderKeypair.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions,
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([senderKeypair]);
  const signature = await connection.sendTransaction(transaction, {
    skipPreflight: false,
  });

  return {
    status: "submitted",
    chain: "solana",
    chainId: "solana-mainnet",
    subaction: "transfer",
    dryRun: false,
    mode: params.mode,
    signature,
    from: senderKeypair.publicKey.toBase58(),
    to: params.recipient,
    amount: params.amount,
    fromToken: tokenMint,
  };
}

async function executeSolanaSwap(
  params: WalletRouterParams,
  context: WalletRouterContext,
): Promise<WalletRouterExecution> {
  const connection = getSolanaConnection(context.runtime);
  const inputMint = resolveSolanaMint(params.fromToken);
  const outputMint = resolveSolanaMint(params.toToken);
  const decimals = await getSolanaTokenDecimals(connection, inputMint);
  const adjustedAmount = new BigNumber(params.amount ?? "0")
    .multipliedBy(new BigNumber(10).pow(decimals))
    .integerValue()
    .toFixed(0);

  const quoteParams = new URLSearchParams({
    inputMint,
    outputMint,
    amount: adjustedAmount,
    maxAccounts: "64",
  });
  if (params.slippageBps !== undefined) {
    quoteParams.set("slippageBps", String(params.slippageBps));
  } else {
    quoteParams.set("dynamicSlippage", "true");
  }

  const quoteResponse = await fetch(
    `https://quote-api.jup.ag/v6/quote?${quoteParams.toString()}`,
  );
  const quoteData = (await quoteResponse.json()) as {
    error?: string;
    [key: string]: unknown;
  };
  if (quoteData.error) {
    throw new Error(`Failed to get Jupiter quote: ${quoteData.error}`);
  }

  const { publicKey: walletPublicKey } = await getWalletKey(
    context.runtime,
    false,
  );
  if (!walletPublicKey) {
    throw new Error("Solana public key is not available.");
  }

  const swapResponse = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quoteData,
      userPublicKey: walletPublicKey.toBase58(),
      dynamicComputeUnitLimit: true,
      dynamicSlippage: params.slippageBps === undefined,
      priorityLevelWithMaxLamports: {
        maxLamports: 4_000_000,
        priorityLevel: "veryHigh",
      },
    }),
  });
  const swapData = (await swapResponse.json()) as {
    error?: string;
    swapTransaction?: string;
  };
  if (!swapData.swapTransaction) {
    throw new Error(
      `Failed to build Jupiter swap: ${swapData.error ?? "No swap transaction returned"}`,
    );
  }

  const transaction = VersionedTransaction.deserialize(
    Buffer.from(swapData.swapTransaction, "base64"),
  );
  const { keypair } = await getWalletKey(context.runtime, true);
  if (!keypair) {
    throw new Error("Solana keypair is not available.");
  }
  transaction.sign([keypair]);

  const latestBlockhash = await connection.getLatestBlockhash();
  const signature = await connection.sendTransaction(transaction, {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: "confirmed",
  });

  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    },
    "confirmed",
  );
  if (confirmation.value.err) {
    throw new Error(
      `Transaction failed: ${JSON.stringify(confirmation.value.err)}`,
    );
  }

  return {
    status: "submitted",
    chain: "solana",
    chainId: "solana-mainnet",
    subaction: "swap",
    dryRun: false,
    mode: params.mode,
    signature,
    from: keypair.publicKey.toBase58(),
    amount: params.amount,
    fromToken: inputMint,
    toToken: outputMint,
  };
}

function createSolanaHandler(): WalletChainHandler {
  return {
    chainId: "solana-mainnet",
    chain: "solana",
    name: "Solana",
    aliases: ["solana", "sol", "mainnet-beta", "solana-mainnet"],
    supportedActions: ["transfer", "swap"],
    tokens: [
      {
        symbol: "SOL",
        address: SOL_MINT,
        decimals: 9,
        native: true,
      },
    ],
    signer: {
      required: true,
      kind: "solana",
      source: "WalletBackend Solana signer or SOLANA_PRIVATE_KEY",
      description: "Required only for execute mode.",
    },
    dryRun: {
      supported: true,
      supportedActions: ["transfer", "swap"],
      description:
        "Prepare mode and dry-run return route metadata without signing.",
    },
    async execute(params, context) {
      if (params.subaction === "transfer") {
        return executeSolanaTransfer(params, context);
      }
      if (params.subaction === "swap") {
        return executeSolanaSwap(params, context);
      }
      throw new Error(`Solana does not support ${params.subaction}.`);
    },
  };
}

export function registerDefaultWalletChainHandlers(
  service: WalletBackendService,
  runtime: IAgentRuntime,
): void {
  for (const { key, chain } of configuredEvmChains(runtime)) {
    service.registerChainHandler(createEvmHandler(key, chain));
  }

  const solanaNoActions = parseBoolSetting(
    runtime.getSetting("SOLANA_NO_ACTIONS"),
  );
  if (!solanaNoActions) {
    service.registerChainHandler(createSolanaHandler());
  }
}
