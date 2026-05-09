import type { ITokenDataService } from "@elizaos/core";
import {
  type Address,
  type Chain,
  encodeFunctionData,
  parseAbi,
  parseEther,
  parseUnits,
} from "viem";
import { buildSendTxParams } from "./actions/helpers";
import { SwapAction } from "./actions/swap";
import { TransferAction } from "./actions/transfer";
import { NATIVE_TOKEN_ADDRESS } from "./constants";
import { routeEvmGovernance } from "./gov-router";
import { initWalletProvider, type WalletProvider } from "./providers/wallet";
import type {
  WalletChainHandler,
  WalletRouterContext,
  WalletRouterExecution,
  WalletRouterParams,
} from "../../types/wallet-router.js";
import type { SupportedChain, Transaction } from "./types";

export type EvmWalletSubaction = "transfer" | "swap" | "gov";
export type EvmWalletMode = "prepare" | "execute";

export interface EvmWalletChainHandlerOptions {
  readonly walletProvider?: WalletProvider;
}

export interface EvmPreparedResult extends WalletRouterExecution {
  readonly status: "prepared";
}

export interface EvmExecutedTransaction extends WalletRouterExecution {
  readonly status: "submitted";
}

export type EvmRouterResult = EvmPreparedResult | EvmExecutedTransaction;

function isEvmAddress(value: string): value is Address {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
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
  chain: string
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
  context: WalletRouterContext
): Promise<Address> {
  if (isNativeEvmToken(token, chain)) {
    return NATIVE_TOKEN_ADDRESS;
  }
  if (token && isEvmAddress(token)) {
    return token;
  }
  if (token) {
    const resolved = await resolveTokenViaService(context.tokenDataService, token, chainKey);
    if (resolved && isEvmAddress(resolved)) {
      return resolved;
    }
  }
  throw new Error(
    `Token "${token ?? "native"}" must be an EVM address or a resolvable ${chain.name} token symbol.`
  );
}

