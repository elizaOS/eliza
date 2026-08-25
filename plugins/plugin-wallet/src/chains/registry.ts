/**
 * `registerDefaultWalletChainHandlers` builds and registers the default
 * `WalletChainHandler`s on the `WalletBackendService`: one EVM handler per
 * configured chain (transfer/swap/bridge, delegating swap to `SwapAction`
 * and bridge to `routeEvmBridge`), a Solana handler (native SOL transfer
 * plus SPL transfer/swap via Jupiter, built by hand rather than through a
 * shared SDK), and a pump.fun handler that requests a serialized buy
 * transaction from PumpPortal's trade-local API, signs it through the
 * resolved wallet backend or local keypair, and submits it directly to
 * Solana RPC. All execute paths assume the caller has already passed the
 * financial-confirmation gate upstream.
 *
 * The Solana swap and pump.fun handlers also implement `simulate` (GH
 * #16613): `fetchJupiterSwapTransaction`/`fetchPumpFunTransaction` build the
 * exact same real, unsigned transaction the execute path signs and sends,
 * shared by both paths so simulate can never silently drift from what
 * execute actually submits. `simulate` runs that unsigned transaction
 * through `connection.simulateTransaction({ sigVerify: false,
 * replaceRecentBlockhash: true })` via `simulateVersionedTransaction` and
 * returns the typed result — it never resolves a signing keypair, never
 * calls a `WalletBackend` signer, and never calls `sendTransaction`/
 * `sendRawTransaction`/`confirmTransaction`.
 */
import {
  ElizaError,
  type IAgentRuntime,
  type ITokenDataService,
  truncateWellFormed,
} from "@elizaos/core";
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
  WalletRouterSimulation,
} from "../types/wallet-router.js";
import type { SolanaSigner } from "../wallet/backend.js";
import { buildSendTxParams } from "./evm/actions/helpers";
import { SwapAction } from "./evm/actions/swap";
import { TransferAction } from "./evm/actions/transfer";
import { routeEvmBridge } from "./evm/bridge-router";
import { DEFAULT_CHAINS, NATIVE_TOKEN_ADDRESS } from "./evm/constants";
import { initWalletProvider } from "./evm/providers/wallet";
import type { SupportedChain, Transaction } from "./evm/types";
import BigNumber from "./solana/bn";
import { SOLANA_SERVICE_NAME } from "./solana/constants";
import {
  fetchJupiterJson,
  resolveJupiterApiBaseUrl,
} from "./solana/jupiter-api";
import {
  getExistingSolanaPublicKey,
  getWalletKey,
} from "./solana/keypairUtils";
import type { SolanaService } from "./solana/service";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOLANA_DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const PUMPFUN_TRADE_LOCAL_URL = "https://pumpportal.fun/api/trade-local";
const PUMPFUN_DEFAULT_PRIORITY_FEE_SOL = 0.00005;
const PUMPFUN_DEFAULT_SLIPPAGE_BPS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
  const settings = runtime.character.settings;
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
    slippageBps: params.slippageBps,
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

/**
 * Runs a real, unsigned transaction through `connection.simulateTransaction`
 * with `sigVerify: false` (no signature required) and
 * `replaceRecentBlockhash: true` (the blockhash baked into the transaction
 * need not still be valid). An RPC-reported revert is a *successful*
 * simulation with `success: false` and populated `err`/`logs` — this
 * function never throws for that case, only for a transport failure calling
 * the RPC itself, matching the execute paths' error style.
 */
async function simulateVersionedTransaction(
  connection: Connection,
  transaction: VersionedTransaction,
): Promise<
  Omit<
    WalletRouterSimulation,
    "summary" | "route" | "requestedSlippageBps" | "effectiveSlippageBps"
  >
> {
  const { value } = await connection.simulateTransaction(transaction, {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  const err = value.err ?? null;
  return {
    success: err === null,
    err:
      err === null ? null : typeof err === "string" ? err : JSON.stringify(err),
    logs: value.logs ?? [],
    unitsConsumed: value.unitsConsumed ?? null,
  };
}

type BrowserAutomationService = {
  execute: (
    command: Record<string, unknown>,
    targetId?: string,
  ) => Promise<unknown>;
};

function isBrowserAutomationService(
  value: unknown,
): value is BrowserAutomationService {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { execute?: unknown }).execute === "function"
  );
}

