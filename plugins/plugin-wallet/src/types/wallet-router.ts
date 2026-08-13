/**
 * Contract types for the wallet router: `WalletRouterParams` /
 * `WalletRouterResult` are the request/response shapes `WalletBackendService`
 * dispatches, and `WalletChainHandler` is the interface every chain
 * implementation (EVM, Solana, pump.fun, …) must satisfy to plug into
 * `registerDefaultWalletChainHandlers`. Also defines the Zod schema
 * (`WalletRouterParamsSchema`) that parses and normalizes raw action input
 * (string/number coercion, comma-separated array parsing, truthy-string
 * booleans) into a validated `WalletRouterParams`. `mode: "simulate"` is a
 * third, non-broadcasting mode alongside `prepare`/`execute`: a handler that
 * opts in via `simulate`/`simulation` builds the real unsigned transaction
 * and runs it through `connection.simulateTransaction`, returning a typed
 * `WalletRouterSimulation` instead of ever signing or submitting.
 */
import type {
  IAgentRuntime,
  ITokenDataService,
  IWalletService,
} from "@elizaos/core";
import { z } from "zod";
import type { WalletBackend } from "../wallet/backend.js";

export const WALLET_ROUTER_SUBACTIONS = [
  "transfer",
  "swap",
  "bridge",
  "gov",
  "pump_fun_buy",
] as const;

export type WalletRouterSubaction = (typeof WALLET_ROUTER_SUBACTIONS)[number];

export const WALLET_ROUTER_MODES = ["prepare", "execute", "simulate"] as const;

export type WalletRouterMode = (typeof WALLET_ROUTER_MODES)[number];

export const WALLET_GOV_OPS = ["propose", "vote", "queue", "execute"] as const;

export type WalletGovOp = (typeof WALLET_GOV_OPS)[number];

export interface WalletRouterParams {
  readonly subaction: WalletRouterSubaction;
  readonly chain?: string;
  readonly toChain?: string;
  readonly fromToken?: string;
  readonly toToken?: string;
  readonly amount?: string;
  readonly recipient?: string;
  readonly slippageBps?: number;
  readonly mode: WalletRouterMode;
  readonly dryRun: boolean;
  readonly op?: WalletGovOp;
  readonly governor?: string;
  readonly proposalId?: string;
  readonly support?: number;
  readonly targets?: readonly string[];
  readonly values?: readonly string[];
  readonly calldatas?: readonly string[];
  readonly description?: string;
}

export interface WalletTokenMetadata {
  readonly symbol: string;
  readonly address: string;
  readonly decimals?: number;
  readonly native?: boolean;
}

export interface WalletSignerMetadata {
  readonly required: boolean;
  readonly kind: "evm" | "solana" | "off-chain";
  readonly source?: string;
  readonly description?: string;
}

export interface WalletDryRunMetadata {
  readonly supported: boolean;
  readonly supportedActions: readonly WalletRouterSubaction[];
  readonly description?: string;
}

/**
 * Declares whether a handler can build the real unsigned transaction for a
 * subaction and run it through `connection.simulateTransaction` (no signing,
 * no broadcast). Optional and per-handler, mirroring {@link
 * WalletDryRunMetadata}: only handlers that opt in populate this.
 */
export interface WalletSimulationMetadata {
  readonly supported: boolean;
  readonly supportedActions: readonly WalletRouterSubaction[];
  readonly description?: string;
}

export interface WalletChainHandlerMetadata {
  readonly chainId: string;
  readonly chain: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly supportedActions: readonly WalletRouterSubaction[];
  readonly tokens: readonly WalletTokenMetadata[];
  readonly signer: WalletSignerMetadata;
  readonly dryRun: WalletDryRunMetadata;
  readonly simulation?: WalletSimulationMetadata;
}

export interface WalletRouterContext {
  readonly runtime: IAgentRuntime;
  readonly walletBackend: WalletBackend | null;
  readonly walletServices: readonly IWalletService[];
  readonly tokenDataService: ITokenDataService | null;
}

/**
 * Result of running a handler's real unsigned transaction through
 * `connection.simulateTransaction({ sigVerify: false, replaceRecentBlockhash:
 * true })`. An RPC-reported revert is a *successful* simulation with
 * `success: false` and a populated `err`/`logs` — never a thrown error, and
 * never fabricated success. `summary` echoes the subaction-specific
 * quote/build fields (swap: inToken/outToken/inAmount/outAmount/
 * priceImpactPct from the Jupiter quote; pump_fun_buy: mint/solAmount) so
 * callers can render a result without re-deriving it from `metadata`.
 */
/**
 * One leg of the route the simulated transaction would take (Jupiter
 * `routePlan` shape, condensed). Empty for venues with a single fixed route
 * (pump.fun bonding curve).
 */
