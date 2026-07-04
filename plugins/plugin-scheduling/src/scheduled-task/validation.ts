/**
 * Structural validation for `ScheduledTask` shapes beyond the Zod route schema.
 *
 * Checks enum membership (kind / priority / source / subject / output
 * destination), field shapes, and the cross-field invariants that need the live
 * registries — that referenced gate / completion-check / escalation-ladder kinds
 * are registered — raising `ScheduledTaskValidationError` (a typed issue list)
 * on violation.
 */

import type { CompletionCheckRegistry } from "./completion-check-registry.js";
import type { EscalationLadderRegistry } from "./escalation.js";
import type { TaskGateRegistry } from "./gate-registry.js";
import {
  type ScheduledTask,
  type ScheduledTaskInput,
  type ScheduledTaskKind,
  type ScheduledTaskOutputDestination,
  type ScheduledTaskPriority,
  type ScheduledTaskRef,
  type ScheduledTaskSource,
  type ScheduledTaskSubjectKind,
  TASK_EXECUTION_PROFILES,
} from "./types.js";

export class ScheduledTaskValidationError extends Error {
  readonly code = "scheduled_task_validation_failed";

  constructor(
    readonly issues: string[],
    readonly path = "task",
  ) {
    super(`${path}: ${issues.join("; ")}`);
    this.name = "ScheduledTaskValidationError";
  }
}

export interface ScheduledTaskValidationDeps {
  gates: TaskGateRegistry;
  completionChecks: CompletionCheckRegistry;
  ladders: EscalationLadderRegistry;
}

const TERMINAL_STATES = new Set([
  "completed",
  "skipped",
  "expired",
  "failed",
  "dismissed",
]);

const TASK_KINDS = new Set<ScheduledTaskKind>([
  "reminder",
  "checkin",
  "followup",
  "approval",
  "recap",
  "watcher",
  "output",
  "custom",
]);

const TASK_PRIORITIES = new Set<ScheduledTaskPriority>([
  "low",
  "medium",
  "high",
]);

const TASK_SOURCES = new Set<ScheduledTaskSource>([
  "default_pack",
  "user_chat",
  "first_run",
  "plugin",
]);

const SUBJECT_KINDS = new Set<ScheduledTaskSubjectKind>([
  "entity",
  "relationship",
  "thread",
  "document",
  "calendar_event",
  "self",
]);

