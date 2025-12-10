/**
 * x402 Payment Protocol - ElizaOS Cloud Default
 * @see https://x402.org
 */

import { parseEther, formatEther } from 'viem';

// ============================================================================
// Types
// ============================================================================

export type X402Network = 'sepolia' | 'ethereum' | 'base' | 'base-sepolia' | 'jeju' | 'jeju-testnet';

export interface PaymentRequirements {
  x402Version: number;
  error: string;
  accepts: PaymentScheme[];
}

export interface PaymentScheme {
  scheme: 'exact' | 'upto';
  network: X402Network;
  maxAmountRequired: string;
  asset: `0x${string}`;
  payTo: `0x${string}`;
  resource: string;
  description: string;
  mimeType: string;
  outputSchema: string | null;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface PaymentPayload {
  scheme: string;
  network: string;
  asset: `0x${string}`;
  payTo: `0x${string}`;
  amount: string;
  resource: string;
  nonce: string;
  timestamp: number;
  signature?: string;
}

export interface X402Config {
  recipientAddress: `0x${string}`;
  network: X402Network;
  serviceName: string;
  facilitatorEndpoint?: string;
}

export interface X402Status {
  enabled: boolean;
  configured: boolean;
  mode: 'cloud' | 'self-hosted' | 'disabled';
  network: X402Network | null;
  facilitator: string | null;
  recipient: string | null;
  error?: string;
}

// ============================================================================
// ElizaOS Cloud (Default)
// ============================================================================

export const ELIZAOS_CLOUD_FACILITATORS: Record<string, string> = {
  mainnet: 'https://pay.elizaos.ai/v1',
  testnet: 'https://pay-testnet.elizaos.ai/v1',
  base: 'https://pay.elizaos.ai/v1/base',
  'base-sepolia': 'https://pay-testnet.elizaos.ai/v1/base-sepolia',
};

/** 
 * ElizaOS Cloud payment contract addresses
 * Networks with null or zero address require self-hosted payment recipient
 */
export const ELIZAOS_CLOUD_CONTRACTS: Record<X402Network, `0x${string}` | null> = {
  'base-sepolia': '0x0F7E3D1b3edcf09f134EA8F1ECa2C6A0e00b3E96', // Deployed and active
  base: null,           // Pending mainnet deployment
  jeju: null,           // Pending deployment
  'jeju-testnet': null, // Pending deployment
  ethereum: null,       // Not supported
  sepolia: null,        // Not supported
};

/** Check if a network has ElizaOS Cloud payment support */
export function hasCloudPaymentSupport(network: X402Network): boolean {
  const contract = ELIZAOS_CLOUD_CONTRACTS[network];
  return contract !== null && contract !== NATIVE_TOKEN;
}

/** Get supported networks for cloud payments */
export function getSupportedCloudNetworks(): X402Network[] {
  return (Object.keys(ELIZAOS_CLOUD_CONTRACTS) as X402Network[])
    .filter(hasCloudPaymentSupport);
}

// ============================================================================
// Constants
// ============================================================================

export const NATIVE_TOKEN: `0x${string}` = '0x0000000000000000000000000000000000000000';

export const CHAIN_IDS: Record<X402Network, number> = {
  sepolia: 11155111,
  'base-sepolia': 84532,
  ethereum: 1,
  base: 8453,
  jeju: 420691,
  'jeju-testnet': 420690,
};

export const RPC_URLS: Record<X402Network, string> = {
  sepolia: 'https://ethereum-sepolia-rpc.publicnode.com',
  'base-sepolia': 'https://sepolia.base.org',
  ethereum: 'https://eth.llamarpc.com',
  base: 'https://mainnet.base.org',
  jeju: process.env.JEJU_RPC_URL || 'http://127.0.0.1:9545',
  'jeju-testnet': 'https://testnet-rpc.jeju.network',
};

export const USDC_ADDRESSES: Record<X402Network, `0x${string}`> = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  sepolia: '0x0000000000000000000000000000000000000000',
  jeju: '0x0165878A594ca255338adfa4d48449f69242Eb8F',
  'jeju-testnet': '0x0000000000000000000000000000000000000000',
};

// ============================================================================
// Payment Tiers
// ============================================================================

export const PAYMENT_TIERS = {
  API_CALL_FREE: 0n,
  API_CALL_BASIC: parseEther('0.0001'),
  API_CALL_PREMIUM: parseEther('0.001'),
  DAILY_ACCESS: parseEther('0.01'),
  WEEKLY_ACCESS: parseEther('0.05'),
  MONTHLY_ACCESS: parseEther('0.1'),
  TASK_SMALL: parseEther('0.0005'),
  TASK_MEDIUM: parseEther('0.002'),
  TASK_LARGE: parseEther('0.01'),
} as const;

