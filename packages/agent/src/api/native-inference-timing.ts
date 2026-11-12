/** Last native owner turn only; status reads never query logs or the global timing registry. */
import {
  buildInferenceFlowBreakdown,
  type IAgentRuntime,
  type InferenceFlowStage,
  type InferenceTurnSummary,
  isInferenceTraceId,
  resolveOwnerEntityIdOrDefault,
} from "@elizaos/core";

export interface NativeInferenceTiming {
  version: 1;
  traceId?: string;
  totalMs: number | null;
  timeToFirstVisibleMs: number | null;
  timeToReplyMs: number | null;
  timeToResponseFinalizedMs: number | null;
  stages: {
    stage: InferenceFlowStage;
    totalMs: number;
    toFirstVisibleMs: number | null;
  }[];
}

type Binding = { owner: string; revision: string };
const latest = new WeakMap<
  IAgentRuntime,
  Binding & { timing?: NativeInferenceTiming }
>();

function binding(runtime: IAgentRuntime): Binding | undefined {
  // The native host rotates this existing retirement token on account/provider
  // changes. Hosts without that contract do not expose a native timing row.
  const revision =
    runtime.getSetting("ELIZA_HOST_CONTEXT_REVISION") ??
    process.env.ELIZA_HOST_CONTEXT_REVISION;
  if (typeof revision !== "string" || !revision || revision.length > 256)
    return;
  return { owner: resolveOwnerEntityIdOrDefault(runtime), revision };
}

function milliseconds(value: number | null): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(Math.round(value)) &&
    value >= 0
    ? Math.round(value)
    : null;
}

/** Capture authority before generation, then observe its existing host timer. */
export function captureNativeInferenceTiming(
  runtime: IAgentRuntime,
  sender: string,
): ((summary: InferenceTurnSummary) => void) | undefined {
  try {
    const captured = binding(runtime);
    if (!captured || captured.owner !== sender) return;
    const entry = {
      ...captured,
      timing: undefined as NativeInferenceTiming | undefined,
    };
    latest.set(runtime, entry);
    return (summary) => {
      try {
        if (latest.get(runtime) !== entry || entry.timing) return;
        const current = binding(runtime);
        if (
          current?.owner !== captured.owner ||
          current?.revision !== captured.revision
        )
          return;
        const flow = buildInferenceFlowBreakdown(summary);
        const traceId = summary.traceId;
        const stages = flow.stages.map((stage) => {
          const totalMs = milliseconds(stage.totalMs);
          if (totalMs === null) throw new Error("Invalid inference timing");
          return {
            stage: stage.stage,
            totalMs,
            toFirstVisibleMs: milliseconds(stage.toFirstVisibleMs),
          };
        });
        entry.timing = {
          version: 1,
          ...(isInferenceTraceId(traceId) && traceId !== "0".repeat(32)
            ? { traceId }
            : {}),
          totalMs: milliseconds(flow.totalMs),
          timeToFirstVisibleMs: milliseconds(flow.timeToFirstVisibleMs),
          timeToReplyMs: milliseconds(summary.timeToReplyMs),
          timeToResponseFinalizedMs: milliseconds(
            summary.timeToResponseFinalizedMs,
          ),
          stages,
        };
      } catch {
        // error-policy:J7 Optional diagnostics cannot replace a delivered result or its error.
        if (latest.get(runtime) === entry) latest.delete(runtime);
      }
    };
  } catch {
    // error-policy:J7 Unavailable host diagnostics do not alter generation.
    return;
  }
}

export function readNativeInferenceTiming(
  runtime: IAgentRuntime,
): NativeInferenceTiming | undefined {
  try {
    const entry = latest.get(runtime);
    const current = binding(runtime);
    if (
      !entry ||
      current?.owner !== entry.owner ||
      current?.revision !== entry.revision
    ) {
      latest.delete(runtime);
      return;
    }
    return entry.timing ? structuredClone(entry.timing) : undefined;
  } catch {
    // error-policy:J7 Status remains usable when optional diagnostics fail.
    latest.delete(runtime);
    return;
  }
}
