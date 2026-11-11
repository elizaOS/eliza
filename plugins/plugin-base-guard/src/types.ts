import { z } from "zod";

/**
 * Standard ElizaOS runtime and plugin interfaces
 */
export interface Memory {
  id?: string;
  userId?: string;
  agentId?: string;
  createdAt?: number;
  content: {
    text: string;
    action?: string;
    source?: string;
    url?: string;
    inReplyTo?: string;
    attachments?: unknown[];
    [key: string]: unknown;
  };
  roomId?: string;
  embedding?: number[];
}

export interface State {
  userId?: string;
  agentId?: string;
  bio?: string;
  lore?: string;
  messageDirections?: string;
  postDirections?: string;
  roomId?: string;
  actors?: string;
  recentMessages?: string;
  recentMessagesData?: Memory[];
  [key: string]: unknown;
}

export type HandlerCallback = (
  response: { text: string; action?: string; [key: string]: unknown },
  files?: unknown[]
) => Promise<unknown>;

export interface IAgentRuntime {
  agentId?: string;
  serverUrl?: string;
  getSetting(key: string): string | undefined;
  getConversationLength?(): number;
  [key: string]: unknown;
}

export interface Action {
  name: string;
  description: string;
  similes?: string[];
  examples?: Array<Array<{ user: string; content: { text: string; [key: string]: unknown } }>>;
  validate: (runtime: IAgentRuntime, message: Memory, state?: State) => Promise<boolean>;
  handler: (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ) => Promise<unknown>;
}

export interface Evaluator {
  name: string;
  description: string;
  similes?: string[];
  examples?: Array<{ prompt: string; outcome: string }>;
  validate: (runtime: IAgentRuntime, message: Memory, state?: State) => Promise<boolean>;
  handler: (runtime: IAgentRuntime, message: Memory, state?: State) => Promise<unknown>;
}

export interface Provider {
  get: (runtime: IAgentRuntime, message: Memory, state?: State) => Promise<string | null>;
}

export interface Plugin {
  name: string;
  description: string;
  actions?: Action[];
  evaluators?: Evaluator[];
  providers?: Provider[];
  services?: unknown[];
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
  | "EXCEEDS_SPEND_LIMIT"
  | "X402_EXPIRED"
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
