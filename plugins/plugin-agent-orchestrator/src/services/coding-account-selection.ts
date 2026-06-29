/**
 * Orchestrator-side reader for the coding-agent account-selector bridge.
 *
 * The bridge itself lives in `@elizaos/app-core` (it owns the `AccountPool` and
 * the credential store). This plugin depends only on `@elizaos/core`, so — like
 * the parent-context bridge — it reads the contract off a `globalThis` symbol
 * rather than importing app-core. When no pool/accounts are configured the
 * bridge is absent and every helper here no-ops, leaving the single-account
 * behavior untouched.
 */

const CODING_AGENT_SELECTOR_BRIDGE_SYMBOL: unique symbol = Symbol.for(
  "eliza.account-pool.coding-agent.v1",
);

export type CodingAccountStrategy =
  | "priority"
  | "round-robin"
  | "least-used"
  | "quota-aware";

export interface CodingAccountUsage {
  sessionPct?: number;
  weeklyPct?: number;
  resetsAt?: number;
  refreshedAt: number;
}

/** A selected account plus the env vars the coding subprocess needs. */
export interface CodingAccountSelection {
  providerId: string;
  accountId: string;
  label: string;
  source: "oauth" | "api-key";
  strategy: string;
  usage?: CodingAccountUsage;
  /** Secrets — injected into the spawn env, never persisted to the task store. */
  envPatch: Record<string, string>;
}

export interface CodingProviderAvailability {
  providerId: string;
  total: number;
  enabled: number;
  healthy: number;
}

interface CodingAgentSelectorBridge {
  describe(): Record<string, CodingProviderAvailability[]>;
  select(
    agentType: string,
    opts?: {
      sessionKey?: string;
      strategy?: CodingAccountStrategy;
      exclude?: string[];
    },
  ): Promise<CodingAccountSelection | null>;
  markRateLimited(
    providerId: string,
    accountId: string,
    untilMs: number,
    detail?: string,
  ): Promise<void>;
  markNeedsReauth(
    providerId: string,
    accountId: string,
    detail?: string,
  ): Promise<void>;
  recordUsage(
    providerId: string,
    accountId: string,
    result: {
      tokens?: number;
      ok: boolean;
      model?: string;
      latencyMs?: number;
    },
  ): Promise<void>;
}

/** Non-secret account descriptor stamped onto the session record. */
export interface CodingAccountMeta {
  providerId: string;
  accountId: string;
  label: string;
  source: string;
  strategy: string;
}

export interface ResolvedCodingAccount {
  selection: CodingAccountSelection;
  meta: CodingAccountMeta;
}

/**
 * Agent types that authenticate per pooled account. claude and codex are
 * first-party CLIs; opencode pool-rotates across `cerebras-api` accounts (the
 * one backend it resolves from a pooled key — its injected CEREBRAS_API_KEY is
 * read by buildOpencodeSpawnConfig). elizaos/pi-agent authenticate through their
 * own backend, and z.ai/Kimi/GLM have no first-party coding CLI. Keep this in
 * sync with the app-core bridge's AGENT_PROVIDER_CANDIDATES.
 */
const MULTI_ACCOUNT_AGENT_TYPES = new Set(["claude", "codex", "opencode"]);

export function isMultiAccountAgentType(agentType: string): boolean {
  return MULTI_ACCOUNT_AGENT_TYPES.has(agentType.toLowerCase());
}

export function getCodingAccountBridge(): CodingAgentSelectorBridge | null {
  if (typeof globalThis === "undefined") return null;
  const bridge = (globalThis as Record<symbol, unknown>)[
    CODING_AGENT_SELECTOR_BRIDGE_SYMBOL
  ];
  return (bridge as CodingAgentSelectorBridge | undefined) ?? null;
}

export function resolveCodingAccountStrategy(
  raw: string | undefined,
): CodingAccountStrategy | undefined {
  const value = raw?.trim().toLowerCase();
  if (
    value === "priority" ||
    value === "round-robin" ||
    value === "least-used" ||
    value === "quota-aware"
  ) {
    return value;
  }
  return undefined;
}

function toMeta(selection: CodingAccountSelection): CodingAccountMeta {
  return {
    providerId: selection.providerId,
    accountId: selection.accountId,
    label: selection.label,
    source: selection.source,
    strategy: selection.strategy,
  };
}

