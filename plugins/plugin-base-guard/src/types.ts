import { z } from "zod";
import type {
  Action as CoreAction,
  Evaluator as CoreEvaluator,
  Provider as CoreProvider,
  Plugin as CorePlugin,
  IAgentRuntime as CoreIAgentRuntime,
  Memory as CoreMemory,
  State as CoreState,
  HandlerCallback as CoreHandlerCallback,
} from "@elizaos/core";

export type Action = CoreAction;
export type Provider = CoreProvider;
export type Plugin = CorePlugin;
export type IAgentRuntime = CoreIAgentRuntime;
export type Memory = CoreMemory;
export type State = CoreState;
export type HandlerCallback = CoreHandlerCallback;

export interface Evaluator {
  name: string;
  description: string;
  similes?: string[];
  handler: (runtime: IAgentRuntime, message: Memory, state?: State) => Promise<unknown>;
}

/**
 * Onchain Security & Guardrail Configurations
 */
export interface GuardPolicy {
  maxNativePerTx: string;  // in ETH, e.g. "0.05"
  maxNativeDaily: string;  // in ETH, e.g. "0.20"
  maxUsdcPerTx: string;    // in USDC, e.g. "50.0"
  maxUsdcDaily: string;    // in USDC, e.g. "200.0"
  maxPaymentPerX402: string; // in USDC, e.g. "5.0"
  blockedDestinations: string[];
  strictMode: boolean;
}

export type VerdictCode =
  | "APPROVED"
  | "PROMPT_INJECTION_DETECTED"
  | "DESTINATION_BLOCKLISTED"
  | "INVALID_DESTINATION"
  | "UNLIMITED_APPROVAL_ATTACK"
  | "DANGEROUS_CALLDATA"
  | "UNRECOGNIZED_CALLDATA"
  | "EXCEEDS_SPEND_LIMIT"
  | "X402_EXPIRED"
  | "X402_EXPIRED_OR_MISSING"
  | "X402_NONCE_REPLAY"
  | "X402_EXCEEDS_CAP"
  | "X402_MALFORMED"
  | "MALFORMED_VALUE";

export interface SecurityVerdict {
  allowed: boolean;
  code: VerdictCode;
  riskScore: number; // 0 to 100
  reason: string;
  timestamp: number;
  diagnostics?: Record<string, unknown>;
}

export const TransactionInputSchema = z.object({
  to: z.string(),
  value: z.string().optional().default("0"),
  data: z.string().optional().default("0x"),
  userPrompt: z.string().optional(),
  reasoningTrace: z.string().optional()
});
export type TransactionInput = z.infer<typeof TransactionInputSchema>;

export const X402ChallengeSchema = z.object({
  merchant: z.string(),
  amountUsdc: z.string(),
  resourceUri: z.string(),
  nonce: z.string(),
  deadline: z.number(),
  tokenAddress: z.string().optional()
});
export type X402Challenge = z.infer<typeof X402ChallengeSchema>;