const OUTPUT_DESTINATIONS = new Set<ScheduledTaskOutputDestination>([
  "in_app_card",
  "channel",
  "apple_notes",
  "gmail_draft",
  "memory",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidIso(value: unknown): boolean {
  return isNonEmptyString(value) && !Number.isNaN(new Date(value).getTime());
}

function validateTrigger(
  trigger: Record<string, unknown>,
  path: string,
): string[] {
  const issues: string[] = [];
  switch (trigger.kind) {
    case "once":
      if (!isValidIso(trigger.atIso)) {
        issues.push(`${path}.trigger.atIso must be an ISO timestamp`);
      }
      break;
    case "cron":
      if (!isNonEmptyString(trigger.expression)) {
        issues.push(`${path}.trigger.expression must be a non-empty string`);
      }
      if (trigger.tz !== undefined && !isNonEmptyString(trigger.tz)) {
        issues.push(`${path}.trigger.tz must be a non-empty string`);
      }
      break;
    case "interval":
      if (!isPositiveInteger(trigger.everyMinutes)) {
        issues.push(`${path}.trigger.everyMinutes must be a positive integer`);
      }
      if (trigger.from !== undefined && !isValidIso(trigger.from)) {
        issues.push(`${path}.trigger.from must be an ISO timestamp`);
      }
      if (trigger.until !== undefined && !isValidIso(trigger.until)) {
        issues.push(`${path}.trigger.until must be an ISO timestamp`);
      }
      break;
    case "relative_to_anchor":
      if (!isNonEmptyString(trigger.anchorKey)) {
        issues.push(`${path}.trigger.anchorKey must be a non-empty string`);
      }
      if (
        typeof trigger.offsetMinutes !== "number" ||
        !Number.isInteger(trigger.offsetMinutes)
      ) {
        issues.push(`${path}.trigger.offsetMinutes must be an integer`);
      }
      break;
    case "during_window":
      if (!isNonEmptyString(trigger.windowKey)) {
        issues.push(`${path}.trigger.windowKey must be a non-empty string`);
      }
      break;
    case "event":
      if (!isNonEmptyString(trigger.eventKind)) {
        issues.push(`${path}.trigger.eventKind must be a non-empty string`);
      }
      break;
    case "manual":
      break;
    case "after_task":
      if (
        !isNonEmptyString(trigger.taskId) ||
        !TERMINAL_STATES.has(trigger.outcome as never)
      ) {
        issues.push(
          `${path}.trigger.after_task requires a non-empty taskId and terminal outcome`,
        );
      }
      break;
    default:
      issues.push(`${path}.trigger.kind is invalid`);
  }
  return issues;
}

function validateKnownGateParams(
  kind: string,
  params: unknown,
  path: string,
): string[] {
  if (params === undefined) return [];
  if (!isRecord(params)) return [`${path}.params must be an object`];
  switch (kind) {
    case "weekday_only": {
      const weekdays = params.weekdays;
      if (weekdays === undefined) return [];
      if (!Array.isArray(weekdays)) {
        return [`${path}.params.weekdays must be an array`];
      }
      return weekdays.every(
        (day) =>
          typeof day === "number" &&
          Number.isInteger(day) &&
          day >= 0 &&
          day <= 6,
      )
        ? []
        : [`${path}.params.weekdays must contain integers 0..6`];
    }
    case "late_evening_skip": {
      const afterHour = params.afterHour;
      if (afterHour === undefined) return [];
      return typeof afterHour === "number" &&
        Number.isInteger(afterHour) &&
        afterHour >= 0 &&
        afterHour <= 23
        ? []
        : [`${path}.params.afterHour must be an integer 0..23`];
    }
    case "quiet_hours": {
      const bypass = params.highPriorityBypass;
      if (bypass === undefined) return [];
      return typeof bypass === "boolean"
        ? []
        : [`${path}.params.highPriorityBypass must be boolean`];
    }
    case "personal_baseline_sufficient": {
      const minSamples = params.minSamples;
      if (minSamples === undefined) return [];
      return isPositiveInteger(minSamples) && minSamples <= 10_000
        ? []
        : [`${path}.params.minSamples must be an integer 1..10000`];
    }
    default:
      return [];
  }
}

function validateKnownCompletionParams(
  kind: string,
  params: unknown,
  path: string,
): string[] {
  if (params === undefined) return [];
  if (!isRecord(params)) return [`${path}.params must be an object`];
  const issues: string[] = [];
  const lookback = params.lookbackMinutes;
  const requireSince = params.requireSinceTaskFired;
  if (lookback !== undefined && !isPositiveInteger(lookback)) {
    issues.push(`${path}.params.lookbackMinutes must be a positive integer`);
  }
  if (requireSince !== undefined && typeof requireSince !== "boolean") {
    issues.push(`${path}.params.requireSinceTaskFired must be boolean`);
  }
  if (
    kind === "health_signal_observed" &&
    (typeof params.signalKind !== "string" ||
      params.signalKind.trim().length === 0)
  ) {
    issues.push(`${path}.params.signalKind must be a non-empty string`);
  }
  return issues;
}

function stripServerManaged(
  task: ScheduledTask,
): Omit<ScheduledTask, "taskId" | "state"> {
  const { taskId: _taskId, state: _state, ...rest } = task;
  return rest;
}

function validateTaskRef(
  ref: ScheduledTaskRef,
  deps: ScheduledTaskValidationDeps,
  path: string,
  depth: number,
  seen: WeakSet<object>,
): string[] {
  if (typeof ref === "string") {
    return ref.trim().length > 0 ? [] : [`${path} must be a non-empty task id`];
  }
  if (!isRecord(ref)) return [`${path} must be a task id or task input`];
  if (seen.has(ref)) return [`${path} must not contain a cyclic task ref`];
  const input =
    "taskId" in ref || "state" in ref
      ? stripServerManaged(ref as ScheduledTask)
      : (ref as ScheduledTaskInput);
  return validateScheduledTaskInput(input, deps, {
    path,
    depth: depth + 1,
    seen,
  });
}

export function validateScheduledTaskInput(
  input: ScheduledTaskInput,
  deps: ScheduledTaskValidationDeps,
  opts: { path?: string; depth?: number; seen?: WeakSet<object> } = {},
): string[] {
  const path = opts.path ?? "task";
  const depth = opts.depth ?? 0;
  const seen = opts.seen ?? new WeakSet<object>();
  const issues: string[] = [];

  if (depth > 8) {
    return [`${path}.pipeline nesting exceeds 8 levels`];
  }
  if (!isRecord(input)) {
    return [`${path} must be an object`];
  }
  if (seen.has(input)) {
    return [`${path} must not contain cyclic pipeline refs`];
  }
  seen.add(input);

  if (!TASK_KINDS.has(input.kind)) {
    issues.push(`${path}.kind is invalid`);
  }
  if (!isNonEmptyString(input.promptInstructions)) {
    issues.push(`${path}.promptInstructions must be a non-empty string`);
  }
  if (!TASK_PRIORITIES.has(input.priority)) {
    issues.push(`${path}.priority is invalid`);
  }
  if (!TASK_SOURCES.has(input.source)) {
    issues.push(`${path}.source is invalid`);
  }
  if (!isNonEmptyString(input.createdBy)) {
    issues.push(`${path}.createdBy must be a non-empty string`);
  }
  if (typeof input.ownerVisible !== "boolean") {
    issues.push(`${path}.ownerVisible must be boolean`);
  }
  if (typeof input.respectsGlobalPause !== "boolean") {
    issues.push(`${path}.respectsGlobalPause must be boolean`);
  }

  if (!input.trigger || !isRecord(input.trigger)) {
    issues.push(`${path}.trigger must be an object`);
  } else {
    issues.push(...validateTrigger(input.trigger, path));
  }

  if (input.subject !== undefined) {
    if (!isRecord(input.subject)) {
      issues.push(`${path}.subject must be an object`);
    } else {
      if (!SUBJECT_KINDS.has(input.subject.kind as never)) {
        issues.push(`${path}.subject.kind is invalid`);
      }
      if (!isNonEmptyString(input.subject.id)) {
        issues.push(`${path}.subject.id must be a non-empty string`);
      }
    }
  }

  if (
    input.idempotencyKey !== undefined &&
    !isNonEmptyString(input.idempotencyKey)
  ) {
    issues.push(`${path}.idempotencyKey must be a non-empty string`);
  }

  if (input.shouldFire !== undefined) {
    if (!isRecord(input.shouldFire)) {
      issues.push(`${path}.shouldFire must be an object`);
    } else {
      const { compose, gates } = input.shouldFire;
      if (
        compose !== undefined &&
        compose !== "all" &&
        compose !== "any" &&
        compose !== "first_deny"
      ) {
        issues.push(`${path}.shouldFire.compose is invalid`);
      }
      if (!Array.isArray(gates)) {
        issues.push(`${path}.shouldFire.gates must be an array`);
      } else {
        gates.forEach((gate, index) => {
          const gatePath = `${path}.shouldFire.gates[${index}]`;
          if (!isRecord(gate) || typeof gate.kind !== "string") {
            issues.push(`${gatePath}.kind must be a non-empty string`);
            return;
          }
          const kind = gate.kind.trim();
          if (!kind) {
            issues.push(`${gatePath}.kind must be a non-empty string`);
          } else if (!deps.gates.get(kind)) {
            issues.push(`${gatePath}.kind "${kind}" is not registered`);
          }
          issues.push(...validateKnownGateParams(kind, gate.params, gatePath));
        });
      }
    }
  }

  if (input.completionCheck !== undefined) {
    const check = input.completionCheck;
    if (!isRecord(check) || typeof check.kind !== "string") {
      issues.push(`${path}.completionCheck.kind must be a non-empty string`);
    } else {
      const kind = check.kind.trim();
      if (!kind) {
        issues.push(`${path}.completionCheck.kind must be a non-empty string`);
      } else if (!deps.completionChecks.get(kind)) {
        issues.push(`${path}.completionCheck.kind "${kind}" is not registered`);
      }
      if (
        check.followupAfterMinutes !== undefined &&
        !isPositiveInteger(check.followupAfterMinutes)
      ) {
        issues.push(
          `${path}.completionCheck.followupAfterMinutes must be a positive integer`,
        );
      }
      issues.push(
        ...validateKnownCompletionParams(
          kind,
          check.params,
          `${path}.completionCheck`,
        ),
      );
    }
  }

  if (input.escalation !== undefined) {
    if (!isRecord(input.escalation)) {
      issues.push(`${path}.escalation must be an object`);
    } else {
      const { ladderKey, steps } = input.escalation;
      if (
        ladderKey !== undefined &&
        (typeof ladderKey !== "string" || !deps.ladders.get(ladderKey))
      ) {
        issues.push(
          `${path}.escalation.ladderKey "${String(ladderKey)}" is not registered`,
        );
      }
      if (steps !== undefined) {
        if (!Array.isArray(steps)) {
          issues.push(`${path}.escalation.steps must be an array`);
        } else {
          steps.forEach((step, index) => {
            const stepPath = `${path}.escalation.steps[${index}]`;
            if (!isRecord(step)) {
              issues.push(`${stepPath} must be an object`);
              return;
            }
            if (!isNonNegativeInteger(step.delayMinutes)) {
              issues.push(
                `${stepPath}.delayMinutes must be a non-negative integer`,
              );
            }
            // Shape only. channelKey REGISTRATION is owned by the A11 check in
            // `runner.schedule()` (typed `ChannelKeyError` with the offending
            // key + registered set) — the same contract used at dispatch-time
            // channel resolve. Registration is a time-of-schedule property, so
            // nested pipeline children are checked when they are scheduled,
            // not against today's registry.
            if (
              typeof step.channelKey !== "string" ||
              step.channelKey.trim().length === 0
            ) {
              issues.push(`${stepPath}.channelKey must be a non-empty string`);
            }
            if (
              step.intensity !== undefined &&
              step.intensity !== "soft" &&
              step.intensity !== "normal" &&
              step.intensity !== "urgent"
            ) {
              issues.push(`${stepPath}.intensity is invalid`);
            }
          });
        }
      }
    }
  }

  if (input.output !== undefined) {
    if (!isRecord(input.output)) {
      issues.push(`${path}.output must be an object`);
    } else {
      if (!OUTPUT_DESTINATIONS.has(input.output.destination as never)) {
        issues.push(
          `${path}.output.destination "${String(input.output.destination)}" is invalid`,
        );
      }
      if (
        input.output.persistAs !== undefined &&
        input.output.persistAs !== "task_metadata" &&
        input.output.persistAs !== "external_only"
      ) {
        issues.push(`${path}.output.persistAs is invalid`);
      }
    }
  }

  if (
    input.executionProfile !== undefined &&
    !TASK_EXECUTION_PROFILES.includes(input.executionProfile)
  ) {
    issues.push(`${path}.executionProfile is invalid`);
  }

  if (input.pipeline !== undefined) {
    if (!isRecord(input.pipeline)) {
      issues.push(`${path}.pipeline must be an object`);
    } else {
      for (const key of ["onComplete", "onSkip", "onFail"] as const) {
        const refs = input.pipeline[key];
        if (refs === undefined) continue;
        if (!Array.isArray(refs)) {
          issues.push(`${path}.pipeline.${key} must be an array`);
          continue;
        }
        refs.forEach((ref, index) => {
          issues.push(
            ...validateTaskRef(
              ref,
              deps,
              `${path}.pipeline.${key}[${index}]`,
              depth,
              seen,
            ),
          );
        });
      }
    }
  }

  return issues;
}
