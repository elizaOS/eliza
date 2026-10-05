/**
 * Adapts dossier admission to the canonical scheduled-task mutation and store
 * boundaries. Server ingress supplies principal identity and receive time;
 * Automatic day consumption is returned to the runner for its atomic claim;
 * this adapter never dispatches work or commits that consumption separately.
 */
import { ElizaError, stableStringify } from "@elizaos/core";
import type {
  OwnerFactsView,
  ScheduledTask,
  ScheduledTaskAutomaticAdmission,
  ScheduledTaskAutomaticFirePolicy,
  ScheduledTaskMutationPolicy,
  ScheduledTaskStore,
} from "@elizaos/plugin-scheduling";
import { resolveDefaultTimeZone } from "../defaults.js";
import {
  isLegacyManagedDossierDefault,
  reconcileOwnerDossierActivity,
} from "./dossier-activity-migration.js";
import {
  admitDossierActivity,
  consumeDossierActivity,
  DOSSIER_ACTIVITY_ANCHOR_KEY,
  DOSSIER_ACTIVITY_METADATA_KEY,
  type DossierActivityState,
  type DossierDay,
  isManagedDossierTask,
  readDossierActivityState,
  resolveDossierActivityAnchor,
  type TrustedDossierActivity,
  updateDossierActivityControl,
} from "./dossier-activity-policy.js";

export type { TrustedDossierActivity } from "./dossier-activity-policy.js";

/** Admission rejects disabled managed automation; manual refresh bypasses this hook. */
export const admitDossierAutomaticExecution: ScheduledTaskAutomaticAdmission =
  ({ task }) => {
    if (!isManagedDossierTask(task)) return { kind: "admitted" };
    const state = readDossierActivityState(task.metadata);
    if (!state) {
      if (!hasActivityAnchor(task) && !isLegacyManagedDossierDefault(task))
        return { kind: "admitted" };
      return { kind: "denied", reason: "dossier_migration_required" };
    }
    if (!state.enabled) {
      return { kind: "denied", reason: "dossier_automation_disabled" };
    }
    return { kind: "admitted" };
  };

/** The runner commits this proposal with the automatic occurrence's claim. */
export const prepareDossierAutomaticFire: ScheduledTaskAutomaticFirePolicy = ({
  task,
  nowIso,
}) => {
  const state = readDossierActivityState(task.metadata);
  if (!state) {
    if (hasActivityAnchor(task) || isLegacyManagedDossierDefault(task))
      invalidControl(
        "Dossier automatic fire is missing persisted control state",
      );
    return null;
  }
  if (!isManagedDossierTask(task) || !hasActivityAnchor(task)) {
    invalidControl(
      "Automatic dossier execution requires an enabled managed activity trigger",
    );
  }
  return {
    ...task.metadata,
    [DOSSIER_ACTIVITY_METADATA_KEY]: consumeDossierActivity(state, nowIso),
  };
};

function hasActivityAnchor(task: ScheduledTask): boolean {
  return (
    task.trigger.kind === "relative_to_anchor" &&
    task.trigger.anchorKey === DOSSIER_ACTIVITY_ANCHOR_KEY &&
    task.trigger.offsetMinutes === 0
  );
}

function invalidControl(message: string): never {
  throw new ElizaError(message, { code: "DOSSIER_ACTIVITY_CONTROL_INVALID" });
}

/** The runner supplies the clock instant; absent owner timezone uses the canonical deployment default. */
export function createDossierActivityMutationPolicy(options: {
  ownerFacts: () => OwnerFactsView | Promise<OwnerFactsView>;
  boundaryMinutes?: number;
  fallbackTimezone?: () => string;
}): ScheduledTaskMutationPolicy {
  return async ({ previous, proposed, nowIso }) => {
    const metadata = { ...proposed.metadata };
    const key = DOSSIER_ACTIVITY_METADATA_KEY;
    const prior = readDossierActivityState(previous?.metadata);
    if (
      Object.hasOwn(proposed.metadata ?? {}, key) &&
      (!prior ||
        stableStringify(proposed.metadata?.[key]) !== stableStringify(prior))
    ) {
      throw new ElizaError("Dossier activity metadata is server-owned", {
        code: "DOSSIER_ACTIVITY_METADATA_READ_ONLY",
      });
    }
    if (
      prior &&
      (previous?.idempotencyKey !== proposed.idempotencyKey ||
        previous?.source !== proposed.source ||
        !isManagedDossierTask(proposed))
    ) {
      invalidControl("A managed dossier's identity cannot be changed");
    }
    const activityAnchor = hasActivityAnchor(proposed);
    if (!prior && !activityAnchor) return null;
    if (!isManagedDossierTask(proposed)) {
      invalidControl(
        "The dossier activity anchor requires a recognized managed task",
      );
    }
    if (!activityAnchor && proposed.trigger.kind !== "manual") {
      invalidControl(
        "A migrated dossier supports activity admission or manual pause only",
      );
    }
    const facts = await options.ownerFacts();
    const state = updateDossierActivityControl({
      previous,
      next: proposed,
      nowIso,
      day: {
        timezone:
          facts.timezone ??
          (options.fallbackTimezone ?? resolveDefaultTimeZone)(),
        boundaryMinutes: options.boundaryMinutes ?? 240,
      },
    });
    if (!state)
      invalidControl(
        "Managed dossier mutation did not produce admission state",
      );
    return { ...proposed, metadata: { ...metadata, [key]: state } };
  };
}

