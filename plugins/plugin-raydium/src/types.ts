import {
  ILpService,
  LpPositionDetails,
  PoolInfo,
  TokenBalance,
  TransactionResult,
} from '@elizaos/core';
import { Keypair as SolanaKeypair } from '@solana/web3.js';

// ===== Added Common LP Types =====
export type VaultKeypair = {
  publicKey: string;
  secretKey: Uint8Array;
};

export type OptimizationOpportunity = {
  sourcePosition?: LpPositionDetails;
  sourcePool?: PoolInfo;
  targetPool: PoolInfo;
  estimatedNewYield: number;
  currentYield?: number;
  estimatedCostToMoveLamports?: string;
  estimatedCostToMoveUsd?: number;
  netGainPercent?: number;
  reason?: string;
  actions?: string[];
};

export type UserLpProfile = {
  userId: string;
  vaultPublicKey: string;
  encryptedSecretKey: string;
  autoRebalanceConfig: {
    enabled: boolean;
    minGainThresholdPercent: number;
    preferredDexes?: string[];
    maxSlippageBps: number;
    maxGasFeeLamports?: string;
    cycleIntervalHours?: number;
  };
  trackedPositions?: TrackedLpPosition[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type LpReceipt = {
  transactionId: string;
  poolId: string;
  dex: string;
  inputTokens: TokenBalance[];
  outputLpTokens: TokenBalance;
  timestamp: number;
  feesPaid?: TokenBalance[];
  metadata?: Record<string, any>;
};

export interface IDexSpecificLpService extends ILpService {}

export type TrackedLpPosition = {
  positionIdentifier: string;
  dex: string;
  poolAddress: string;
  metadata?: Record<string, any>;
};

export type TrackedLpPositionInput = Omit<TrackedLpPosition, 'createdAt' | 'updatedAt'>;
