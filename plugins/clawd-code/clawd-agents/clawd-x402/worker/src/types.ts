/**
 * Shared types for the ClawdRouter gateway.
 */

export interface Env {
  // vars from wrangler.jsonc
  NETWORK: "solana-mainnet" | "solana-devnet";
  TREASURY_OWNER: string;
  USDC_MINT: string;
  CLAWD_MINT: string;
  CLAWD_VAULT_PROGRAM: string;
  /** Optional p-token program id override. */
  P_TOKEN_PROGRAM_ID?: string;
  /** Set to "0" or "false" to force classic SPL Token payments. */
  USE_P_TOKEN?: string;
  REGISTRY_SEED: string;
  PINATA_GATEWAY: string;
  SPLIT_OWNER_BPS: number;
  SPLIT_BUYBACK_BPS: number;
  SPLIT_TREASURY_BPS: number;
  SPLIT_OPERATOR_BPS: number;
  DISCOUNT_TIER_1_BALANCE: string;
  DISCOUNT_TIER_1_BPS: number;
  DISCOUNT_TIER_2_BALANCE: string;
  DISCOUNT_TIER_2_BPS: number;
  DISCOUNT_TIER_3_BALANCE: string;
  DISCOUNT_TIER_3_BPS: number;

  // secrets
  HELIUS_API_KEY: string;
  SOLANATRACKER_API_KEY: string;
  PINATA_JWT: string;
  OPERATOR_KEYPAIR: string; // base58
  AP2_VERIFIER_JWK?: string;
}

/** x402 payment requirement — the body of PAYMENT-REQUIRED on Solana. */
export interface SolanaPaymentRequirement {
  scheme: "exact";
  network: "solana" | "solana-devnet";
  resource: string;
  description: string;
  mimeType?: string;
  /** base58-encoded Solana pubkey receiving the transfer (ATA owner, not ATA itself) */
  payTo: string;
  /** base58-encoded SPL mint (USDC or $CLAWD) */
  asset: string;
  /** amount in base units as a string (USDC has 6 decimals, $CLAWD has 9) */
  maxAmountRequired: string;
  /** seconds a signed tx is valid for — tied to blockhash freshness */
  maxTimeoutSeconds: number;
  extra: {
    decimals: number;
    /** the exact recent blockhash the client must use */
    recentBlockhash?: string;
    /** optional memo to tag the payment with the agent + caller */
    memo?: string;
    /** which token program to use — "p-token" opts into SIMD-0266 lower CUs */
    tokenProgram?: "spl" | "p-token";
    /** concrete p-token program id clients should compile against */
    pTokenProgramId?: string;
    /** p-token batch: multiple outputs in a single instruction */
    batchOutputs?: BatchOutput[];
  };
}

/** One recipient in a p-token batch transfer instruction. */
export interface BatchOutput {
  /** base58 ATA owner (not ATA address) */
  payTo: string;
  /** amount in base units */
  amount: string;
}

/** Agent entry fetched from the on-chain registry. */
export interface AgentRecord {
  /** The agent's canonical id — usually the pubkey of its owner or a PDA */
  id: string;
  owner: string; // base58
  /** Revenue split override in basis points — if missing, use defaults */
  splitOwnerBps?: number;
  splitBuybackBps?: number;
  splitTreasuryBps?: number;
  splitOperatorBps?: number;
  buybackRecipient?: string;
  treasuryRecipient?: string;
  operatorRecipient?: string;
  /** IPFS CID of the agent manifest (A2A agent card + pricing) */
  manifestCid: string;
  /** Per-method pricing in USDC base units */
  pricing: Record<string, string>;
  /** Agent endpoint URL */
  endpoint: string;
  /** Whether the agent accepts each protocol */
  protocols: {
    x402: boolean;
    mpp: boolean;
    ap2: boolean;
    a2a: boolean;
  };
}

/** A2A agent card — what .well-known/agent.json returns. */
export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming?: boolean;
    pushNotifications?: boolean;
  };
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags?: string[];
    examples?: string[];
  }>;
  /** Non-standard extension: pricing per skill in x402/MPP format */
  pricing?: Record<string, {
    amount: string;
    asset: string;
    protocols: string[];
  }>;
}

/** AP2 intent mandate — the VC payload we accept as a payment promise. */
export interface AP2IntentMandate {
  /** JWT-VC string, signed by a trusted issuer */
  vc: string;
  /** The decoded payload after verification */
  payload?: {
    iss: string;
    sub: string; // the user/agent on behalf of whom the mandate was issued
    aud: string;
    maxAmount: string;
    asset: string;
    resource: string;
    exp: number;
  };
}

/** p-token network status — cached result of program detection. */
export interface PTokenStatus {
  active: boolean;
  programId: string;
  /** CU savings vs SPL for a single transferChecked — informational */
  cuSavingsPerTransfer: number;
  checkedAt: number; // epoch ms
}

/** Settlement receipt — what we write to IPFS after a successful payment. */
export interface SettlementReceipt {
  protocol: "x402" | "mpp" | "ap2" | "a2a";
  agent: string;
  caller: string;
  signature: string; // Solana tx signature
  amount: string;
  asset: string;
  discount?: {
    tier: number;
    bps: number;
    originalAmount: string;
  };
  split: {
    owner: string;
    buyback: string;
    treasury: string;
    operator: string;
  };
  timestamp: number;
}