// ============================================================================
// x402 Status
// ============================================================================

export function getX402Status(config: Partial<X402Config> & { enabled?: boolean }): X402Status {
  if (config.enabled === false) {
    return { enabled: false, configured: false, mode: 'disabled', network: null, facilitator: null, recipient: null };
  }

  const network = config.network || 'base-sepolia';
  const recipient = config.recipientAddress;
  
  // If no recipient configured, check for cloud support
  if (!recipient || recipient === NATIVE_TOKEN) {
    // Check if network has cloud payment support
    if (!hasCloudPaymentSupport(network)) {
      const supported = getSupportedCloudNetworks();
      return { 
        enabled: false, 
        configured: false, 
        mode: 'disabled', 
        network, 
        facilitator: null, 
        recipient: null, 
        error: `No ElizaOS Cloud contract for ${network}. Configure PAYMENT_RECIPIENT or use: ${supported.join(', ')}`
      };
    }
    
    const cloudFacilitator = ELIZAOS_CLOUD_FACILITATORS[network] || ELIZAOS_CLOUD_FACILITATORS.testnet;
    return { enabled: true, configured: true, mode: 'cloud', network, facilitator: cloudFacilitator, recipient: null };
  }

  // Self-hosted mode with explicit recipient
  const facilitator = config.facilitatorEndpoint || ELIZAOS_CLOUD_FACILITATORS[network] || ELIZAOS_CLOUD_FACILITATORS.testnet;
  return {
    enabled: true,
    configured: true,
    mode: facilitator?.includes('elizaos.ai') ? 'cloud' : 'self-hosted',
    network,
    facilitator,
    recipient,
  };
}

export function isX402Configured(config: Partial<X402Config> & { enabled?: boolean }): boolean {
  const status = getX402Status(config);
  return status.enabled && status.configured;
}

export function getFacilitatorEndpoint(network: X402Network): string {
  return ELIZAOS_CLOUD_FACILITATORS[network] || ELIZAOS_CLOUD_FACILITATORS.testnet || 'https://pay-testnet.elizaos.ai/v1';
}

// ============================================================================
// EIP-712
// ============================================================================

const EIP712_DOMAIN_BASE = {
  name: 'x402 Payment Protocol',
  version: '1',
  verifyingContract: NATIVE_TOKEN,
};

// ============================================================================
// Core Functions
// ============================================================================