function transactionToExecution(
  tx: Transaction,
  params: WalletRouterParams,
  chainKey: string,
  chain: Chain
): EvmExecutedTransaction {
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

function requireAmount(params: WalletRouterParams): string {
  if (!params.amount) {
    throw new Error("amount is required.");
  }
  return params.amount;
}

function requireRecipient(params: WalletRouterParams): Address {
  if (!params.recipient || !isEvmAddress(params.recipient)) {
    throw new Error("recipient must be a valid EVM address.");
  }
  return params.recipient;
}

export class EvmWalletChainHandler implements WalletChainHandler {
  readonly chainId: string;
  readonly chain: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly supportedActions = ["transfer", "swap", "gov"] as const;
  readonly tokens: WalletChainHandler["tokens"];
  readonly signer: WalletChainHandler["signer"];
  readonly dryRun: WalletChainHandler["dryRun"];

  constructor(
    private readonly chainKey: SupportedChain,
    private readonly chainConfig: Chain,
    private readonly options: EvmWalletChainHandlerOptions = {}
  ) {
    this.chainId = String(chainConfig.id);
    this.chain = chainKey;
    this.name = chainConfig.name;
    this.aliases = evmAliases(chainKey, chainConfig);
    this.tokens = [
      {
        symbol: chainConfig.nativeCurrency.symbol,
        address: NATIVE_TOKEN_ADDRESS,
        decimals: chainConfig.nativeCurrency.decimals,
        native: true,
      },
    ];
    this.signer = {
      required: true,
      kind: "evm",
      source: "WalletBackend EVM signer or EVM_PRIVATE_KEY",
      description: "Required only for execute mode.",
    };
    this.dryRun = {
      supported: true,
      supportedActions: ["transfer", "swap", "gov"],
      description: "Prepare mode and dry-run return route metadata without signing.",
    };
  }

  async execute(
    params: WalletRouterParams,
    context: WalletRouterContext
  ): Promise<EvmRouterResult> {
    if (params.mode === "prepare" || params.dryRun) {
      if (params.subaction === "transfer") {
        return this.prepareTransfer(params);
      }
      if (params.subaction === "swap") {
        return this.prepareSwap(params);
      }
      return routeEvmGovernance(
        params,
        context,
        this.chain,
        this.chainConfig
      ) as Promise<EvmRouterResult>;
    }
    if (params.subaction === "transfer") {
      return this.executeTransfer(params, context);
    }
    if (params.subaction === "swap") {
      return this.executeSwap(params, context);
    }
    return routeEvmGovernance(
      params,
      context,
      this.chain,
      this.chainConfig,
      await this.getWalletProvider(context)
    ) as Promise<EvmRouterResult>;
  }

  prepareTransfer(params: WalletRouterParams): EvmPreparedResult {
    const recipient = requireRecipient(params);
    const amount = requireAmount(params);
    const token = params.fromToken ?? this.chainConfig.nativeCurrency.symbol;

    return {
      status: "prepared",
      chain: this.chain,
      chainId: this.chainId,
      subaction: "transfer",
      dryRun: params.dryRun,
      mode: params.mode,
      to: recipient,
      amount,
      fromToken: token,
      metadata: {
        requiresConfirmation: true,
        transactionRequest:
          isNativeEvmToken(params.fromToken, this.chainConfig)
            ? {
                to: recipient,
                value: parseEther(amount).toString(),
                data: "0x",
                chainId: this.chainConfig.id,
              }
            : undefined,
        signer: this.signer,
      },
    };
  }

  prepareSwap(params: WalletRouterParams): EvmPreparedResult {
    const amount = requireAmount(params);
    if (!params.fromToken) {
      throw new Error("fromToken is required for swap.");
    }
    if (!params.toToken) {
      throw new Error("toToken is required for swap.");
    }

    return {
      status: "prepared",
      chain: this.chain,
      chainId: this.chainId,
      subaction: "swap",
      dryRun: params.dryRun,
      mode: params.mode,
      amount,
      fromToken: params.fromToken,
      toToken: params.toToken,
      metadata: {
        requiresConfirmation: true,
        slippageBps: params.slippageBps,
        signer: this.signer,
      },
    };
  }

  async executeTransfer(
    params: WalletRouterParams,
    context: WalletRouterContext
  ): Promise<EvmExecutedTransaction> {
    const recipient = requireRecipient(params);
    const amount = requireAmount(params);
    const walletProvider = await this.getWalletProvider(context);
    const token = await resolveEvmTokenAddress(
      params.fromToken,
      this.chain,
      this.chainConfig,
      context
    );

    if (token === NATIVE_TOKEN_ADDRESS) {
      const tx = await new TransferAction(walletProvider).transfer({
        fromChain: this.chainKey,
        toAddress: recipient,
        amount,
        token: params.fromToken,
      });
      return transactionToExecution(tx, params, this.chain, this.chainConfig);
    }

    const walletClient = walletProvider.getWalletClient(this.chainKey);
    const account = walletClient.account;
    if (!account) {
      throw new Error("Wallet account is not available.");
    }

    const publicClient = walletProvider.getPublicClient(this.chainKey);
    const decimalsAbi = parseAbi(["function decimals() view returns (uint8)"]);
    const decimals = Number(
      await publicClient.readContract({
        address: token,
        abi: decimalsAbi,
        functionName: "decimals",
        authorizationList: undefined,
      })
    );
    const transferAbi = parseAbi(["function transfer(address,uint256) returns (bool)"]);
    const data = encodeFunctionData({
      abi: transferAbi,
      functionName: "transfer",
      args: [recipient, parseUnits(amount, decimals)],
    });

    const hash = await walletClient.sendTransaction(
      buildSendTxParams({
        account,
        to: token,
        value: 0n,
        data,
        chain: this.chainConfig,
      })
    );

    return {
      status: "submitted",
      chain: this.chain,
      chainId: this.chainId,
      subaction: "transfer",
      dryRun: false,
      mode: params.mode,
      transactionHash: hash,
      from: account.address,
      to: recipient,
      amount,
      fromToken: token,
      metadata: {
        token,
        decimals,
        value: "0",
        data,
      },
    };
  }

  async executeSwap(
    params: WalletRouterParams,
    context: WalletRouterContext
  ): Promise<EvmExecutedTransaction> {
    const amount = requireAmount(params);
    const walletProvider = await this.getWalletProvider(context);
    const fromToken = await resolveEvmTokenAddress(
      params.fromToken,
      this.chain,
      this.chainConfig,
      context
    );
    const toToken = await resolveEvmTokenAddress(
      params.toToken,
      this.chain,
      this.chainConfig,
      context
    );

    const tx = await new SwapAction(walletProvider).swap({
      chain: this.chainKey,
      fromToken,
      toToken,
      amount,
    });
    return transactionToExecution(
      {
        ...tx,
        chainId: tx.chainId ?? this.chainConfig.id,
      },
      {
        ...params,
        fromToken,
        toToken,
      },
      this.chain,
      this.chainConfig
    );
  }

  private async getWalletProvider(context: WalletRouterContext): Promise<WalletProvider> {
    if (this.options.walletProvider) {
      return this.options.walletProvider;
    }
    return initWalletProvider(context.runtime);
  }
}

export function createEvmWalletChainHandler(
  chainKey: string,
  chain: Chain,
  options?: EvmWalletChainHandlerOptions
): EvmWalletChainHandler {
  return new EvmWalletChainHandler(chainKey as SupportedChain, chain, options);
}
