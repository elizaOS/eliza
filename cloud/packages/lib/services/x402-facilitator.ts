/**
 * x402 Facilitator Service
 *
 * Provides x402 payment verification and settlement as an integrated service
 * within the Eliza Cloud Next.js app. Runs serverless — no separate facilitator
 * process required.
 *
 * Uses EIP-3009 (TransferWithAuthorization) for the "exact" scheme to verify
 * ERC-2612/EIP-3009 permit signatures and settle USDC payments on-chain.
 *
 * Architecture:
 *   Client → Eliza Cloud API route → x402FacilitatorService → On-chain settlement
 *
 * The private key for the facilitator signer is loaded from the secrets service
 * (encrypted with KMS) — never stored as a plain environment variable in production.
 */

import { type Chain, createPublicClient, type Hex, http, type PublicClient } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, bsc, bscTestnet, mainnet, sepolia } from "viem/chains";
import { logger } from "@/lib/utils/logger";

// Types

/** Supported network configuration */
interface NetworkConfig {
  chainId: number;
  caip2: string;
  name: string;
  usdcAddress: Hex;
  usdcDomainName: string;
  rpcUrl: string;
  chain: Chain;
}

/** Payment authorization from the X-PAYMENT header */
interface PaymentAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/** Decoded payment payload from the X-PAYMENT header */
interface PaymentPayload {
  x402Version: number;
  accepted: {
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
  };
  payload: {
    signature: string;
    authorization: PaymentAuthorization;
  };
}

/** Payment requirements for verification */
interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

/** Verification result */
export interface VerifyResult {
  isValid: boolean;
  payer?: string;
  invalidReason?: string;
}

/** Settlement result */
export interface SettleResult {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

/** Supported scheme/network pair */
interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
}

/** /supported endpoint response */
export interface SupportedResponse {
  kinds: SupportedKind[];
  signers: Record<string, string[]>;
}

// Network Registry

function buildNetworkRegistry(): Record<string, NetworkConfig> {
  const alchemyKey = process.env.ALCHEMY_API_KEY ?? "";
  const infuraKey = process.env.INFURA_API_KEY ?? "";

  return {
    "eip155:8453": {
      chainId: 8453,
      caip2: "eip155:8453",
      name: "base",
      usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      usdcDomainName: "USDC",
      rpcUrl: alchemyKey
        ? `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`
        : "https://mainnet.base.org",
      chain: base,
    },
    "eip155:84532": {
      chainId: 84532,
      caip2: "eip155:84532",
      name: "base-sepolia",
      usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      usdcDomainName: "USDC",
      rpcUrl: alchemyKey
        ? `https://base-sepolia.g.alchemy.com/v2/${alchemyKey}`
        : "https://sepolia.base.org",
      chain: baseSepolia,
    },
    "eip155:1": {
      chainId: 1,
      caip2: "eip155:1",
      name: "ethereum",
      usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      usdcDomainName: "USD Coin",
      rpcUrl: alchemyKey
        ? `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`
        : infuraKey
          ? `https://mainnet.infura.io/v3/${infuraKey}`
          : "https://cloudflare-eth.com",
      chain: mainnet,
    },
    "eip155:11155111": {
      chainId: 11155111,
      caip2: "eip155:11155111",
      name: "sepolia",
      usdcAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      usdcDomainName: "USDC",
      rpcUrl: alchemyKey
        ? `https://eth-sepolia.g.alchemy.com/v2/${alchemyKey}`
        : infuraKey
          ? `https://sepolia.infura.io/v3/${infuraKey}`
          : "https://rpc.sepolia.org",
      chain: sepolia,
    },
    "eip155:56": {
      chainId: 56,
      caip2: "eip155:56",
      name: "bsc",
      usdcAddress: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // Official Binance-Peg BUSD/USDC (BEP20 USDC)
      usdcDomainName: "USD Coin",
      rpcUrl: "https://bsc-dataseed.binance.org",
      chain: bsc,
    },
    "eip155:97": {
      chainId: 97,
      caip2: "eip155:97",
      name: "bsc-testnet",
      usdcAddress: "0x64544969ed7EBf5f083679233325356EBe738930", // Standard Testnet USDC
      usdcDomainName: "USD Coin",
      rpcUrl: "https://data-seed-prebsc-1-s1.binance.org:8545",
      chain: bscTestnet,
    },
  };
}

// EIP-712 Types for Signature Recovery

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

// Service Implementation

