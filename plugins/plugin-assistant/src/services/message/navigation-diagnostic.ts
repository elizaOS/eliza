import type { PlannedReplyClaimKind } from "./egress-policy.ts";

/** Opt-in operational projection into the existing logger for one exact turn.
 * No transport, storage, timer, inference or retry. Trusted settings must name
 * the existing owner, room and next message before dispatch. No default capture. */
type Row = Record<string, unknown>;
type ExactScope = {
  agentId: string;
  roomId: string;
  entityId: string;
  messageId: string;
  expiresAt: number;
};
type NextScope = {
  mode: "next-client-chat";
  agentId: string;
  roomId: string;
  entityId: string;
  notBefore: number;
  expiresAt: number;
};
type Scope = ExactScope | NextScope;
type Runtime = {
  agentId?: unknown;
  getSetting(name: string): unknown;
  logger?: {
    info?: (data: { src: string; projection: string }, message: string) => void;
  };
};
type Message = {
  id?: unknown;
  agentId?: unknown;
  roomId?: unknown;
  entityId?: unknown;
  createdAt?: unknown;
  content?: { source?: unknown; chatIdempotency?: unknown };
};
export const NAVIGATION_DIAGNOSTIC_SETTING = "NAVIGATION_DIAGNOSTIC_SCOPE";
// Compile-time completeness against the actual owning egress union. Type-only
// import avoids a runtime cycle with the instrumented egress caller.
const claimKinds = {
  completed_side_effect: true,
  financial_completion: true,
  financial_holding: true,
  stated_time: true,
  view_navigation: true,
  empty_tracked_state: true,
} satisfies Record<PlannedReplyClaimKind, true>;
const validationKinds = [
  ...Object.keys(claimKinds),
  "missing_internal_reply",
  "missing_reply",
  "unresolved_proof",
  "other",
];
const phases = new Set(["stage1", "prepared", "egress", "recovery", "failure"]);
const codes = new Set([
  "PROVIDER_ERROR",
  "REPLY_GROUNDING_FAILED",
  "PROVIDER_CONTEXT_OVERFLOW",
  "RATE_LIMIT",
  "TIMEOUT",
  "AUTH",
  "OTHER",
]);
const id = (v: unknown) =>
  typeof v === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(v) ? v : undefined;
const row = (v: unknown): Row =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};
const pick = (v: unknown, values: string[]) =>
  typeof v === "string" && values.includes(v) ? v : undefined;
const prose = (v: unknown) =>
  typeof v === "string" && v.length <= 512 ? v : undefined;
const finite = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
const budgets = new WeakMap<
  object,
  {
    key: string;
    messageId: string;
    expiresAt: number;
    seen: Set<string>;
    bytes: number;
  }
