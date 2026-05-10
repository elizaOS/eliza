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

import { createKeyPairSignerFromBytes } from "@solana/kit";
import {
  createRpcClient,
  type FacilitatorRpcConfig,
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  SOLANA_TESTNET_CAIP2,
  toFacilitatorSvmSigner,
  USDC_DEVNET_ADDRESS,
  USDC_MAINNET_ADDRESS,
  USDC_TESTNET_ADDRESS,
} from "@x402/svm";
import { ExactSvmScheme as ExactSvmFacilitator } from "@x402/svm/exact/facilitator";
import bs58 from "bs58";
import { type Chain, createPublicClient, type Hex, http, type PublicClient } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, bsc, bscTestnet, mainnet, sepolia } from "viem/chains";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
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

interface SolanaNetworkConfig {
  caip2: string;
  name: string;
  aliases: string[];
  usdcAddress: string;
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

interface PaymentPermit {
  meta: {
    kind: "PAYMENT_ONLY" | string;
    paymentId: string;
    nonce: string;
    validAfter: number | string;
    validBefore: number | string;
  };
  buyer: string;
  caller: string;
  payment: {
    payToken: string;
    payAmount: string;
    payTo: string;
  };
  fee: {
    feeTo: string;
    feeAmount: string;
  };
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
    signature?: string;
    transaction?: string;
    authorization?: PaymentAuthorization;
    paymentPermit?: PaymentPermit;
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
  invalidMessage?: string;
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
  extra?: Record<string, unknown>;
}

/** /supported endpoint response */
export interface SupportedResponse {
  kinds: SupportedKind[];
  signers: Record<string, string[]>;
}

// Network Registry

function buildNetworkRegistry(): Record<string, NetworkConfig> {
  const env = getCloudAwareEnv();
  const alchemyKey = env.ALCHEMY_API_KEY ?? "";
  const infuraKey = env.INFURA_API_KEY ?? "";
  const baseMainnetRpc =
    env.X402_BASE_RPC_URL ??
    env.BASE_RPC_URL ??
    (alchemyKey ? `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}` : undefined);
  const baseSepoliaRpc =
    env.X402_BASE_SEPOLIA_RPC_URL ??
    env.BASE_SEPOLIA_RPC_URL ??
    (alchemyKey ? `https://base-sepolia.g.alchemy.com/v2/${alchemyKey}` : undefined);
  const ethereumRpc =
    env.X402_ETHEREUM_RPC_URL ??
    env.ETHEREUM_RPC_URL ??
    (alchemyKey
      ? `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`
      : infuraKey
        ? `https://mainnet.infura.io/v3/${infuraKey}`
        : undefined);
  const sepoliaRpc =
    env.X402_SEPOLIA_RPC_URL ??
    env.SEPOLIA_RPC_URL ??
    (alchemyKey
      ? `https://eth-sepolia.g.alchemy.com/v2/${alchemyKey}`
      : infuraKey
        ? `https://sepolia.infura.io/v3/${infuraKey}`
        : undefined);

  return {
    "eip155:8453": {
      chainId: 8453,
      caip2: "eip155:8453",
      name: "base",
      usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      usdcDomainName: "USD Coin",
      rpcUrl: baseMainnetRpc ?? "https://mainnet.base.org",
      chain: base,
    },
    "eip155:84532": {
      chainId: 84532,
      caip2: "eip155:84532",
      name: "base-sepolia",
      usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      usdcDomainName: "USDC",
      rpcUrl: baseSepoliaRpc ?? "https://sepolia.base.org",
      chain: baseSepolia,
    },
    "eip155:1": {
      chainId: 1,
      caip2: "eip155:1",
      name: "ethereum",
      usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      usdcDomainName: "USD Coin",
      rpcUrl: ethereumRpc ?? "https://cloudflare-eth.com",
      chain: mainnet,
    },
    "eip155:11155111": {
      chainId: 11155111,
      caip2: "eip155:11155111",
      name: "sepolia",
      usdcAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      usdcDomainName: "USDC",
      rpcUrl: sepoliaRpc ?? "https://rpc.sepolia.org",
      chain: sepolia,
    },
    "eip155:56": {
      chainId: 56,
      caip2: "eip155:56",
      name: "bsc",
      usdcAddress: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // Official Binance-Peg BUSD/USDC (BEP20 USDC)
      usdcDomainName: "USD Coin",
      rpcUrl: env.X402_BSC_RPC_URL ?? env.BSC_RPC_URL ?? "https://bsc-dataseed.binance.org",
      chain: bsc,
    },
    "eip155:97": {
      chainId: 97,
      caip2: "eip155:97",
      name: "bsc-testnet",
      usdcAddress: "0x64544969ed7EBf5f083679233325356EBe738930", // Standard Testnet USDC
      usdcDomainName: "USD Coin",
      rpcUrl:
        env.X402_BSC_TESTNET_RPC_URL ??
        env.BSC_TESTNET_RPC_URL ??
        "https://data-seed-prebsc-1-s1.binance.org:8545",
      chain: bscTestnet,
    },
  };
}

function buildSolanaNetworkRegistry(): Record<string, SolanaNetworkConfig> {
  return {
    [SOLANA_MAINNET_CAIP2]: {
      caip2: SOLANA_MAINNET_CAIP2,
      name: "solana",
      aliases: ["solana-mainnet"],
      usdcAddress: USDC_MAINNET_ADDRESS,
    },
    [SOLANA_DEVNET_CAIP2]: {
      caip2: SOLANA_DEVNET_CAIP2,
      name: "solana-devnet",
      aliases: ["devnet"],
      usdcAddress: USDC_DEVNET_ADDRESS,
    },
    [SOLANA_TESTNET_CAIP2]: {
      caip2: SOLANA_TESTNET_CAIP2,
      name: "solana-testnet",
      aliases: ["testnet"],
      usdcAddress: USDC_TESTNET_ADDRESS,
    },
  };
}

function getFirstConfiguredEnvValue(env: NodeJS.ProcessEnv, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function buildSolanaFacilitatorRpcConfig(): FacilitatorRpcConfig | undefined {
  const env = getCloudAwareEnv();
  type SvmNetwork = Parameters<typeof createRpcClient>[0];
  const rpcByNetwork: Record<string, ReturnType<typeof createRpcClient>> = {};

  const configuredRpcUrls: Array<[SvmNetwork, string | undefined]> = [
    [
      SOLANA_MAINNET_CAIP2,
      getFirstConfiguredEnvValue(env, [
        "X402_SOLANA_MAINNET_RPC_URL",
        "SOLANA_MAINNET_RPC_URL",
        "X402_SOLANA_RPC_URL",
        "SOLANA_RPC_URL",
        "NEXT_PUBLIC_SOLANA_RPC_URL",
      ]),
    ],
    [
      SOLANA_DEVNET_CAIP2,
      getFirstConfiguredEnvValue(env, [
        "X402_SOLANA_DEVNET_RPC_URL",
        "SOLANA_DEVNET_RPC_URL",
        "SOLANA_DEVNET_URL",
      ]),
    ],
    [
      SOLANA_TESTNET_CAIP2,
      getFirstConfiguredEnvValue(env, [
        "X402_SOLANA_TESTNET_RPC_URL",
        "SOLANA_TESTNET_RPC_URL",
        "SOLANA_TESTNET_URL",
      ]),
    ],
  ];

  for (const [network, rpcUrl] of configuredRpcUrls) {
    if (rpcUrl) {
      rpcByNetwork[network] = createRpcClient(network, rpcUrl);
    }
  }

  return Object.keys(rpcByNetwork).length > 0 ? rpcByNetwork : undefined;
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

const PAYMENT_PERMIT_TYPES = {
  PermitMeta: [
    { name: "kind", type: "uint8" },
    { name: "paymentId", type: "bytes16" },
    { name: "nonce", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
  ],
  Payment: [
    { name: "payToken", type: "address" },
    { name: "payAmount", type: "uint256" },
    { name: "payTo", type: "address" },
  ],
  Fee: [
    { name: "feeTo", type: "address" },
    { name: "feeAmount", type: "uint256" },
  ],
  PaymentPermitDetails: [
    { name: "meta", type: "PermitMeta" },
    { name: "buyer", type: "address" },
    { name: "caller", type: "address" },
    { name: "payment", type: "Payment" },
    { name: "fee", type: "Fee" },
  ],
} as const;

const PAYMENT_PERMIT_ABI = [
  {
    inputs: [
      {
        name: "permit",
        type: "tuple",
        components: [
          {
            name: "meta",
            type: "tuple",
            components: [
              { name: "kind", type: "uint8" },
              { name: "paymentId", type: "bytes16" },
              { name: "nonce", type: "uint256" },
              { name: "validAfter", type: "uint256" },
              { name: "validBefore", type: "uint256" },
            ],
          },
          { name: "buyer", type: "address" },
          { name: "caller", type: "address" },
          {
            name: "payment",
            type: "tuple",
            components: [
              { name: "payToken", type: "address" },
              { name: "payAmount", type: "uint256" },
              { name: "payTo", type: "address" },
            ],
          },
          {
            name: "fee",
            type: "tuple",
            components: [
              { name: "feeTo", type: "address" },
              { name: "feeAmount", type: "uint256" },
            ],
          },
        ],
      },
      { name: "owner", type: "address" },
      { name: "signature", type: "bytes" },
    ],
    name: "permitTransferFrom",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const PAYMENT_PERMIT_ADDRESSES: Record<string, Hex> = {
  "eip155:56": "0x1825bB32db3443dEc2cc7508b2D818fc13EaD878",
  "eip155:97": "0x1825bB32db3443dEc2cc7508b2D818fc13EaD878",
};

function getPaymentPermitAddress(network: string): Hex | null {
  const env = getCloudAwareEnv();
  const envKey =
    network === "eip155:56"
      ? "X402_PAYMENT_PERMIT_ADDRESS_BSC"
      : network === "eip155:97"
        ? "X402_PAYMENT_PERMIT_ADDRESS_BSC_TESTNET"
        : "";
  const configured = envKey ? env[envKey] : undefined;
  return (configured as Hex | undefined) ?? PAYMENT_PERMIT_ADDRESSES[network] ?? null;
}

function isExactPermitNetwork(network: string): boolean {
  return network === "eip155:56" || network === "eip155:97";
}

function isSolanaNetwork(network: string): boolean {
  return network.startsWith("solana:");
}

function parseEnabledNetworkNames(enabledStr: string): string[] {
  return enabledStr
    .split(",")
    .map((network) => network.trim())
    .filter(Boolean);
}

function isNetworkEnabled(
  enabledNames: string[],
  config: { caip2: string; name: string; aliases?: string[] },
): boolean {
  const exact = new Set(enabledNames);
  const normalized = new Set(enabledNames.map((name) => name.toLowerCase()));
  return (
    exact.has(config.caip2) ||
    normalized.has(config.name.toLowerCase()) ||
    (config.aliases ?? []).some((alias) => normalized.has(alias.toLowerCase()))
  );
}

function normalizePermitForTypedData(permit: PaymentPermit) {
  if (!/^0x[0-9a-fA-F]{32}$/.test(permit.meta.paymentId)) {
    throw new Error("invalid_payment_permit_payment_id");
  }
  return {
    meta: {
      kind: permit.meta.kind === "PAYMENT_ONLY" ? 0 : Number(permit.meta.kind),
      paymentId: permit.meta.paymentId as Hex,
      nonce: BigInt(permit.meta.nonce),
      validAfter: BigInt(permit.meta.validAfter),
      validBefore: BigInt(permit.meta.validBefore),
    },
    buyer: permit.buyer as Hex,
    caller: permit.caller as Hex,
    payment: {
      payToken: permit.payment.payToken as Hex,
      payAmount: BigInt(permit.payment.payAmount),
      payTo: permit.payment.payTo as Hex,
    },
    fee: {
      feeTo: permit.fee.feeTo as Hex,
      feeAmount: BigInt(permit.fee.feeAmount),
    },
  };
}

function decodeSolanaPrivateKey(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("empty_solana_private_key");
  }
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || !parsed.every((value) => Number.isInteger(value))) {
      throw new Error("invalid_solana_private_key_array");
    }
    return Uint8Array.from(parsed);
  }
  return bs58.decode(trimmed);
}

// Service Implementation

class X402FacilitatorService {
  private account: PrivateKeyAccount | null = null;
  private networks: Record<string, NetworkConfig> = {};
  private solanaNetworks: Record<string, SolanaNetworkConfig> = {};
  private clients: Map<string, PublicClient> = new Map();
  private enabledNetworks: string[] = [];
  private enabledSolanaNetworks: string[] = [];
  private svmScheme: ExactSvmFacilitator | null = null;
  private initialized = false;

  /**
   * Initialize the facilitator service.
   * Call this once at startup or on first request (lazy init).
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const env = getCloudAwareEnv();
    const enabledStr =
      env.X402_NETWORKS ??
      env.EVM_NETWORKS ??
      "base-sepolia,base,bsc,bsc-testnet,solana-devnet,solana";
    const enabledNames = parseEnabledNetworkNames(enabledStr);

    const privateKey = await this.loadFacilitatorKey();
    if (!privateKey) {
      logger.warn("[x402-facilitator] No EVM facilitator private key configured.");
    } else {
      try {
        this.account = privateKeyToAccount(privateKey as Hex);
        logger.info(`[x402-facilitator] EVM signer initialized: ${this.account.address}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[x402-facilitator] Failed to initialize EVM signer: ${msg}`);
      }
    }

    // Build network registry and RPC clients
    this.networks = buildNetworkRegistry();
    this.solanaNetworks = buildSolanaNetworkRegistry();

    if (this.account) {
      for (const [caip2, config] of Object.entries(this.networks)) {
        if (isNetworkEnabled(enabledNames, config)) {
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
    }

    await this.initializeSolanaFacilitator(enabledNames);

    logger.info(
      `[x402-facilitator] Enabled networks: ${[...this.enabledNetworks, ...this.enabledSolanaNetworks].join(", ")}`,
    );
    this.initialized = true;
  }

  /**
   * Check if the service is ready to process payments.
   */
  isReady(): boolean {
    return this.initialized && (this.account !== null || this.svmScheme !== null);
  }

  /**
   * Get the signer address.
   */
  getSignerAddress(): string | null {
    return this.account?.address ?? null;
  }

  /**
   * Get the signer/fee-payer address for a specific network.
   */
  getSignerAddressForNetwork(network: string): string | null {
    if (isSolanaNetwork(network)) {
      return this.svmScheme?.getSigners(network)[0] ?? null;
    }
    return this.getSignerAddress();
  }

  /**
   * Return supported schemes, networks, and signer addresses.
   */
  getSupported(): SupportedResponse {
    const kinds: SupportedKind[] = [];
    const signers: Record<string, string[]> = {};

    for (const network of this.enabledNetworks) {
      kinds.push({
        x402Version: 2,
        scheme: isExactPermitNetwork(network) ? "exact_permit" : "exact",
        network,
      });

      if (this.account) {
        signers[network] = [this.account.address];
      }
    }

    // Wildcard fallback
    if (this.account) {
      signers["eip155:*"] = [this.account.address];
    }

    if (this.svmScheme) {
      for (const network of this.enabledSolanaNetworks) {
        kinds.push({
          x402Version: 2,
          scheme: "exact",
          network,
          extra: this.svmScheme.getExtra(network),
        });
        signers[network] = this.svmScheme.getSigners(network);
      }
      signers["solana:*"] = this.svmScheme.getSigners("solana:*");
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
    const { signature } = payload;

    if (isSolanaNetwork(accepted.network)) {
      return this.verifySolanaPayment(paymentPayload, paymentRequirements);
    }

    if (!this.account) {
      return { isValid: false, invalidReason: "evm_facilitator_not_configured" };
    }

    if (typeof signature !== "string") {
      return { isValid: false, invalidReason: "missing_signature" };
    }

    // 1. Check network
    if (!this.enabledNetworks.includes(accepted.network)) {
      return {
        isValid: false,
        invalidReason: `network_not_supported: ${accepted.network}`,
      };
    }

    // 2. Check scheme
    if (
      accepted.scheme !== "exact" &&
      accepted.scheme !== "upto" &&
      accepted.scheme !== "exact_permit"
    ) {
      return {
        isValid: false,
        invalidReason: `scheme_not_supported: ${accepted.scheme}`,
      };
    }

    if (accepted.asset.toLowerCase() !== paymentRequirements.asset.toLowerCase()) {
      return {
        isValid: false,
        invalidReason: "asset_mismatch",
      };
    }

    // 3. Validate amount
    if (BigInt(accepted.amount) < BigInt(paymentRequirements.amount)) {
      return {
        isValid: false,
        invalidReason: "insufficient_amount",
      };
    }

    // 4. Validate payTo
    if (accepted.payTo.toLowerCase() !== paymentRequirements.payTo.toLowerCase()) {
      return {
        isValid: false,
        invalidReason: "payto_mismatch",
      };
    }

    // 5. Validate deadline
    const now = Math.floor(Date.now() / 1000);
    // 6. Verify signature (recover signer from EIP-712 typed data)
    const networkConfig = this.networks[accepted.network];
    if (!networkConfig) {
      return { isValid: false, invalidReason: "network_config_missing" };
    }

    let payerForError: string | undefined;

    try {
      const client = this.clients.get(accepted.network);
      if (!client) {
        return { isValid: false, invalidReason: "no_rpc_client" };
      }

      if (accepted.scheme === "exact_permit") {
        const permit = payload.paymentPermit;
        if (!permit) {
          return { isValid: false, invalidReason: "missing_payment_permit" };
        }
        payerForError = permit.buyer;
        if (BigInt(permit.meta.validBefore) <= BigInt(now)) {
          return {
            isValid: false,
            invalidReason: "payment_expired",
            payer: permit.buyer,
          };
        }
        if (permit.payment.payToken.toLowerCase() !== paymentRequirements.asset.toLowerCase()) {
          return { isValid: false, invalidReason: "permit_asset_mismatch", payer: permit.buyer };
        }
        if (BigInt(permit.payment.payAmount) < BigInt(paymentRequirements.amount)) {
          return { isValid: false, invalidReason: "insufficient_amount", payer: permit.buyer };
        }
        if (permit.payment.payTo.toLowerCase() !== paymentRequirements.payTo.toLowerCase()) {
          return { isValid: false, invalidReason: "payto_mismatch", payer: permit.buyer };
        }
        const expectedFee = paymentRequirements.extra?.fee as
          | { feeTo?: string; feeAmount?: string }
          | undefined;
        if (
          expectedFee?.feeTo &&
          permit.fee.feeTo.toLowerCase() !== expectedFee.feeTo.toLowerCase()
        ) {
          return { isValid: false, invalidReason: "fee_to_mismatch", payer: permit.buyer };
        }
        if (
          expectedFee?.feeAmount &&
          BigInt(permit.fee.feeAmount) < BigInt(expectedFee.feeAmount)
        ) {
          return { isValid: false, invalidReason: "fee_amount_too_low", payer: permit.buyer };
        }

        const permitContract = getPaymentPermitAddress(accepted.network);
        if (!permitContract) {
          return { isValid: false, invalidReason: "payment_permit_contract_missing" };
        }

        const permitMessage = normalizePermitForTypedData(permit);
        const isValidSig = await client.verifyTypedData({
          address: permit.buyer as Hex,
          domain: {
            name: "PaymentPermit",
            chainId: BigInt(networkConfig.chainId),
            verifyingContract: permitContract,
          },
          types: PAYMENT_PERMIT_TYPES,
          primaryType: "PaymentPermitDetails",
          message: permitMessage,
          signature: signature as Hex,
        });

        if (!isValidSig) {
          return {
            isValid: false,
            invalidReason: "invalid_signature",
            payer: permit.buyer,
          };
        }

        return { isValid: true, payer: permit.buyer };
      }

      const authorization = payload.authorization;
      if (!authorization) {
        return { isValid: false, invalidReason: "missing_authorization" };
      }
      payerForError = authorization.from;
      if (BigInt(authorization.validBefore) <= BigInt(now)) {
        return {
          isValid: false,
          invalidReason: "payment_expired",
          payer: authorization.from,
        };
      }
      if (authorization.to.toLowerCase() !== paymentRequirements.payTo.toLowerCase()) {
        return {
          isValid: false,
          invalidReason: "authorization_to_mismatch",
          payer: authorization.from,
        };
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
        payer: payerForError,
      };
    }

    // 7. Check USDC balance (optional but recommended)
    try {
      const client = this.clients.get(accepted.network);
      const balanceAddress = payload.authorization?.from ?? payload.paymentPermit?.buyer;
      if (client && balanceAddress) {
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
          args: [balanceAddress as Hex],
        });

        if ((balance as bigint) < BigInt(accepted.amount)) {
          return {
            isValid: false,
            invalidReason: "insufficient_balance",
            payer: balanceAddress,
          };
        }
      }
    } catch (err) {
      // Balance check is non-critical — log and continue
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[x402-facilitator] Balance check failed: ${msg}`);
    }

    return { isValid: true, payer: payload.authorization?.from ?? payload.paymentPermit?.buyer };
  }

  private async verifySolanaPayment(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResult> {
    const { accepted } = paymentPayload;

    if (!this.svmScheme) {
      return { isValid: false, invalidReason: "solana_facilitator_not_configured" };
    }

    if (!this.enabledSolanaNetworks.includes(accepted.network)) {
      return {
        isValid: false,
        invalidReason: `network_not_supported: ${accepted.network}`,
      };
    }

    if (accepted.scheme !== "exact") {
      return {
        isValid: false,
        invalidReason: `scheme_not_supported: ${accepted.scheme}`,
      };
    }

    if (accepted.asset !== paymentRequirements.asset) {
      return { isValid: false, invalidReason: "asset_mismatch" };
    }

    if (BigInt(accepted.amount) < BigInt(paymentRequirements.amount)) {
      return { isValid: false, invalidReason: "insufficient_amount" };
    }

    if (accepted.payTo !== paymentRequirements.payTo) {
      return { isValid: false, invalidReason: "payto_mismatch" };
    }

    try {
      const result = await this.svmScheme.verify(
        paymentPayload as Parameters<ExactSvmFacilitator["verify"]>[0],
        paymentRequirements as Parameters<ExactSvmFacilitator["verify"]>[1],
      );
      if (!result.isValid && result.invalidMessage) {
        logger.warn("[x402-facilitator] Solana verification failed", {
          invalidReason: result.invalidReason,
          invalidMessage: result.invalidMessage,
          payer: result.payer,
          network: accepted.network,
        });
      }
      return {
        isValid: result.isValid,
        payer: result.payer || undefined,
        invalidReason: result.invalidReason ?? result.invalidMessage,
        invalidMessage: result.invalidMessage,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[x402-facilitator] Solana verification failed: ${msg}`);
      return {
        isValid: false,
        invalidReason: `solana_verification_error: ${msg}`,
      };
    }
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

    if (
      isSolanaNetwork(paymentRequirements.network) ||
      isSolanaNetwork(paymentPayload.accepted.network)
    ) {
      return this.settleSolanaPayment(paymentPayload, paymentRequirements);
    }

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
    const { signature } = payload;
    if (typeof signature !== "string") {
      return {
        success: false,
        transaction: "",
        network: accepted.network,
        payer: verifyResult.payer,
        errorReason: "missing_signature",
      };
    }
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

      // Parse v, r, s from the compact signature when the token method needs it.
      const sigHex = signature.startsWith("0x") ? signature.slice(2) : signature;
      const r = `0x${sigHex.slice(0, 64)}` as Hex;
      const s = `0x${sigHex.slice(64, 128)}` as Hex;
      const v = parseInt(sigHex.slice(128, 130), 16);

      let txHash: Hex;

      if (accepted.scheme === "exact_permit") {
        const permit = payload.paymentPermit;
        if (!permit) {
          return {
            success: false,
            transaction: "",
            network: accepted.network,
            errorReason: "missing_payment_permit",
          };
        }
        const permitContract = getPaymentPermitAddress(accepted.network);
        if (!permitContract) {
          return {
            success: false,
            transaction: "",
            network: accepted.network,
            payer: permit.buyer,
            errorReason: "payment_permit_contract_missing",
          };
        }

        txHash = await walletClient.writeContract({
          address: permitContract,
          abi: PAYMENT_PERMIT_ABI,
          functionName: "permitTransferFrom",
          args: [normalizePermitForTypedData(permit), permit.buyer as Hex, signature as Hex],
        });
      } else if (accepted.scheme === "upto") {
        const authorization = payload.authorization;
        if (!authorization) {
          return {
            success: false,
            transaction: "",
            network: accepted.network,
            errorReason: "missing_authorization",
          };
        }
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
        const authorization = payload.authorization;
        if (!authorization) {
          return {
            success: false,
            transaction: "",
            network: accepted.network,
            errorReason: "missing_authorization",
          };
        }
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
        payer: payload.authorization?.from ?? payload.paymentPermit?.buyer,
        payTo: payload.authorization?.to ?? payload.paymentPermit?.payment.payTo,
        amount: payload.authorization?.value ?? payload.paymentPermit?.payment.payAmount,
        network: accepted.network,
      });

      return {
        success: true,
        transaction: txHash,
        network: accepted.network,
        payer: payload.authorization?.from ?? payload.paymentPermit?.buyer,
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
        payer: payload.authorization?.from ?? payload.paymentPermit?.buyer,
        errorReason,
      };
    }
  }

  private async settleSolanaPayment(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResult> {
    if (!this.svmScheme) {
      return {
        success: false,
        transaction: "",
        network: paymentRequirements.network,
        errorReason: "solana_facilitator_not_configured",
      };
    }

    if (!this.enabledSolanaNetworks.includes(paymentPayload.accepted.network)) {
      return {
        success: false,
        transaction: "",
        network: paymentPayload.accepted.network,
        errorReason: `network_not_supported: ${paymentPayload.accepted.network}`,
      };
    }

    try {
      const result = await this.svmScheme.settle(
        paymentPayload as Parameters<ExactSvmFacilitator["settle"]>[0],
        paymentRequirements as Parameters<ExactSvmFacilitator["settle"]>[1],
      );
      if (!result.success) {
        return {
          success: false,
          transaction: result.transaction,
          network: result.network,
          payer: result.payer || undefined,
          errorReason: result.errorReason ?? result.errorMessage ?? "solana_settlement_failed",
        };
      }

      logger.info("[x402-facilitator] Solana settlement TX submitted", {
        txHash: result.transaction,
        payer: result.payer,
        network: result.network,
      });

      return {
        success: true,
        transaction: result.transaction,
        network: result.network,
        payer: result.payer,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[x402-facilitator] Solana settlement failed: ${msg}`);
      return {
        success: false,
        transaction: "",
        network: paymentPayload.accepted.network,
        errorReason: `solana_settlement_error: ${msg}`,
      };
    }
  }

  // Private helpers

  private async initializeSolanaFacilitator(enabledNames: string[]): Promise<void> {
    const solanaKey = await this.loadSolanaFacilitatorKey();
    if (!solanaKey) {
      logger.warn("[x402-facilitator] No Solana facilitator private key configured.");
      return;
    }

    try {
      const secretKeyBytes = decodeSolanaPrivateKey(solanaKey);
      const keypair = await createKeyPairSignerFromBytes(secretKeyBytes);
      const signer = toFacilitatorSvmSigner(keypair, buildSolanaFacilitatorRpcConfig());
      this.svmScheme = new ExactSvmFacilitator(signer);

      for (const [caip2, config] of Object.entries(this.solanaNetworks)) {
        if (isNetworkEnabled(enabledNames, config)) {
          this.enabledSolanaNetworks.push(caip2);
        }
      }

      logger.info("[x402-facilitator] Solana signer initialized", {
        address: this.svmScheme.getSigners("solana:*")[0],
      });
    } catch (err) {
      this.svmScheme = null;
      this.enabledSolanaNetworks = [];
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[x402-facilitator] Failed to initialize Solana signer: ${msg}`);
    }
  }

  private async loadSolanaFacilitatorKey(): Promise<string | null> {
    try {
      const { secretsService } = await import("@/lib/services/secrets");
      if (secretsService) {
        for (const keyName of [
          "X402_SOLANA_FACILITATOR_PRIVATE_KEY",
          "SOLANA_FACILITATOR_PRIVATE_KEY",
          "SOLANA_PAYOUT_PRIVATE_KEY",
        ]) {
          const key = await secretsService.get("system", keyName).catch(() => null);
          if (key) {
            logger.info(`[x402-facilitator] Loaded ${keyName} from secrets service`);
            return key;
          }
        }
      }
    } catch {
      // Secrets service not available, fall through
    }

    const env = getCloudAwareEnv();
    return (
      env.X402_SOLANA_FACILITATOR_PRIVATE_KEY ??
      env.SOLANA_FACILITATOR_PRIVATE_KEY ??
      env.SOLANA_PAYOUT_PRIVATE_KEY ??
      null
    );
  }

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
    const env = getCloudAwareEnv();
    const envKey = env.FACILITATOR_PRIVATE_KEY ?? env.X402_FACILITATOR_PRIVATE_KEY;

    if (envKey) {
      if (env.NODE_ENV === "production") {
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