class X402FacilitatorService {
  private account: PrivateKeyAccount | null = null;
  private networks: Record<string, NetworkConfig> = {};
  private clients: Map<string, PublicClient> = new Map();
  private enabledNetworks: string[] = [];
  private initialized = false;

  /**
   * Initialize the facilitator service.
   * Call this once at startup or on first request (lazy init).
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const privateKey = await this.loadFacilitatorKey();
    if (!privateKey) {
      logger.warn("[x402-facilitator] No facilitator private key configured. Service disabled.");
      return;
    }

    try {
      this.account = privateKeyToAccount(privateKey as Hex);
      logger.info(`[x402-facilitator] Signer initialized: ${this.account.address}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[x402-facilitator] Failed to initialize signer: ${msg}`);
      return;
    }

    // Build network registry and RPC clients
    this.networks = buildNetworkRegistry();

    const enabledStr =
      process.env.X402_NETWORKS ?? process.env.EVM_NETWORKS ?? "base-sepolia,base,bsc,bsc-testnet";
    const enabledNames = enabledStr.split(",").map((n) => n.trim());

    for (const [caip2, config] of Object.entries(this.networks)) {
      if (enabledNames.includes(config.name)) {
        this.enabledNetworks.push(caip2);
        this.clients.set(
          caip2,
          createPublicClient({
            chain: config.chain,
            transport: http(config.rpcUrl),
          }),
        );
      }
    }

    logger.info(`[x402-facilitator] Enabled networks: ${this.enabledNetworks.join(", ")}`);
    this.initialized = true;
  }

  /**
   * Check if the service is ready to process payments.
   */
  isReady(): boolean {
    return this.initialized && this.account !== null;
  }

  /**
   * Get the signer address.
   */
  getSignerAddress(): string | null {
    return this.account?.address ?? null;
  }

  /**
   * Return supported schemes, networks, and signer addresses.
   */
  getSupported(): SupportedResponse {
    const kinds: SupportedKind[] = [];
    const signers: Record<string, string[]> = {};

    for (const network of this.enabledNetworks) {
      kinds.push({ x402Version: 2, scheme: "exact", network });

      if (this.account) {
        signers[network] = [this.account.address];
      }
    }

    // Wildcard fallback
    if (this.account) {
      signers["eip155:*"] = [this.account.address];
    }

    return { kinds, signers };
  }