/**
 * Pick an account for a coding sub-agent. Returns null (single-account
 * fallback) when the bridge is absent, the agent type is not multi-account, or
 * no eligible account exists. Never throws.
 */
export async function selectCodingAccount(
  agentType: string,
  opts: {
    sessionKey?: string;
    strategy?: CodingAccountStrategy;
    exclude?: string[];
  } = {},
): Promise<ResolvedCodingAccount | null> {
  if (!isMultiAccountAgentType(agentType)) return null;
  const bridge = getCodingAccountBridge();
  if (!bridge) return null;
  let selection: CodingAccountSelection | null = null;
  try {
    selection = await bridge.select(agentType, opts);
  } catch {
    return null;
  }
  if (!selection) return null;
  return { selection, meta: toMeta(selection) };
}

/**
 * Per-agent-type readiness verdict: how many healthy pooled accounts back this
 * coding agent vs. how many the requested posture needs.
 */
export interface CodingProviderReadiness {
  agentType: string;
  total: number;
  enabled: number;
  healthy: number;
  required: number;
  ok: boolean;
}

/** The pool's readiness for live coding work, with loud-failure detail. */
export interface CodingAccountReadiness {
  ready: boolean;
  /** True when ≥2 healthy accounts per provider are required (local rotation). */
  rotation: boolean;
  /** Healthy accounts required per agent type (1 normally, 2 for rotation). */
  required: number;
  providers: CodingProviderReadiness[];
  /** Human-readable reasons the pool is not ready (empty when ready). */
  problems: string[];
}

/** The agent types the live multi-account orchestrator depends on. */
export const READINESS_REQUIRED_AGENT_TYPES = ["claude", "codex"] as const;

/**
 * Pure: assess whether the account pool has enough healthy accounts to run the
 * multi-account coding orchestrator. The orchestrator's per-spawn
 * `selectCodingAccount` silently falls back to single-account when the pool is
 * thin (the correct runtime behavior — a degraded pool must not hard-fail a
 * spawn). This function is the loud counterpart: a CI/ops gate that asserts
 * ≥1 healthy Codex AND ≥1 healthy Claude (≥2 each with `rotation`) so a
 * misconfigured pool is caught explicitly instead of degrading invisibly.
 */
export function assessCodingAccountReadiness(
  availability: Record<string, CodingProviderAvailability[]>,
  opts: { rotation?: boolean; agentTypes?: readonly string[] } = {},
): CodingAccountReadiness {
  const rotation = opts.rotation ?? false;
  const required = rotation ? 2 : 1;
  const agentTypes = opts.agentTypes ?? READINESS_REQUIRED_AGENT_TYPES;
  const providers: CodingProviderReadiness[] = [];
  const problems: string[] = [];
  for (const agentType of agentTypes) {
    const rows = availability[agentType] ?? [];
    const total = rows.reduce((sum, r) => sum + r.total, 0);
    const enabled = rows.reduce((sum, r) => sum + r.enabled, 0);
    const healthy = rows.reduce((sum, r) => sum + r.healthy, 0);
    const ok = healthy >= required;
    providers.push({ agentType, total, enabled, healthy, required, ok });
    if (!ok) {
      problems.push(
        `${agentType}: ${healthy} healthy account(s), need >= ${required}` +
          (total === 0 ? " (none connected)" : ` (${total} connected)`),
      );
    }
  }
  return {
    ready: problems.length === 0,
    rotation,
    required,
    providers,
    problems,
  };
}

/** Read the account descriptor previously stamped onto a session's metadata. */
export function accountMetaFromSessionMetadata(
  metadata: Record<string, unknown> | undefined,
): CodingAccountMeta | null {
  const account = metadata?.account;
  if (!account || typeof account !== "object") return null;
  const a = account as Record<string, unknown>;
  if (typeof a.providerId !== "string" || typeof a.accountId !== "string") {
    return null;
  }
  return {
    providerId: a.providerId,
    accountId: a.accountId,
    label: typeof a.label === "string" ? a.label : a.accountId,
    source: typeof a.source === "string" ? a.source : "oauth",
    strategy: typeof a.strategy === "string" ? a.strategy : "least-used",
  };
}