function generateSecureNonce(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

/** Create 402 Payment Required response. Returns null if x402 not configured (free access). */
export function createPaymentRequirement(
  resource: string,
  amount: bigint,
  description: string,
  config: X402Config,
  tokenAddress: `0x${string}` = NATIVE_TOKEN
): PaymentRequirements | null {
  const status = getX402Status(config);
  
  if (!status.enabled || !status.configured) {
    return null;
  }

  // Determine payment recipient
  let payTo: `0x${string}` | null = null;
  
  if (status.mode === 'cloud' && status.network) {
    // In cloud mode, use cloud contract if available
    const cloudContract = ELIZAOS_CLOUD_CONTRACTS[status.network];
    if (cloudContract && cloudContract !== NATIVE_TOKEN) {
      payTo = cloudContract;
    }
  } else if (config.recipientAddress && config.recipientAddress !== NATIVE_TOKEN) {
    // Self-hosted mode with explicit recipient
    payTo = config.recipientAddress;
  }

  if (!payTo) {
    return null;
  }

  return {
    x402Version: 1,
    error: 'Payment required to access this resource',
    accepts: [{
      scheme: 'exact',
      network: config.network,
      maxAmountRequired: amount.toString(),
      asset: tokenAddress,
      payTo,
      resource,
      description,
      mimeType: 'application/json',
      outputSchema: null,
      maxTimeoutSeconds: 300,
      extra: { serviceName: config.serviceName, facilitator: status.facilitator, mode: status.mode },
    }],
  };
}

/** Create payment requirement with graceful fallback. Returns null for free access. */
export function createPaymentRequirementSafe(
  resource: string,
  amount: bigint,
  description: string,
  config: Partial<X402Config> & { enabled?: boolean; network?: X402Network; serviceName?: string },
  tokenAddress: `0x${string}` = NATIVE_TOKEN
): PaymentRequirements | null {
  if (config.enabled === false) return null;

  return createPaymentRequirement(resource, amount, description, {
    recipientAddress: config.recipientAddress || NATIVE_TOKEN,
    network: config.network || 'base-sepolia',
    serviceName: config.serviceName || 'ElizaOS Service',
    facilitatorEndpoint: config.facilitatorEndpoint,
  }, tokenAddress);
}

export function getEIP712Domain(network: X402Network) {
  return { ...EIP712_DOMAIN_BASE, chainId: CHAIN_IDS[network] };
}

export function createPaymentPayload(
  asset: `0x${string}`,
  payTo: `0x${string}`,
  amount: bigint,
  resource: string,
  network: X402Network = 'base-sepolia'
): Omit<PaymentPayload, 'signature'> {
  return {
    scheme: 'exact',
    network,
    asset,
    payTo,
    amount: amount.toString(),
    resource,
    nonce: generateSecureNonce(),
    timestamp: Math.floor(Date.now() / 1000),
  };
}

export function parsePaymentHeader(headerValue: string | null): PaymentPayload | null {
  if (!headerValue) return null;
  try {
    const parsed = JSON.parse(headerValue) as PaymentPayload;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export interface VerifyOptions {
  /** Skip facilitator verification (local validation only) */
  skipFacilitator?: boolean;
  /** Custom facilitator endpoint */
  facilitatorEndpoint?: string;
}

/** Verify payment locally - checks amount, recipient, timestamp, signature format */
function verifyPaymentLocal(
  payload: PaymentPayload,
  expectedAmount: bigint,
  expectedRecipient: `0x${string}`
): { valid: boolean; error?: string } {
  if (!payload.amount || !payload.payTo || !payload.asset) {
    return { valid: false, error: 'Missing required payment fields' };
  }

  const paymentAmount = BigInt(payload.amount);
  if (paymentAmount < expectedAmount) {
    return { valid: false, error: `Insufficient: ${formatEther(paymentAmount)} < ${formatEther(expectedAmount)}` };
  }

  if (payload.payTo.toLowerCase() !== expectedRecipient.toLowerCase()) {
    return { valid: false, error: 'Invalid recipient' };
  }

  if (Math.abs(Math.floor(Date.now() / 1000) - payload.timestamp) > 300) {
    return { valid: false, error: 'Payment expired' };
  }

  if (!payload.signature?.startsWith('0x') || payload.signature.length !== 132) {
    return { valid: false, error: 'Invalid signature' };
  }

  return { valid: true };
}

/** Verify payment with ElizaOS Cloud facilitator */
async function verifyWithFacilitator(
  payload: PaymentPayload,
  facilitatorEndpoint: string
): Promise<{ valid: boolean; error?: string; txHash?: string }> {
  const endpoint = `${facilitatorEndpoint}/verify`;
  
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    if (response.status === 402) {
      return { valid: false, error: 'Payment not found or not settled' };
    }
    return { valid: false, error: `Facilitator error: ${response.status}` };
  }

  const result = await response.json() as { valid: boolean; txHash?: string; error?: string };
  return result;
}

/** Full payment verification with optional facilitator check */
export async function verifyPayment(
  payload: PaymentPayload,
  expectedAmount: bigint,
  expectedRecipient: `0x${string}`,
  options: VerifyOptions = {}
): Promise<{ valid: boolean; error?: string; txHash?: string }> {
  // First do local validation
  const localResult = verifyPaymentLocal(payload, expectedAmount, expectedRecipient);
  if (!localResult.valid) {
    return localResult;
  }

  // If skipFacilitator is true or no facilitator endpoint, return local result
  if (options.skipFacilitator) {
    return { valid: true };
  }

  // Determine facilitator endpoint
  const network = payload.network as X402Network;
  const facilitator = options.facilitatorEndpoint || 
    ELIZAOS_CLOUD_FACILITATORS[network] || 
    ELIZAOS_CLOUD_FACILITATORS.testnet;

  if (!facilitator) {
    // No facilitator available, fall back to local validation only
    return { valid: true };
  }

  // Verify with facilitator (catches errors gracefully)
  try {
    return await verifyWithFacilitator(payload, facilitator);
  } catch {
    // If facilitator is unreachable, fall back to local validation
    console.warn('[x402] Facilitator unreachable, using local validation');
    return { valid: true };
  }
}

export async function checkPayment(
  paymentHeader: string | null,
  requiredAmount: bigint,
  recipient: `0x${string}`,
  options: VerifyOptions = {}
): Promise<{ paid: boolean; error?: string; txHash?: string }> {
  const payment = parsePaymentHeader(paymentHeader);
  if (!payment) return { paid: false, error: 'No payment header' };
  
  const verification = await verifyPayment(payment, requiredAmount, recipient, options);
  return verification.valid 
    ? { paid: true, txHash: verification.txHash } 
    : { paid: false, error: verification.error };
}

export function generate402Headers(requirements: PaymentRequirements): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'x402',
    'X-Payment-Requirement': JSON.stringify(requirements),
    'Access-Control-Expose-Headers': 'X-Payment-Requirement, WWW-Authenticate',
  };
}

export function calculatePercentageFee(amount: bigint, basisPoints: number): bigint {
  return (amount * BigInt(basisPoints)) / 10000n;
}

export function formatAmount(amount: bigint): string {
  return `${formatEther(amount)} ETH`;
}