>();
export function navigationDiagnosticProjection(
  phase: string,
  input: unknown,
): Row | undefined {
  if (!phases.has(phase)) return;
  const value = row(input),
    visual = row(value.visualContinuation),
    binding = row(value.navigationBinding);
  return {
    phase,
    ...(phase === "stage1"
      ? {
          visualContinuation: {
            disposition: pick(visual.disposition, [
              "direct",
              "planning",
              "optional",
              "none",
              "forbidden",
              "unresolved",
            ]),
            viewId: id(visual.viewId),
          },
          intents:
            Array.isArray(value.intents) && value.intents.length <= 4
              ? value.intents.map(prose).filter((v) => v !== undefined)
              : undefined,
          replyEffectStatus: pick(value.replyEffectStatus, [
            "pending",
            "applied",
            "non_applied",
            "unknown",
          ]),
          replyText: prose(value.replyText),
        }
      : {}),
    ...(phase === "prepared"
      ? {
          actionName: id(value.actionName),
          success:
            typeof value.success === "boolean" ? value.success : undefined,
          status: pick(value.status, [
            "prepared",
            "delivered",
            "failed",
            "accepted",
          ]),
          navigationBinding: Object.fromEntries(
            [
              "requestId",
              "clientId",
              "viewId",
              "viewType",
              "installationId",
            ].map((k) => [k, id(binding[k])]),
          ),
        }
      : {}),
    ...(phase === "egress" || phase === "recovery"
      ? {
          verdict: pick(value.verdict, ["allow", "reject"]),
          validation: pick(value.validation, validationKinds),
          replyPresent:
            typeof value.replyPresent === "boolean"
              ? value.replyPresent
              : undefined,
        }
      : {}),
    ...(phase === "failure" || phase === "recovery"
      ? {
          errorFamily:
            typeof value.errorCode === "string"
              ? codes.has(value.errorCode)
                ? value.errorCode
                : "OTHER"
              : undefined,
        }
      : {}),
    checks: Object.fromEntries(
      [
        "pending",
        "prosePresent",
        "preparedBindingValid",
        "destinationMatched",
        "egressAllowed",
      ]
        .filter((k) => typeof row(value.checks)[k] === "boolean")
        .map((k) => [k, row(value.checks)[k]]),
    ),
    usage: {
      inputTokens: finite(row(value.usage).inputTokens),
      outputTokens: finite(row(value.usage).outputTokens),
      latencyMs: finite(row(value.usage).latencyMs),
    },
  };
}
export function emitNavigationDiagnostic(
  runtime: Runtime,
  message: Message,
  phase: string,
  input: () => unknown,
): boolean {
  try {
    const raw = runtime.getSetting(NAVIGATION_DIAGNOSTIC_SETTING);
    if (typeof raw !== "string" || raw.length > 2048) return false;
    const scope = row(JSON.parse(raw)) as unknown as Scope,
      now = Date.now();
    const next = "mode" in scope && scope.mode === "next-client-chat";
    const keys = next
      ? "agentId,entityId,expiresAt,mode,notBefore,roomId"
      : "agentId,entityId,expiresAt,messageId,roomId";
    if (
      Object.keys(scope).sort().join(",") !== keys ||
      ![scope.agentId, scope.entityId, scope.roomId].every(id) ||
      !Number.isFinite(scope.expiresAt) ||
      scope.expiresAt <= now ||
      scope.expiresAt > now + 300000 ||
      scope.agentId !== runtime.agentId ||
      message.agentId !== scope.agentId ||
      message.entityId !== scope.entityId ||
      message.roomId !== scope.roomId ||
      message.entityId === runtime.agentId ||
      message.content?.source !== "client_chat"
    )
      return false;
    if (next) {
      // createdAt is host-created by createMessageMemory, not renderer metadata.
      // Durable replay is resolved before this pipeline; a stored completed marker
      // independently refuses binding. No transcript/date heuristic supplies age.
      const recent = scope as NextScope,
        marker = row(message.content.chatIdempotency);
      if (
        !Number.isSafeInteger(recent.notBefore) ||
        recent.notBefore > now ||
        scope.expiresAt - recent.notBefore > 300000 ||
        scope.expiresAt <= recent.notBefore ||
        !Number.isSafeInteger(message.createdAt) ||
        Number(message.createdAt) < recent.notBefore ||
        Number(message.createdAt) > now ||
        !id(message.id) ||
        marker.outcomeJson !== undefined ||
        marker.replyRecoveryJson !== undefined
      )
        return false;
    } else if (
      !id((scope as ExactScope).messageId) ||
      message.id !== (scope as ExactScope).messageId
    )
      return false;
    const key = JSON.stringify(scope);
    let budget = budgets.get(runtime);
    // A synchronous first stage1 admission binds one actual host-created message.
    // No await/callback/property projection runs between checking and binding it.
    if (budget && (budget.key !== key || budget.messageId !== message.id))
      return false;
    if (!budget) {
      if (next && phase !== "stage1") return false;
      budget = {
        key,
        messageId: String(message.id),
        expiresAt: scope.expiresAt,
        seen: new Set(),
        bytes: 0,
      };
      budgets.set(runtime, budget);
    }
    if (
      now >= budget.expiresAt ||
      budget.seen.has(phase) ||
      budget.seen.size >= 5
    )
      return false;
    const projection = navigationDiagnosticProjection(phase, input());
    if (!projection) return false;
    const text = JSON.stringify({
      type: "navigation_diagnostic",
      timestamp: now,
      agentId: scope.agentId,
      roomId: scope.roomId,
      entityId: scope.entityId,
      messageId: budget.messageId,
      ...projection,
    });
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > 4096 || budget.bytes + bytes > 16384) return false;
    // Account before logger dispatch: throwing loggers cannot trigger replay.
    budget.seen.add(phase);
    budget.bytes += bytes;
    runtime.logger?.info?.(
      { src: "navigation-diagnostic", projection: text },
      "Navigation operational projection",
    );
    return true;
  } catch {
    return false;
  }
}