export interface WalletSimulationRouteLeg {
  readonly label: string | null;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly percent: number | null;
}

export interface WalletRouterSimulation {
  readonly success: boolean;
  readonly err: string | null;
  readonly logs: readonly string[];
  readonly unitsConsumed: number | null;
  /** The venue-reported route the built transaction would take. */
  readonly route: readonly WalletSimulationRouteLeg[];
  /** Slippage the caller asked for (bps), null when they did not specify. */
  readonly requestedSlippageBps: number | null;
  /** Slippage the venue actually applied to the built transaction (bps). */
  readonly effectiveSlippageBps: number | null;
  readonly summary: Readonly<Record<string, string | number | null>>;
}

export interface WalletRouterExecution {
  readonly status: "prepared" | "submitted" | "simulated";
  readonly chain: string;
  readonly chainId: string;
  readonly subaction: WalletRouterSubaction;
  readonly dryRun: boolean;
  readonly mode: WalletRouterMode;
  readonly transactionHash?: string;
  readonly signature?: string;
  readonly from?: string;
  readonly to?: string;
  readonly amount?: string;
  readonly fromToken?: string;
  readonly toToken?: string;
  readonly metadata?: Record<string, unknown>;
  readonly simulation?: WalletRouterSimulation;
}

export interface WalletChainHandler extends WalletChainHandlerMetadata {
  execute(
    params: WalletRouterParams,
    context: WalletRouterContext,
  ): Promise<WalletRouterExecution>;
  /**
   * Builds the real unsigned transaction for a subaction and returns its
   * `connection.simulateTransaction` result instead of signing or
   * broadcasting. Present only on handlers that declare `simulation.supported`
   * for the subaction; the router treats a missing/unsupported combination as
   * a typed `SIMULATION_UNSUPPORTED` failure, never a fallback to `execute`.
   */
  simulate?(
    params: WalletRouterParams,
    context: WalletRouterContext,
  ): Promise<WalletRouterExecution>;
}

export type WalletRouterErrorCode =
  | "INVALID_PARAMS"
  | "UNSUPPORTED_CHAIN"
  | "UNSUPPORTED_SUBACTION"
  | "AMBIGUOUS_CHAIN"
  | "DRY_RUN_UNSUPPORTED"
  | "SIMULATION_UNSUPPORTED"
  | "EXECUTION_FAILED";

export interface WalletRouterFailure {
  readonly ok: false;
  readonly error: WalletRouterErrorCode;
  readonly detail: string;
  readonly candidates?: readonly WalletChainHandlerMetadata[];
}

export interface WalletRouterSuccess {
  readonly ok: true;
  readonly result: WalletRouterExecution;
  readonly handler: WalletChainHandlerMetadata;
}

export type WalletRouterResult = WalletRouterSuccess | WalletRouterFailure;

const optionalString = z
  .union([z.string(), z.number()])
  .optional()
  .nullable()
  .transform((value) => {
    if (value === null || value === undefined) return undefined;
    const out = String(value).trim();
    return out.length > 0 ? out : undefined;
  });

const optionalPositiveAmount = optionalString.refine(
  (value) => {
    if (value === undefined) return true;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0;
  },
  { message: "amount must be a positive number" },
);

const optionalStringArray = z.preprocess((value) => {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return undefined;
}, z.array(z.string()).optional());

export const WalletRouterParamsSchema = z.object({
  subaction: z.enum(WALLET_ROUTER_SUBACTIONS),
  chain: optionalString,
  toChain: optionalString,
  fromToken: optionalString,
  toToken: optionalString,
  amount: optionalPositiveAmount,
  recipient: optionalString,
  slippageBps: z.coerce.number().int().min(0).max(10_000).optional(),
  mode: z.enum(WALLET_ROUTER_MODES).default("prepare"),
  dryRun: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (
          normalized === "true" ||
          normalized === "1" ||
          normalized === "yes"
        ) {
          return true;
        }
        if (
          normalized === "false" ||
          normalized === "0" ||
          normalized === "no"
        ) {
          return false;
        }
      }
      return value;
    }, z.boolean())
    .default(false),
  op: z.enum(WALLET_GOV_OPS).optional(),
  governor: optionalString,
  proposalId: optionalString,
  support: z.coerce.number().int().min(0).max(2).optional(),
  targets: optionalStringArray,
  values: optionalStringArray,
  calldatas: optionalStringArray,
  description: optionalString,
});

export function parseWalletRouterParams(input: unknown): WalletRouterParams {
  return WalletRouterParamsSchema.parse(input) as WalletRouterParams;
}

export function isWalletRouterSubaction(
  value: unknown,
): value is WalletRouterSubaction {
  return (
    typeof value === "string" &&
    WALLET_ROUTER_SUBACTIONS.includes(value as WalletRouterSubaction)
  );
}

export function normalizeWalletChainKey(value: string | number): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}