function isSolanaMintAddress(value: string): boolean {
  try {
    const pubkey = new PublicKey(value);
    return pubkey.toBase58() === value;
  } catch {
    return false;
  }
}

async function openPumpFunCoinPage(
  runtime: IAgentRuntime,
  mint: string,
): Promise<{ opened: boolean; result?: unknown; error?: string }> {
  const browser = runtime.getService("browser");
  if (!isBrowserAutomationService(browser)) {
    return { opened: false, error: "browser service is not available" };
  }
  const url = `https://pump.fun/coin/${encodeURIComponent(mint)}`;
  try {
    const result = await browser.execute({
      subaction: "navigate",
      url,
      show: true,
    });
    return { opened: true, result };
  } catch (error) {
    return {
      opened: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function getNumberSetting(
  runtime: IAgentRuntime,
  key: string,
  fallback: number,
): number {
  const raw = getRuntimeSetting(runtime, key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function pumpPortalResponseBytes(response: Response): Promise<Buffer> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = (await response.json()) as {
      error?: unknown;
      errors?: unknown;
      message?: unknown;
    };
    throw new Error(
      `PumpPortal trade-local failed: ${String(json.error ?? json.errors ?? json.message ?? "unexpected JSON response")}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

async function resolvePumpFunSigner(context: WalletRouterContext): Promise<{
  readonly publicKey: PublicKey;
  signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>;
}> {
  if (context.walletBackend) {
    if (!context.walletBackend.canSign("solana")) {
      throw new Error(
        "Solana signing is not available in this wallet backend.",
      );
    }
    const signer: SolanaSigner = context.walletBackend.getSolanaSigner();
    return {
      publicKey: signer.publicKey,
      signTransaction: async (tx) => {
        const signed = await signer.signTransaction(tx);
        if (!(signed instanceof VersionedTransaction)) {
          throw new Error("PumpPortal returned a versioned transaction.");
        }
        return signed;
      },
    };
  }

  const { keypair } = await getWalletKey(context.runtime, true);
  if (!keypair) {
    throw new Error("Solana keypair is not available.");
  }
  return {
    publicKey: keypair.publicKey,
    signTransaction: async (tx) => {
      const copy = VersionedTransaction.deserialize(tx.serialize());
      copy.sign([keypair]);
      return copy;
    },
  };
}

/**
 * Public-key-only resolution for `simulate` (GH #16613): building an
 * unsigned transaction needs only `publicKey`, so this never requires
 * private key material and never touches a `WalletBackend` signer.
 * `getAddresses().solana` (unlike `getSolanaSigner()`) is populated for
 * backends that can hold a Solana address without being able to sign for it
 * yet (e.g. Steward today), so simulate can work even where execute cannot.
 * Unlike the execute paths' `getWalletKey`, a missing wallet is a typed
 * failure here — a read-only simulation must never generate and persist a
 * keypair as a side effect of a lookup (#19243 review, P2).
 */
function resolveSimulationPublicKey(context: WalletRouterContext): PublicKey {
  const backendPublicKey = context.walletBackend?.getAddresses().solana;
  if (backendPublicKey) {
    return backendPublicKey;
  }
  const existing = getExistingSolanaPublicKey(context.runtime);
  if (!existing) {
    throw new Error(
      "No Solana wallet key is configured; simulation requires an existing public key and will not create one.",
    );
  }
  return existing;
}

function validatePumpFunBuyParams(params: WalletRouterParams): {
  readonly mint: string;
  readonly amountSol: number;
} {
  const mint = params.toToken?.trim();
  if (!mint || !isSolanaMintAddress(mint)) {
    throw new Error("toToken must be a valid pump.fun token mint address.");
  }
  const amountSol = Number(params.amount);
  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    throw new Error("amount must be a positive SOL amount.");
  }
  return { mint, amountSol };
}

interface PumpFunTradeLocalSettings {
  readonly tradeLocalUrl: string;
  readonly priorityFee: number;
  readonly pool: string;
  readonly slippage: number;
}

function resolvePumpFunTradeLocalSettings(
  runtime: IAgentRuntime,
  params: WalletRouterParams,
): PumpFunTradeLocalSettings {
  return {
    tradeLocalUrl:
      getRuntimeSetting(runtime, "PUMPFUN_TRADE_LOCAL_URL") ??
      PUMPFUN_TRADE_LOCAL_URL,
    priorityFee: getNumberSetting(
      runtime,
      "PUMPFUN_PRIORITY_FEE_SOL",
      PUMPFUN_DEFAULT_PRIORITY_FEE_SOL,
    ),
    pool: getRuntimeSetting(runtime, "PUMPFUN_POOL") ?? "auto",
    slippage: (params.slippageBps ?? PUMPFUN_DEFAULT_SLIPPAGE_BPS) / 100,
  };
}

/**
 * Requests the PumpPortal trade-local transaction. Shared by `execute` and
 * `simulate` so both build the exact same unsigned transaction from the same
 * inputs — simulate never sees a different route than execute would submit.
 */
export async function fetchPumpFunTransaction(
  publicKey: PublicKey,
  mint: string,
  amountSol: number,
  settings: PumpFunTradeLocalSettings,
): Promise<VersionedTransaction> {
  const response = await fetch(settings.tradeLocalUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey: publicKey.toBase58(),
      action: "buy",
      mint,
      amount: amountSol,
      denominatedInSol: "true",
      slippage: settings.slippage,
      priorityFee: settings.priorityFee,
      pool: settings.pool,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const truncatedDetail = truncateWellFormed(detail, 240);
    throw new Error(
      `PumpPortal trade-local failed (${response.status})${truncatedDetail ? `: ${truncatedDetail}` : ""}`,
    );
  }

  return VersionedTransaction.deserialize(
    await pumpPortalResponseBytes(response),
  );
}

async function executePumpFunBuy(
  params: WalletRouterParams,
  context: WalletRouterContext,
): Promise<WalletRouterExecution> {
  const { mint, amountSol } = validatePumpFunBuyParams(params);
  const signer = await resolvePumpFunSigner(context);
  const browser = await openPumpFunCoinPage(context.runtime, mint);
  const settings = resolvePumpFunTradeLocalSettings(context.runtime, params);

  const transaction = await fetchPumpFunTransaction(
    signer.publicKey,
    mint,
    amountSol,
    settings,
  );
  const signedTransaction = await signer.signTransaction(transaction);

  const connection = getSolanaConnection(context.runtime);
  const signature = await connection.sendTransaction(signedTransaction, {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: "confirmed",
  });

  const latestBlockhash = await connection.getLatestBlockhash();
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
      `Pump.fun buy failed: ${JSON.stringify(confirmation.value.err)}`,
    );
  }

  return {
    status: "submitted",
    chain: "pumpfun",
    chainId: "pump.fun-solana",
    subaction: "pump_fun_buy",
    dryRun: false,
    mode: params.mode,
    signature,
    from: signer.publicKey.toBase58(),
    amount: params.amount,
    fromToken: "SOL",
    toToken: mint,
    metadata: {
      pumpFunUrl: `https://pump.fun/coin/${mint}`,
      browser,
      tradeLocalUrl: settings.tradeLocalUrl,
      denominatedInSol: true,
      slippage: settings.slippage,
      priorityFee: settings.priorityFee,
      pool: settings.pool,
    },
  };
}

/**
 * Non-broadcasting pump.fun buy simulation (GH #16613). Builds the same
 * unsigned PumpPortal transaction `executePumpFunBuy` would sign and send,
 * then runs it through `connection.simulateTransaction`. Never opens the
 * browser coin page (a UX side effect with no bearing on whether the trade
 * would succeed) and never resolves a signing keypair or `WalletBackend`
 * signer — only the public key.
 */
export async function simulatePumpFunBuy(
  params: WalletRouterParams,
  context: WalletRouterContext,
): Promise<WalletRouterExecution> {
  const { mint, amountSol } = validatePumpFunBuyParams(params);
  const publicKey = resolveSimulationPublicKey(context);
  const settings = resolvePumpFunTradeLocalSettings(context.runtime, params);

  const transaction = await fetchPumpFunTransaction(
    publicKey,
    mint,
    amountSol,
    settings,
  );
  const connection = getSolanaConnection(context.runtime);
  const simulation = await simulateVersionedTransaction(
    connection,
    transaction,
  );

  return {
    status: "simulated",
    chain: "pumpfun",
    chainId: "pump.fun-solana",
    subaction: "pump_fun_buy",
    dryRun: params.dryRun,
    mode: params.mode,
    from: publicKey.toBase58(),
    amount: params.amount,
    fromToken: "SOL",
    toToken: mint,
    simulation: {
      ...simulation,
      // pump.fun's bonding curve is a single fixed venue — no route legs.
      route: [],
      requestedSlippageBps: params.slippageBps ?? PUMPFUN_DEFAULT_SLIPPAGE_BPS,
      // trade-local applies exactly the slippage we send it.
      effectiveSlippageBps: params.slippageBps ?? PUMPFUN_DEFAULT_SLIPPAGE_BPS,
      summary: {
        mint,
        solAmount: amountSol,
      },
    },
  };
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

interface JupiterSwapBuild {
  readonly transaction: VersionedTransaction;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly route: WalletRouterSimulation["route"];
  readonly effectiveSlippageBps: number | null;
  readonly quoteSummary: Readonly<Record<string, string | number | null>>;
}

/**
 * Requests the Jupiter quote and the built swap transaction for it. Shared
 * by `execute` and `simulate` so both build the exact same unsigned
 * transaction from the exact same quote — simulate never sees a different
 * route than execute would submit.
 */
async function fetchJupiterSwapTransaction(
  params: WalletRouterParams,
  context: WalletRouterContext,
  connection: Connection,
  userPublicKey: PublicKey,
): Promise<JupiterSwapBuild> {
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

  const jupiterApiBaseUrl = resolveJupiterApiBaseUrl(context.runtime);
  const fetchFn = context.runtime.fetch || globalThis.fetch;
  const quoteData = await fetchJupiterJson(
    fetchFn,
    `${jupiterApiBaseUrl}/quote?${quoteParams.toString()}`,
    "quote",
  );
  if (typeof quoteData.error === "string") {
    throw new ElizaError(`Jupiter rejected the quote: ${quoteData.error}`, {
      code: "JUPITER_QUOTE_REJECTED",
      context: { error: quoteData.error },
      severity: "fatal",
    });
  }

  const swapData = await fetchJupiterJson(
    fetchFn,
    `${jupiterApiBaseUrl}/swap`,
    "swap",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quoteData,
        userPublicKey: userPublicKey.toBase58(),
        dynamicComputeUnitLimit: true,
        dynamicSlippage: params.slippageBps === undefined,
        priorityLevelWithMaxLamports: {
          maxLamports: 4_000_000,
          priorityLevel: "veryHigh",
        },
      }),
    },
  );
  if (typeof swapData.swapTransaction !== "string") {
    throw new ElizaError("Jupiter did not return a swap transaction", {
      code: "JUPITER_SWAP_INVALID_RESPONSE",
      context: {
        error: typeof swapData.error === "string" ? swapData.error : undefined,
      },
      severity: "fatal",
    });
  }

  const transaction = VersionedTransaction.deserialize(
    Buffer.from(swapData.swapTransaction, "base64"),
  );
  const dynamicSlippage = params.slippageBps === undefined;
  const dynamicSlippageReport = swapData.dynamicSlippageReport;
  const reportedSlippageBps = isRecord(dynamicSlippageReport)
    ? dynamicSlippageReport.slippageBps
    : undefined;
  const effectiveSlippageBps = dynamicSlippage
    ? reportedSlippageBps
    : quoteData.slippageBps;
  if (
    dynamicSlippage &&
    (typeof effectiveSlippageBps !== "number" ||
      !Number.isInteger(effectiveSlippageBps) ||
      effectiveSlippageBps < 0 ||
      effectiveSlippageBps > 10_000)
  ) {
    throw new Error(
      "Jupiter dynamic slippage report is missing a valid slippageBps value",
    );
  }
  const route = Array.isArray(quoteData.routePlan)
    ? quoteData.routePlan.flatMap((rawLeg) => {
        if (!isRecord(rawLeg)) {
          return [];
        }
        const swapInfo = isRecord(rawLeg.swapInfo) ? rawLeg.swapInfo : {};
        return [
          {
            label: typeof swapInfo.label === "string" ? swapInfo.label : null,
            inputMint:
              typeof swapInfo.inputMint === "string"
                ? swapInfo.inputMint
                : inputMint,
            outputMint:
              typeof swapInfo.outputMint === "string"
                ? swapInfo.outputMint
                : outputMint,
            percent: typeof rawLeg.percent === "number" ? rawLeg.percent : null,
          },
        ];
      })
    : [];

  return {
    transaction,
    inputMint,
    outputMint,
    route,
    effectiveSlippageBps:
      typeof effectiveSlippageBps === "number" ? effectiveSlippageBps : null,
    quoteSummary: {
      inToken: inputMint,
      outToken: outputMint,
      inAmount:
        typeof quoteData.inAmount === "string"
          ? quoteData.inAmount
          : adjustedAmount,
      outAmount:
        typeof quoteData.outAmount === "string" ? quoteData.outAmount : null,
      priceImpactPct:
        typeof quoteData.priceImpactPct === "string"
          ? quoteData.priceImpactPct
          : null,
    },
  };
}

async function executeSolanaSwap(
  params: WalletRouterParams,
  context: WalletRouterContext,
): Promise<WalletRouterExecution> {
  const connection = getSolanaConnection(context.runtime);
  // Execute keeps getWalletKey's auto-provisioning lookup (pre-existing
  // behavior); only the read-only simulate path forbids key creation.
  const { publicKey: walletPublicKey } = await getWalletKey(
    context.runtime,
    false,
  );
  if (!walletPublicKey) {
    throw new Error("Solana public key is not available.");
  }
  const { transaction, inputMint, outputMint } =
    await fetchJupiterSwapTransaction(
      params,
      context,
      connection,
      walletPublicKey,
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

/**
 * Non-broadcasting Solana swap simulation (GH #16613). Builds the exact same
 * unsigned Jupiter swap transaction `executeSolanaSwap` would sign and send
 * (same quote, same userPublicKey, same swap-tx build) and runs it through
 * `connection.simulateTransaction` instead of signing it. Never resolves a
 * signing keypair — only the public key `fetchJupiterSwapTransaction` needs
 * for `userPublicKey`.
 */
export async function simulateSolanaSwap(
  params: WalletRouterParams,
  context: WalletRouterContext,
): Promise<WalletRouterExecution> {
  const connection = getSolanaConnection(context.runtime);
  const userPublicKey = resolveSimulationPublicKey(context);
  const {
    transaction,
    inputMint,
    outputMint,
    route,
    effectiveSlippageBps,
    quoteSummary,
  } = await fetchJupiterSwapTransaction(
    params,
    context,
    connection,
    userPublicKey,
  );

  const simulation = await simulateVersionedTransaction(
    connection,
    transaction,
  );

  return {
    status: "simulated",
    chain: "solana",
    chainId: "solana-mainnet",
    subaction: "swap",
    dryRun: params.dryRun,
    mode: params.mode,
    amount: params.amount,
    fromToken: inputMint,
    toToken: outputMint,
    simulation: {
      ...simulation,
      route,
      requestedSlippageBps: params.slippageBps ?? null,
      effectiveSlippageBps,
      summary: quoteSummary,
    },
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
    simulation: {
      supported: true,
      supportedActions: ["swap"],
      description:
        "Builds the real unsigned Jupiter swap transaction and runs connection.simulateTransaction against it — no signing, no broadcast.",
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
    async simulate(params, context) {
      if (params.subaction === "swap") {
        return simulateSolanaSwap(params, context);
      }
      throw new Error(
        `Solana does not support simulate for ${params.subaction}.`,
      );
    },
  };
}

function createPumpFunHandler(): WalletChainHandler {
  return {
    chainId: "pump.fun-solana",
    chain: "pumpfun",
    name: "pump.fun",
    aliases: ["pumpfun", "pump.fun", "pump-fun", "pump"],
    supportedActions: ["pump_fun_buy"],
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
      description:
        "Required for locally signing the PumpPortal trade-local transaction after owner confirmation.",
    },
    dryRun: {
      supported: true,
      supportedActions: ["pump_fun_buy"],
      description:
        "Dry-run/prepare returns pump.fun handler metadata without signing.",
    },
    simulation: {
      supported: true,
      supportedActions: ["pump_fun_buy"],
      description:
        "Builds the real unsigned PumpPortal trade-local transaction and runs connection.simulateTransaction against it — no signing, no broadcast.",
    },
    async execute(params, context) {
      if (params.subaction === "pump_fun_buy") {
        return executePumpFunBuy(params, context);
      }
      throw new Error(`pump.fun does not support ${params.subaction}.`);
    },
    async simulate(params, context) {
      if (params.subaction === "pump_fun_buy") {
        return simulatePumpFunBuy(params, context);
      }
      throw new Error(
        `pump.fun does not support simulate for ${params.subaction}.`,
      );
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
    service.registerChainHandler(createPumpFunHandler());
  }
}
