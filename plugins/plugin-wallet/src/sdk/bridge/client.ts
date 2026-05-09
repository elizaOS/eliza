/**
 * @module bridge/client
 * BridgeModule — CCTP V2 cross-chain USDC bridge for AgentWallet (EVM↔EVM).
 *
 * Implements a full EVM-to-EVM USDC bridge using Circle's CCTP V2 protocol.
 * Non-custodial: all signing is done locally via the agent's viem WalletClient.
 *
 * For EVM↔Solana bridging, see bridge/solana.ts.
 *
 * Supported chains: Ethereum, Avalanche, Optimism, Arbitrum, Base, Polygon,
 *                   Unichain, Linea, Sonic, Worldchain.
 *
 * Flow: approve USDC → depositForBurn → poll Circle IRIS → receiveMessage
 */
// BridgeModule — CCTP V2 cross-chain USDC bridge for AgentWallet
// Non-custodial: all signing is done locally via the agent's WalletClient.
import {
  type Chain,
  createPublicClient,
  getContract,
  type Hash,
  type Hex,
  http,
  keccak256,
  type PublicClient,
  pad,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import {
  arbitrum,
  avalanche,
  base,
  linea,
  mainnet,
  optimism,
  polygon,
} from "viem/chains";
import { requireWalletAccount } from "../wallet-core.js";
import {
  ERC20BridgeAbi,
  MessageTransmitterV2Abi,
  TokenMessengerV2Abi,
} from "./abis.js";
import type {
  BridgeChain,
  BridgeOptions,
  BridgeResult,
  BurnResult,
  EVMBridgeChain,
} from "./types.js";
import {
  ATTESTATION_POLL_INTERVAL_MS,
  BRIDGE_CHAIN_IDS,
  CCTP_DOMAIN_IDS,
  CIRCLE_ATTESTATION_API,
  FINALITY_THRESHOLD,
  MAX_ATTESTATION_POLLS,
  MESSAGE_TRANSMITTER_V2,
  TOKEN_MESSENGER_V2,
  USDC_CONTRACT,
} from "./types.js";

/**
 * Viem chain definitions for all supported EVM CCTP V2 chains.
 * Chains without built-in viem definitions use custom definitions.
 * Solana is NOT included — use bridge/solana.ts for EVM↔Solana bridging.
 */
const VIEM_CHAINS: Record<EVMBridgeChain, Chain> = {
  base,
  ethereum: mainnet,
  optimism,
  arbitrum,
  polygon,
  avalanche,
  linea,
  unichain: {
    id: 130,
    name: "Unichain",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://mainnet.unichain.org"] } },
  },
  sonic: {
    id: 146,
    name: "Sonic",
    nativeCurrency: { name: "S", symbol: "S", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.soniclabs.com"] } },
  },
  worldchain: {
    id: 480,
    name: "World Chain",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: { http: ["https://worldchain-mainnet.g.alchemy.com/public"] },
    },
  },
};

export class BridgeModule {
  private readonly walletClient: WalletClient;
  private readonly signerAccount: ReturnType<typeof requireWalletAccount>;
  private readonly publicClient: PublicClient;
  private readonly fromChain: EVMBridgeChain;

  constructor(
    walletClient: WalletClient,
    fromChain: EVMBridgeChain = "base",
    options: { rpcUrl?: string } = {},
  ) {
    this.signerAccount = requireWalletAccount(walletClient);
    this.walletClient = walletClient;
    this.fromChain = fromChain;
    this.publicClient = createPublicClient({
      chain: VIEM_CHAINS[fromChain],
      transport: http(options.rpcUrl),
    }) as PublicClient;
  }

  async bridge(
    amount: bigint,
    toChain: EVMBridgeChain,
    options: BridgeOptions = {},
  ): Promise<BridgeResult> {
    const startMs = Date.now();
    this.validateBridgeParams(amount, toChain);
    const account = this.signerAccount;
    const recipient = options.destinationAddress ?? account.address;
    const minFinalityThreshold =
      options.minFinalityThreshold ?? FINALITY_THRESHOLD.FAST;
    const maxFee = options.maxFee ?? 0n;
    const attestationApiUrl =
      options.attestationApiUrl ?? CIRCLE_ATTESTATION_API;

    await this.approveUsdc(amount);
    const burnResult = await this.depositForBurn(
      amount,
      toChain,
      recipient,
      minFinalityThreshold,
      maxFee,
    );
    const attestation = await this.pollForAttestation(
      burnResult.messageHash,
      this.fromChain,
      attestationApiUrl,
    );
    const mintTxHash = await this.receiveMessage(
      burnResult.messageBytes,
      attestation,
      toChain,
      options.destinationRpcUrl,
    );

    return {
      burnTxHash: burnResult.burnTxHash,
      mintTxHash,
      amount,
      fromChain: this.fromChain,
      toChain,
      recipient,
      nonce: burnResult.nonce,
      elapsedMs: Date.now() - startMs,
    };
  }

  async burn(
    amount: bigint,
    toChain: EVMBridgeChain,
    options: BridgeOptions = {},
  ): Promise<BurnResult> {
    this.validateBridgeParams(amount, toChain);
    const account = this.signerAccount;
    const recipient = options.destinationAddress ?? account.address;
    const minFinalityThreshold =
      options.minFinalityThreshold ?? FINALITY_THRESHOLD.FAST;
    const maxFee = options.maxFee ?? 0n;
    await this.approveUsdc(amount);
    return this.depositForBurn(
      amount,
      toChain,
      recipient,
      minFinalityThreshold,
      maxFee,
    );
  }

  async waitForAttestation(
    messageHash: Hex,
    apiUrl: string = CIRCLE_ATTESTATION_API,
  ): Promise<Hex> {
    return this.pollForAttestation(messageHash, this.fromChain, apiUrl);
  }

  async mint(
    messageBytes: Hex,
    attestation: Hex,
    toChain: EVMBridgeChain,
    destinationRpcUrl?: string,
  ): Promise<Hash> {
    return this.receiveMessage(
      messageBytes,
      attestation,
      toChain,
      destinationRpcUrl,
    );
  }

  async getUsdcBalance(): Promise<bigint> {
    const account = this.signerAccount;
    const usdc = getContract({
      address: USDC_CONTRACT[this.fromChain],
      abi: ERC20BridgeAbi,
      client: this.publicClient,
    });
    return usdc.read.balanceOf([account.address]) as Promise<bigint>;
  }

  async getUsdcAllowance(): Promise<bigint> {
    const account = this.signerAccount;
    const usdc = getContract({
      address: USDC_CONTRACT[this.fromChain],
      abi: ERC20BridgeAbi,
      client: this.publicClient,
    });
    return usdc.read.allowance([
      account.address,
      TOKEN_MESSENGER_V2[this.fromChain],
    ]) as Promise<bigint>;
  }

  private async approveUsdc(amount: bigint): Promise<void> {
    const account = this.signerAccount;
    const spender = TOKEN_MESSENGER_V2[this.fromChain];
    const usdcAddress = USDC_CONTRACT[this.fromChain];
    const usdc = getContract({
      address: usdcAddress,
      abi: ERC20BridgeAbi,
      client: this.publicClient,
    });
    const currentAllowance = (await usdc.read.allowance([
      account.address,
      spender,
    ])) as bigint;
    if (currentAllowance >= amount) return;

    const usdcWrite = getContract({
      address: usdcAddress,
      abi: ERC20BridgeAbi,
      client: { public: this.publicClient, wallet: this.walletClient },
    });
    const approveTxHash = await usdcWrite.write.approve([spender, amount], {
      account,
      chain: VIEM_CHAINS[this.fromChain],
    });
    const approveReceipt = await this.publicClient.waitForTransactionReceipt({
      hash: approveTxHash,
    });
    if (approveReceipt.status !== "success") {
      throw new BridgeError(
        "INSUFFICIENT_ALLOWANCE",
        `USDC approve failed (tx: ${approveTxHash}).`,
      );
    }
  }

  private async depositForBurn(
    amount: bigint,
    toChain: EVMBridgeChain,
    recipient: `0x${string}`,
    minFinalityThreshold: number,
    maxFee: bigint,
  ): Promise<BurnResult> {
    const account = this.signerAccount;
    const destinationDomain = CCTP_DOMAIN_IDS[toChain];
    const messengerAddress = TOKEN_MESSENGER_V2[this.fromChain];
    const usdcAddress = USDC_CONTRACT[this.fromChain];
    const mintRecipient = pad(recipient, { size: 32 });
    const destinationCaller = pad("0x0" as Hex, { size: 32 });

    const messenger = getContract({
      address: messengerAddress,
      abi: TokenMessengerV2Abi,
      client: { public: this.publicClient, wallet: this.walletClient },
    });

    let burnTxHash: Hash;
    try {
      burnTxHash = await messenger.write.depositForBurn(
        [
          amount,
          destinationDomain,
          mintRecipient,
          usdcAddress,
          destinationCaller,
          maxFee,
          minFinalityThreshold,
        ],
        { account, chain: VIEM_CHAINS[this.fromChain] },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BridgeError(
        "BURN_FAILED",
        `CCTP depositForBurn failed: ${msg}.`,
      );
    }

    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: burnTxHash,
    });
    if (receipt.status !== "success") {
      throw new BridgeError(
        "BURN_FAILED",
        `depositForBurn transaction reverted (tx: ${burnTxHash}).`,
      );
    }

    const { messageBytes, messageHash, nonce } =
      this.extractMessageSent(receipt);
    return {
      burnTxHash,
      nonce,
      messageHash,
      messageBytes,
      sourceDomain: CCTP_DOMAIN_IDS[this.fromChain],
      destinationDomain,
    };
  }

  private extractMessageSent(receipt: TransactionReceipt): {
    messageBytes: Hex;
    messageHash: Hex;
    nonce: bigint;
  } {
    const MESSAGE_SENT_TOPIC =
      "0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036";
    for (const log of receipt.logs) {
      if (log.topics[0]?.toLowerCase() === MESSAGE_SENT_TOPIC.toLowerCase()) {
        const rawData = log.data;
        if (rawData.length < 130) continue;
        const dataHex = rawData.slice(2);
        const lengthHex = dataHex.slice(64, 128);
        const messageLength = parseInt(lengthHex, 16);
        if (messageLength === 0) continue;
        const messageBytesHex = dataHex.slice(128, 128 + messageLength * 2);
        const messageBytes = `0x${messageBytesHex}` as Hex;
        const messageHash = keccak256(messageBytes);
        const nonceBytesHex = messageBytesHex.slice(24, 40);
        const nonce = BigInt(`0x${nonceBytesHex}`);
        return { messageBytes, messageHash, nonce };
      }
    }
    throw new BridgeError(
      "BURN_FAILED",
      "Could not find MessageSent event in burn transaction receipt.",
    );
  }

  private async pollForAttestation(
    messageHash: Hex,
    fromChain: EVMBridgeChain,
    apiUrl: string,
  ): Promise<Hex> {
    const sourceDomain = CCTP_DOMAIN_IDS[fromChain];
    const url = `${apiUrl}/v2/messages/${sourceDomain}/${messageHash}`;

    for (let attempt = 0; attempt < MAX_ATTESTATION_POLLS; attempt++) {
      let response: {
        status: string;
        attestation?: Hex | null;
        error?: string;
      };
      try {
        // @duplicate-component-audit-allow Circle attestation polling is not an LLM generation call.
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          if (res.status === 404) {
            await this.sleep(ATTESTATION_POLL_INTERVAL_MS);
            continue;
          }
          const body = await res.text().catch(() => "");
          throw new BridgeError(
            "ATTESTATION_ERROR",
            `Circle API returned HTTP ${res.status}: ${body}.`,
          );
        }
        response = (await res.json()) as typeof response;
      } catch (err: unknown) {
        if (err instanceof BridgeError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new BridgeError(
          "ATTESTATION_ERROR",
          `Failed to reach Circle IRIS API: ${msg}.`,
        );
      }

      if (response.status === "complete" && response.attestation)
        return response.attestation;
      if (response.status === "error") {
        throw new BridgeError(
          "ATTESTATION_ERROR",
          `Circle attestation failed: ${response.error ?? "unknown error"}.`,
        );
      }
      await this.sleep(ATTESTATION_POLL_INTERVAL_MS);
    }
    throw new BridgeError(
      "ATTESTATION_TIMEOUT",
      `Attestation not received after ${MAX_ATTESTATION_POLLS} attempts. Message hash: ${messageHash}.`,
    );
  }

  private async receiveMessage(
    messageBytes: Hex,
    attestation: Hex,
    toChain: EVMBridgeChain,
    destinationRpcUrl?: string,
  ): Promise<Hash> {
    const account = this.signerAccount;
    const transmitterAddress = MESSAGE_TRANSMITTER_V2[toChain];
    const destChain = VIEM_CHAINS[toChain];
    const destPublicClient = createPublicClient({
      chain: destChain,
      transport: http(destinationRpcUrl),
    }) as PublicClient;

    const transmitter = getContract({
      address: transmitterAddress,
      abi: MessageTransmitterV2Abi,
      client: { public: destPublicClient, wallet: this.walletClient },
    });

    let mintTxHash: Hash;
    try {
      mintTxHash = await transmitter.write.receiveMessage(
        [messageBytes, attestation],
        { account, chain: destChain },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BridgeError(
        "MINT_FAILED",
        `CCTP receiveMessage failed on ${toChain}: ${msg}.`,
      );
    }

    const mintReceipt = await destPublicClient.waitForTransactionReceipt({
      hash: mintTxHash,
    });
    if (mintReceipt.status !== "success") {
      throw new BridgeError(
        "MINT_FAILED",
        `receiveMessage reverted on ${toChain} (tx: ${mintTxHash}).`,
      );
    }
    return mintTxHash;
  }

  private validateBridgeParams(amount: bigint, toChain: EVMBridgeChain): void {
    if (amount <= 0n) {
      throw new BridgeError(
        "INVALID_AMOUNT",
        `Bridge amount must be greater than 0. Received: ${amount}.`,
      );
    }
    if (!(toChain in CCTP_DOMAIN_IDS)) {
      throw new BridgeError(
        "UNSUPPORTED_CHAIN",
        `Chain '${toChain}' is not supported.`,
      );
    }
    if (toChain === this.fromChain) {
      throw new BridgeError(
        "UNSUPPORTED_CHAIN",
        `Source and destination chains must be different.`,
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[BridgeModule:${code}] ${message}`);
    this.code = code;
    this.name = "BridgeError";
  }
}

export function createBridge(
  walletClient: WalletClient,
  fromChain: EVMBridgeChain = "base",
  options: { rpcUrl?: string } = {},
): BridgeModule {
  return new BridgeModule(walletClient, fromChain, options);
}

export type {
  BridgeChain,
  BridgeOptions,
  BridgeResult,
  BurnResult,
  EVMBridgeChain,
};
export {
  BRIDGE_CHAIN_IDS,
  CCTP_DOMAIN_IDS,
  FINALITY_THRESHOLD,
  MESSAGE_TRANSMITTER_V2,
  TOKEN_MESSENGER_V2,
  USDC_CONTRACT,
};
