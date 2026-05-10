/**
 * CompletionCheckRegistry. Built-in kinds:
 *   - `user_acknowledged`
 *   - `user_replied_within { lookbackMinutes, requireSinceTaskFired }`
 *   - `subject_updated`
 *   - `health_signal_observed { signalKind, lookbackMinutes, requireSinceTaskFired }`
 *
 * Each check returns a boolean — `true` means the runner moves the task
 * to `completed` (and fires `pipeline.onComplete`).
 */

import type {
  CompletionCheckContext,
  CompletionCheckContribution,
  ScheduledTask,
} from "./types.js";

interface UserRepliedWithinParams {
  lookbackMinutes?: number;
  /** When true, only inbounds since the most recent fire count. Default true. */
  requireSinceTaskFired?: boolean;
}

interface HealthSignalObservedParams {
  signalKind: string;
  lookbackMinutes?: number;
  requireSinceTaskFired?: boolean;
}

function paramsForCheck<T>(task: ScheduledTask, kind: string): T | undefined {
  if (task.completionCheck?.kind === kind) {
    return task.completionCheck.params as T | undefined;
  }
  return undefined;
}

function isoMinusMinutes(iso: string, minutes: number): string {
  const t = new Date(iso).getTime();
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
  return new Date(t - safeMinutes * 60_000).toISOString();
}

function resolveSinceIso(
  context: CompletionCheckContext,
  lookbackMinutes: number | undefined,
  requireSinceTaskFired: boolean,
): string {
  const firedAt = context.task.state.firedAt;
  if (requireSinceTaskFired && firedAt) {
    return firedAt;
  }
  const minutes = Number.isFinite(lookbackMinutes) ? Number(lookbackMinutes) : 60;
  return isoMinusMinutes(context.nowIso, minutes);
}

const userAcknowledgedCheck: CompletionCheckContribution = {
  kind: "user_acknowledged",
  shouldComplete(_task, context): boolean {
    return context.acknowledged === true;
  },
};

const userRepliedWithinCheck: CompletionCheckContribution = {
  kind: "user_replied_within",
  shouldComplete(task, context): boolean {
    const params = paramsForCheck<UserRepliedWithinParams>(
      task,
      "user_replied_within",
    );
    const lookback = params?.lookbackMinutes;
    const requireSince = params?.requireSinceTaskFired !== false;
    if (!context.repliedSinceFiredAt?.atIso) {
      return false;
    }
    const sinceIso = resolveSinceIso(context, lookback, requireSince);
    return (
      new Date(context.repliedSinceFiredAt.atIso).getTime() >=
      new Date(sinceIso).getTime()
    );
  },
};

const subjectUpdatedCheck: CompletionCheckContribution = {
  kind: "subject_updated",
  async shouldComplete(task, context): Promise<boolean> {
    if (!task.subject) return false;
    const params = paramsForCheck<{
      lookbackMinutes?: number;
      requireSinceTaskFired?: boolean;
    }>(task, "subject_updated");
    const lookback = params?.lookbackMinutes;
    const requireSince = params?.requireSinceTaskFired !== false;
    const sinceIso = resolveSinceIso(context, lookback, requireSince);
    const updated = await context.subjectStore.wasUpdatedSince({
      subject: task.subject,
      sinceIso,
    });
    return updated === true;
  },
};

const healthSignalObservedCheck: CompletionCheckContribution = {
  kind: "health_signal_observed",
  async shouldComplete(task, context): Promise<boolean> {
    const params = paramsForCheck<HealthSignalObservedParams>(
      task,
      "health_signal_observed",
    );
    if (!params || typeof params.signalKind !== "string") {
      return false;
    }
    const requireSince = params.requireSinceTaskFired !== false;
    const sinceIso = resolveSinceIso(context, params.lookbackMinutes, requireSince);
    const observed = await context.activity.hasSignalSince({
      signalKind: params.signalKind,
      sinceIso,
      subject: task.subject,
    });
    return observed === true;
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface CompletionCheckRegistry {
  register(c: CompletionCheckContribution): void;
  get(kind: string): CompletionCheckContribution | null;
  list(): CompletionCheckContribution[];
}

export function createCompletionCheckRegistry(): CompletionCheckRegistry {
  const map = new Map<string, CompletionCheckContribution>();
  return {
    register(c) {
      if (!c.kind || typeof c.kind !== "string") {
        throw new Error("CompletionCheckRegistry.register: kind required");
      }
      if (map.has(c.kind)) {
        throw new Error(
          `CompletionCheckRegistry.register: duplicate kind "${c.kind}"`,
        );
      }
      map.set(c.kind, c);
    },
    get(kind) {
      return map.get(kind) ?? null;
    },
    list() {
      return Array.from(map.values());
    },
  };
}

export function registerBuiltInCompletionChecks(
  reg: CompletionCheckRegistry,
): void {
  reg.register(userAcknowledgedCheck);
  reg.register(userRepliedWithinCheck);
  reg.register(subjectUpdatedCheck);
  reg.register(healthSignalObservedCheck);
}