export type DossierActivityAdmissionResult =
  | { kind: "admitted"; taskId: string; atIso: string; dayKey: string }
  | {
      kind: "not_admitted";
      reason:
        | "untrusted_activity"
        | "no_managed_task"
        | "disabled"
        | "ineligible_activity";
    };

type DossierTaskSelection =
  | { task: ScheduledTask; state: DossierActivityState }
  | { reason: "no_managed_task" | "disabled" };

function selectOwnerDossierTask(tasks: ScheduledTask[]): DossierTaskSelection {
  const managed = tasks.filter(isManagedDossierTask);
  const migrated = managed.flatMap((task) => {
    const state = readDossierActivityState(task.metadata);
    if (!state) {
      if (hasActivityAnchor(task))
        invalidControl(
          "Dossier activity task is missing persisted control state",
        );
      return [];
    }
    if (!hasActivityAnchor(task) && task.trigger.kind !== "manual") {
      invalidControl("Persisted dossier control has an unsupported trigger");
    }
    return [{ task, state }];
  });
  if (migrated.length === 0) return { reason: "no_managed_task" };
  const eligible = migrated.filter(
    ({ task, state }) =>
      hasActivityAnchor(task) &&
      state.enabled &&
      task.state.status !== "dismissed",
  );
  if (eligible.length > 1) {
    throw new ElizaError(
      "Multiple managed dossiers can admit owner activity; reconcile the managed defaults",
      {
        code: "DOSSIER_ACTIVITY_TASK_AMBIGUOUS",
        context: { taskIds: eligible.map(({ task }) => task.taskId) },
      },
    );
  }
  const selected = eligible[0];
  if (!selected) return { reason: "disabled" };
  return selected;
}

/** Resolve only persisted activity; ambiguity and malformed controls remain explicit errors. */
export async function resolveOwnerDossierActivityAnchor(
  store: ScheduledTaskStore,
  nowIso: string,
): Promise<{ atIso: string } | null> {
  const selected = selectOwnerDossierTask(await store.list());
  if ("reason" in selected) return null;
  const atIso = resolveDossierActivityAnchor(selected.state, nowIso);
  return atIso === null ? null : { atIso };
}

/** Commit one first-activity proposal; a losing caller must re-read rather than report admission. */
export async function admitOwnerDossierActivity(
  store: ScheduledTaskStore,
  activity: TrustedDossierActivity,
  day?: DossierDay,
): Promise<DossierActivityAdmissionResult> {
  if (
    !activity.authenticated ||
    !activity.principalId ||
    activity.principalId !== activity.ownerPrincipalId ||
    activity.kind === "other"
  ) {
    return { kind: "not_admitted", reason: "untrusted_activity" };
  }
  const reconciled = day
    ? await reconcileOwnerDossierActivity(store, {
        nowIso: activity.receivedAtIso,
        day,
      })
    : null;
  if (reconciled && reconciled.deferred.length > 0) {
    throw new ElizaError(
      "Dossier delivery must be reconciled before admitting new owner activity",
      {
        code: "DOSSIER_ACTIVITY_DELIVERY_UNRESOLVED",
        context: { taskIds: reconciled.deferred.map(({ taskId }) => taskId) },
      },
    );
  }
  const selected = selectOwnerDossierTask(
    reconciled?.tasks ?? (await store.list()),
  );
  if ("reason" in selected)
    return { kind: "not_admitted", reason: selected.reason };
  const { task, state } = selected;
  const next = admitDossierActivity(state, activity);
  if (next === state)
    return { kind: "not_admitted", reason: "ineligible_activity" };
  if (!next.admitted)
    invalidControl("Dossier admission did not produce an anchor");
  const committed = await store.upsertIfStatus(
    {
      ...task,
      metadata: { ...task.metadata, [DOSSIER_ACTIVITY_METADATA_KEY]: next },
    },
    {
      expectedStatus: task.state.status,
      expectedState: task.state,
      expectedMetadata: task.metadata ?? {},
      expectedDefinition: task,
      nextFireAtIso: next.admitted.atIso,
    },
  );
  if (!committed) {
    throw new ElizaError(
      "Dossier changed while admitting activity; retry against the latest task state",
      {
        code: "DOSSIER_ACTIVITY_ADMISSION_RACED",
        context: { taskId: task.taskId, retryable: true },
      },
    );
  }
  return {
    kind: "admitted",
    taskId: task.taskId,
    atIso: next.admitted.atIso,
    dayKey: next.admitted.dayKey,
  };
}
