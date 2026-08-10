/**
 * Shared constants, config resolution and result envelopes for the TaskMarket
 * plugin: the `TASKMARKET_*` identifiers, the contexts the actions route under,
 * the spend-guard config (`allowTaskCreation`, `maxTaskRewardUsdc`) resolved from
 * runtime settings, and the `success`/`failure` `ActionResult` builders every
 * handler returns. One place so all layers agree on names and envelopes.
 */
import type {
  ActionResult,
  IAgentRuntime,
  ProviderDataRecord,
} from "@elizaos/core";

export const TASKMARKET_LOG_PREFIX = "[TaskMarket]";

export const TASKMARKET_CONTEXTS = ["work", "crypto", "automation"] as const;

/** Default TaskMarket API root. The `/api` suffix is mandatory — every path 404s without it. */
export const DEFAULT_TASKMARKET_API_URL = "https://api.taskmarket.dev/api";

/**
 * Default ceiling, in whole USDC, for a single created task. Deliberately low:
 * creating a task escrows real funds on Base, so an integrator that flips
 * creation on without setting a ceiling still cannot fund anything expensive.
 */
export const DEFAULT_MAX_TASK_REWARD_USDC = 1;

/** Hard ceiling regardless of configuration, so a typo'd setting cannot unbound the spend. */
export const ABSOLUTE_MAX_TASK_REWARD_USDC = 50;

/** Bytes read from an API response before the body is rejected as oversized. */
export const TASKMARKET_MAX_RESPONSE_BYTES = 512 * 1024;

/** Task descriptions run 2-10 KB; list output truncates so a board listing cannot flood the planner. */
export const TASKMARKET_LIST_DESCRIPTION_CHARS = 400;

/** Full single-task descriptions are still bounded before entering the context window. */
export const TASKMARKET_DETAIL_DESCRIPTION_CHARS = 6_000;

export const TASKMARKET_REQUEST_TIMEOUT_MS = 20_000;

/** Atomic-unit scale for USDC (6 decimals). */
export const USDC_DECIMALS = 1_000_000;

export interface TaskMarketConfig {
  apiUrl: string;
  apiToken: string;
  /** Wallet address. Required: the bearer token does NOT identify the caller to the API. */
  address: string;
  /** Off by default. Task creation escrows real USDC and must be opted into explicitly. */
  allowTaskCreation: boolean;
  /** Per-call ceiling in whole USDC. An over-budget request is refused, never trimmed. */
  maxTaskRewardUsdc: number;
}

export type TaskMarketFailureReason =
  | "not_configured"
  | "creation_disabled"
  | "missing_param"
  | "invalid_param"
  | "over_budget"
  | "unconfirmed"
  | "confirmation_drift"
  | "cancelled"
  | "invalid_response"
  | "api_error"
  | "io_error";

export interface TaskMarketFailure {
  reason: TaskMarketFailureReason;
  message: string;
}

function readSetting(runtime: IAgentRuntime, name: string): string | undefined {
  const value = runtime.getSetting?.(name);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readBooleanSetting(runtime: IAgentRuntime, name: string): boolean {
  const raw = readSetting(runtime, name)?.toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

function readNumberSetting(
  runtime: IAgentRuntime,
  name: string,
): number | undefined {
  const raw = readSetting(runtime, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Resolve plugin configuration from runtime settings. Returns `undefined` when
 * the credentials every call needs are absent, so `validate` can hide the
 * actions entirely rather than exposing tools that always fail.
 */
export function resolveTaskMarketConfig(
  runtime: IAgentRuntime,
): TaskMarketConfig | undefined {
  const apiToken = readSetting(runtime, "TASKMARKET_API_TOKEN");
  const address = readSetting(runtime, "TASKMARKET_ADDRESS");
  if (!apiToken || !address) return undefined;

  const configuredMax = readNumberSetting(
    runtime,
    "TASKMARKET_MAX_TASK_REWARD_USDC",
  );
  const maxTaskRewardUsdc =
    configuredMax !== undefined && configuredMax > 0
      ? Math.min(configuredMax, ABSOLUTE_MAX_TASK_REWARD_USDC)
      : DEFAULT_MAX_TASK_REWARD_USDC;

  return {
    apiUrl:
      readSetting(runtime, "TASKMARKET_API_URL") ?? DEFAULT_TASKMARKET_API_URL,
    apiToken,
    address,
    allowTaskCreation: readBooleanSetting(
      runtime,
      "TASKMARKET_ALLOW_TASK_CREATION",
    ),
    maxTaskRewardUsdc,
  };
}

/**
 * Convert an atomic 6-decimal USDC amount to whole USDC. `"5000000"` -> `5`.
 *
 * Returns `undefined` — never `0` — for a missing or unparseable amount. A
 * healthy-looking zero on a money field is indistinguishable from a real zero
 * balance, so an absent value has to stay visibly absent.
 */
export function atomicToUsdc(
  atomic: string | number | undefined | null,
): number | undefined {
  if (atomic === undefined || atomic === null || atomic === "")
    return undefined;
  const parsed = typeof atomic === "number" ? atomic : Number(atomic);
  return Number.isFinite(parsed) ? parsed / USDC_DECIMALS : undefined;
}

/** Render an atomic amount for display, marking an unavailable value as such. */
export function formatUsdc(atomic: string | number | undefined | null): string {
  const value = atomicToUsdc(atomic);
  return value === undefined ? "n/a" : `$${value.toFixed(2)}`;
}

/**
 * Convert whole USDC to the atomic 6-decimal string the API expects.
 *
 * Returns `undefined` when the value cannot be represented in the supported
 * precision: anything under half a micro-USDC rounds to `"0"` atomic units, and
 * posting `"0"` while telling the user their reward was escrowed is a lie the
 * caller must not be able to tell. Callers validate before spending.
 */
export function usdcToAtomic(usdc: number): string | undefined {
  if (!Number.isFinite(usdc) || usdc <= 0) return undefined;
  const atomic = Math.round(usdc * USDC_DECIMALS);
  if (!Number.isSafeInteger(atomic) || atomic < 1) return undefined;
  return atomic.toString();
}

export function successActionResult(
  text: string,
  data?: ProviderDataRecord,
): ActionResult {
  return { success: true, text, ...(data ? { data } : {}) };
}

export function failureActionResult(
  failure: TaskMarketFailure,
  data?: ProviderDataRecord,
): ActionResult {
  return {
    success: false,
    text: `${TASKMARKET_LOG_PREFIX} ${failure.reason}: ${failure.message}`,
    data: { ...(data ?? {}), reason: failure.reason },
  };
}

export function readStringParam(
  options: unknown,
  name: string,
): string | undefined {
  if (!options || typeof options !== "object") return undefined;
  const value = (options as Record<string, unknown>)[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readNumberParam(
  options: unknown,
  name: string,
): number | undefined {
  if (!options || typeof options !== "object") return undefined;
  const value = (options as Record<string, unknown>)[name];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function readBooleanParam(
  options: unknown,
  name: string,
): boolean | undefined {
  if (!options || typeof options !== "object") return undefined;
  const value = (options as Record<string, unknown>)[name];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const raw = value.trim().toLowerCase();
    if (raw === "true" || raw === "yes" || raw === "1") return true;
    if (raw === "false" || raw === "no" || raw === "0") return false;
  }
  return undefined;
}