  /**
   * Verify a payment payload against its requirements.
   *
   * Checks:
   * 1. Network is supported
   * 2. Scheme is "exact" (only supported scheme for now)
   * 3. Payment amount matches requirements
   * 4. Signature is valid (recovers to the claimed payer)
   * 5. Deadline has not passed
   * 6. Payer has sufficient USDC balance
   */
  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResult> {
    await this.initialize();

    if (!this.isReady()) {
      return { isValid: false, invalidReason: "facilitator_not_configured" };
    }

    const { accepted, payload } = paymentPayload;
    const { authorization, signature } = payload;

    // 1. Check network
    if (!this.enabledNetworks.includes(accepted.network)) {
      return {
        isValid: false,
        invalidReason: `network_not_supported: ${accepted.network}`,
      };
    }

    // 2. Check scheme
    if (accepted.scheme !== "exact" && accepted.scheme !== "upto") {
      return {
        isValid: false,
        invalidReason: `scheme_not_supported: ${accepted.scheme}`,
      };
    }

    // 3. Validate amount
    if (BigInt(accepted.amount) < BigInt(paymentRequirements.amount)) {
      return {
        isValid: false,
        invalidReason: "insufficient_amount",
        payer: authorization.from,
      };
    }

    // 4. Validate payTo
    if (accepted.payTo.toLowerCase() !== paymentRequirements.payTo.toLowerCase()) {
      return {
        isValid: false,
        invalidReason: "payto_mismatch",
        payer: authorization.from,
      };
    }

    // 5. Validate deadline
    const now = Math.floor(Date.now() / 1000);
    if (BigInt(authorization.validBefore) <= BigInt(now)) {
      return {
        isValid: false,
        invalidReason: "payment_expired",
        payer: authorization.from,
      };
    }

    // 6. Verify signature (recover signer from EIP-712 typed data)
    const networkConfig = this.networks[accepted.network];
    if (!networkConfig) {
      return { isValid: false, invalidReason: "network_config_missing" };
    }

    try {
      const client = this.clients.get(accepted.network);
      if (!client) {
        return { isValid: false, invalidReason: "no_rpc_client" };
      }

      // Scheme-aware signature verification
      let isValidSig: boolean;
      const domain = {
        name: networkConfig.usdcDomainName,
        version: "2",
        chainId: BigInt(networkConfig.chainId),
        verifyingContract: networkConfig.usdcAddress,
      };

      if (accepted.scheme === "upto") {
        // ERC-2612 Permit
        isValidSig = await client.verifyTypedData({
          address: authorization.from as Hex,
          domain,
          types: PERMIT_TYPES,
          primaryType: "Permit",
          message: {
            owner: authorization.from as Hex,
            spender: authorization.to as Hex,
            value: BigInt(authorization.value),
            nonce: BigInt(authorization.nonce),
            deadline: BigInt(authorization.validBefore),
          },
          signature: signature as Hex,
        });
      } else {
        // EIP-3009 TransferWithAuthorization
        isValidSig = await client.verifyTypedData({
          address: authorization.from as Hex,
          domain,
          types: TRANSFER_WITH_AUTHORIZATION_TYPES,
          primaryType: "TransferWithAuthorization",
          message: {
            from: authorization.from as Hex,
            to: authorization.to as Hex,
            value: BigInt(authorization.value),
            validAfter: BigInt(authorization.validAfter ?? "0"),
            validBefore: BigInt(authorization.validBefore),
            nonce: authorization.nonce as Hex,
          },
          signature: signature as Hex,
        });
      }

      if (!isValidSig) {
        return {
          isValid: false,
          invalidReason: "invalid_signature",
          payer: authorization.from,
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[x402-facilitator] Signature verification failed: ${msg}`);
      return {
        isValid: false,
        invalidReason: `signature_verification_error: ${msg}`,
        payer: authorization.from,
      };
    }

    // 7. Check USDC balance (optional but recommended)
    try {
      const client = this.clients.get(accepted.network);
      if (client) {
        const balance = await client.readContract({
          address: networkConfig.usdcAddress,
          abi: [
            {
              inputs: [{ name: "account", type: "address" }],
              name: "balanceOf",
              outputs: [{ name: "", type: "uint256" }],
              stateMutability: "view",
              type: "function",
            },
          ],
          functionName: "balanceOf",
          args: [authorization.from as Hex],
        });

        if ((balance as bigint) < BigInt(accepted.amount)) {
          return {
            isValid: false,
            invalidReason: "insufficient_balance",
            payer: authorization.from,
          };
        }
      }
    } catch (err) {
      // Balance check is non-critical — log and continue
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[x402-facilitator] Balance check failed: ${msg}`);
    }

    return { isValid: true, payer: authorization.from };
  }

  /**
   * Settle a verified payment on-chain.
   *
   * Calls USDC's `transferWithAuthorization()` to execute the payment.
   */
  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResult> {
    await this.initialize();

    if (!this.isReady() || !this.account) {
      return {
        success: false,
        transaction: "",
        network: paymentRequirements.network,
        errorReason: "facilitator_not_configured",
      };
    }

    // Verify first
    const verifyResult = await this.verify(paymentPayload, paymentRequirements);
    if (!verifyResult.isValid) {
      return {
        success: false,
        transaction: "",
        network: paymentRequirements.network,
        payer: verifyResult.payer,
        errorReason: verifyResult.invalidReason,
      };
    }

    const { accepted, payload } = paymentPayload;
    const { authorization, signature } = payload;
    const networkConfig = this.networks[accepted.network];

    if (!networkConfig) {
      return {
        success: false,
        transaction: "",
        network: accepted.network,
        errorReason: "network_config_missing",
      };
    }

    // Execute on-chain settlement — scheme-aware
    try {
      const { createWalletClient } = await import("viem");
      const { http: viemHttp } = await import("viem");

      const walletClient = createWalletClient({
        account: this.account,
        chain: networkConfig.chain,
        transport: viemHttp(networkConfig.rpcUrl),
      });

      // Parse v, r, s from the compact signature
      const sigHex = signature.startsWith("0x") ? signature.slice(2) : signature;
      const r = `0x${sigHex.slice(0, 64)}` as Hex;
      const s = `0x${sigHex.slice(64, 128)}` as Hex;
      const v = parseInt(sigHex.slice(128, 130), 16);

      let txHash: Hex;

      if (accepted.scheme === "upto") {
        // ERC-2612: permit() then transferFrom()
        const permitAbi = [
          {
            inputs: [
              { name: "owner", type: "address" },
              { name: "spender", type: "address" },
              { name: "value", type: "uint256" },
              { name: "deadline", type: "uint256" },
              { name: "v", type: "uint8" },
              { name: "r", type: "bytes32" },
              { name: "s", type: "bytes32" },
            ],
            name: "permit",
            outputs: [],
            stateMutability: "nonpayable",
            type: "function",
          },
        ] as const;
        const transferFromAbi = [
          {
            inputs: [
              { name: "from", type: "address" },
              { name: "to", type: "address" },
              { name: "value", type: "uint256" },
            ],
            name: "transferFrom",
            outputs: [{ name: "", type: "bool" }],
            stateMutability: "nonpayable",
            type: "function",
          },
        ] as const;

        // Step 1: Submit permit
        const permitTx = await walletClient.writeContract({
          address: networkConfig.usdcAddress,
          abi: permitAbi,
          functionName: "permit",
          args: [
            authorization.from as Hex,
            this.account.address,
            BigInt(authorization.value),
            BigInt(authorization.validBefore),
            v,
            r,
            s,
          ],
        });
        logger.info("[x402-facilitator] Permit TX submitted: " + permitTx);

        // Step 2: Transfer
        txHash = await walletClient.writeContract({
          address: networkConfig.usdcAddress,
          abi: transferFromAbi,
          functionName: "transferFrom",
          args: [authorization.from as Hex, authorization.to as Hex, BigInt(authorization.value)],
        });
      } else {
        // EIP-3009: transferWithAuthorization()
        const transferWithAuthorizationAbi = [
          {
            inputs: [
              { name: "from", type: "address" },
              { name: "to", type: "address" },
              { name: "value", type: "uint256" },
              { name: "validAfter", type: "uint256" },
              { name: "validBefore", type: "uint256" },
              { name: "nonce", type: "bytes32" },
              { name: "v", type: "uint8" },
              { name: "r", type: "bytes32" },
              { name: "s", type: "bytes32" },
            ],
            name: "transferWithAuthorization",
            outputs: [],
            stateMutability: "nonpayable",
            type: "function",
          },
        ] as const;

        txHash = await walletClient.writeContract({
          address: networkConfig.usdcAddress,
          abi: transferWithAuthorizationAbi,
          functionName: "transferWithAuthorization",
          args: [
            authorization.from as Hex,
            authorization.to as Hex,
            BigInt(authorization.value),
            BigInt(authorization.validAfter ?? "0"),
            BigInt(authorization.validBefore),
            authorization.nonce as Hex,
            v,
            r,
            s,
          ],
        });
      }

      logger.info("[x402-facilitator] Settlement TX submitted", {
        txHash,
        payer: authorization.from,
        payTo: authorization.to,
        amount: authorization.value,
        network: accepted.network,
      });

      return {
        success: true,
        transaction: txHash,
        network: accepted.network,
        payer: authorization.from,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[x402-facilitator] Settlement TX failed: ${msg}`);

      // Determine error reason
      let errorReason = "transaction_failed";
      if (msg.includes("insufficient")) {
        errorReason = "insufficient_gas";
      } else if (msg.includes("nonce") || msg.includes("already used")) {
        errorReason = "nonce_already_used";
      } else if (msg.includes("expired") || msg.includes("deadline")) {
        errorReason = "authorization_expired";
      }

      return {
        success: false,
        transaction: "",
        network: accepted.network,
        payer: authorization.from,
        errorReason,
      };
    }
  }

  // Private helpers

  /**
   * Load the facilitator private key from available sources (priority order):
   * 1. Secrets service (encrypted, KMS-backed)
   * 2. Environment variable (development fallback)
   */
  private async loadFacilitatorKey(): Promise<string | null> {
    // Try secrets service first (production)
    try {
      const { secretsService } = await import("@/lib/services/secrets");
      if (secretsService) {
        // Try org-level facilitator key
        const key = await secretsService.get("system", "FACILITATOR_PRIVATE_KEY").catch(() => null);
        if (key) {
          logger.info("[x402-facilitator] Loaded key from secrets service (encrypted)");
          return key;
        }
      }
    } catch {
      // Secrets service not available, fall through
    }

    // Fallback to environment variable (development)
    const envKey = process.env.FACILITATOR_PRIVATE_KEY ?? process.env.X402_FACILITATOR_PRIVATE_KEY;

    if (envKey) {
      if (process.env.NODE_ENV === "production") {
        logger.warn(
          "[x402-facilitator] Using env var for private key in production. " +
            "Consider using the secrets service for better security.",
        );
      }
      return envKey;
    }

    return null;
  }
}

// Singleton export

export const x402FacilitatorService = new X402FacilitatorService();
