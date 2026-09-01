/**
 * Owns the single cancellation/deadline fence for one restore-v3 execution.
 * Late values are always observed and may be disposed on a fresh bounded
 * cleanup control that never inherits the already-aborted operation signal;
 * detached rejection metadata is logged and reported without the late value.
 * Owned effects may instead join real settlement before cancellation wins.
 */

import { ElizaError } from "@elizaos/core";
import {
  AGENT_BACKUP_CAPTURE_V2_LIMITS,
  type AgentBackupRestoreV3OperationControl as AgentBackupRestoreV3OperationControlContract,
} from "@elizaos/shared";
import { logger } from "../utils/logger";

export const AGENT_BACKUP_RESTORE_V3_CLEANUP_DEADLINE_MS = 5_000;
const MAX_TIMER_MS = 2_147_483_647;

export class AgentBackupRestoreV3ControlError extends ElizaError {
  override readonly name = "AgentBackupRestoreV3ControlError";

  constructor(
    code: string,
    message: string,
    options: {
      cause?: unknown;
      context?: Record<string, unknown>;
    } = {},
  ) {
    super(message, {
      code,
      cause: options.cause,
      context: options.context,
      severity: "fatal",
    });
  }
}

export type AgentBackupRestoreV3DetachedFailurePhase =
  | "operation-settlement"
  | "late-value-cleanup"
  | "cleanup-settlement";

export interface AgentBackupRestoreV3DetachedFailureError {
  readonly name: "AgentBackupRestoreV3ControlError";
  readonly code: string;
  readonly message: string;
  readonly severity: "fatal";
}

export interface AgentBackupRestoreV3DetachedFailureEvent {
  readonly label: string;
  readonly phase: AgentBackupRestoreV3DetachedFailurePhase;
  readonly error: Readonly<AgentBackupRestoreV3DetachedFailureError>;
}

export interface CreateAgentBackupRestoreV3ControlInput {
  readonly signal: AbortSignal;
  readonly deadlineEpochMs: number;
  /** Injected only for deterministic boundary tests. */
  readonly now?: () => number;
  readonly cleanupDeadlineMs?: number;
  readonly reportDetachedFailure: (
    event: Readonly<AgentBackupRestoreV3DetachedFailureEvent>,
  ) => void | PromiseLike<void>;
}

export interface AgentBackupRestoreV3Control extends AgentBackupRestoreV3OperationControlContract {
  assertActive(label?: string): void;
  wait<T>(
    label: string,
    operation: () => T | PromiseLike<T>,
    onLateValue?: (
      value: T,
      cleanupControl: Readonly<AgentBackupRestoreV3OperationControlContract>,
    ) => void | PromiseLike<void>,
  ): Promise<T>;
  /**
   * Joins an owned effect to its real settlement. Cancellation never detaches
   * the effect; it only takes precedence over a successful result afterward.
   */
  settle<T>(label: string, operation: () => T | PromiseLike<T>): Promise<T>;
  /**
   * Runs rollback/release against a new signal and a short absolute deadline.
   * It remains usable after this operation's signal has been cancelled.
   */
  cleanup<T>(
    label: string,
    operation: (
      control: Readonly<AgentBackupRestoreV3OperationControlContract>,
    ) => T | PromiseLike<T>,
    timeoutMs?: number,
  ): Promise<T>;
  close(): void;
}

function controlError(
  code: string,
  message: string,
  cause?: unknown,
  context: Record<string, unknown> = {},
): AgentBackupRestoreV3ControlError {
  return new AgentBackupRestoreV3ControlError(code, message, {
    cause,
    context: { subsystem: "agent-backup-restore-v3-control", ...context },
  });
}

function requireClock(now: () => number): number {
  const nowEpochMs = now();
  if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < 0 || Object.is(nowEpochMs, -0)) {
    throw controlError(
      "AGENT_BACKUP_RESTORE_V3_CLOCK_INVALID",
      "Restore-v3 requires a canonical millisecond clock",
      undefined,
      { field: "clock" },
    );
  }
  return nowEpochMs;
}

function requireTimeout(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw controlError(
      "AGENT_BACKUP_RESTORE_V3_DEADLINE_INVALID",
      `${field} must be an integer from 1 through ${maximum}`,
      undefined,
      { field, maximum },
    );
  }
  return value;
}

function detachedFailureCode(phase: AgentBackupRestoreV3DetachedFailurePhase): string {
  switch (phase) {
    case "operation-settlement":
      return "AGENT_BACKUP_RESTORE_V3_OPERATION_SETTLEMENT_FAILED";
    case "late-value-cleanup":
      return "AGENT_BACKUP_RESTORE_V3_LATE_VALUE_CLEANUP_FAILED";
    case "cleanup-settlement":
      return "AGENT_BACKUP_RESTORE_V3_CLEANUP_SETTLEMENT_FAILED";
  }
}

function detachedFailureMessage(phase: AgentBackupRestoreV3DetachedFailurePhase): string {
  switch (phase) {
    case "operation-settlement":
      return "Restore-v3 operation rejected after interruption";
    case "late-value-cleanup":
      return "Restore-v3 late-value cleanup failed";
    case "cleanup-settlement":
      return "Restore-v3 cleanup rejected after its deadline";
  }
}

function normalizeDetachedFailure(
  label: string,
  phase: AgentBackupRestoreV3DetachedFailurePhase,
  cause: unknown,
): Readonly<AgentBackupRestoreV3DetachedFailureError> {
  const failure = controlError(detachedFailureCode(phase), detachedFailureMessage(phase), cause, {
    label,
    phase,
  });
  return normalizedControlError(failure);
}

function normalizedControlError(
  failure: AgentBackupRestoreV3ControlError,
): Readonly<AgentBackupRestoreV3DetachedFailureError> {
  return Object.freeze({
    name: failure.name,
    code: failure.code,
    message: failure.message,
    severity: "fatal",
  });
}

/** Create one owned restore control; callers must invoke `close()` in finally. */
export function createAgentBackupRestoreV3Control(
  input: Readonly<CreateAgentBackupRestoreV3ControlInput>,
): AgentBackupRestoreV3Control {
  if (!(input?.signal instanceof AbortSignal)) {
    throw controlError(
      "AGENT_BACKUP_RESTORE_V3_CONTROL_INVALID",
      "Restore-v3 requires an explicit AbortSignal",
      undefined,
      { field: "signal" },
    );
  }
  if (typeof input.reportDetachedFailure !== "function") {
    throw controlError(
      "AGENT_BACKUP_RESTORE_V3_CONTROL_INVALID",
      "Restore-v3 requires an explicit detached-failure reporter",
      undefined,
      { field: "reportDetachedFailure" },
    );
  }
  const now = input.now ?? Date.now;
  const nowEpochMs = requireClock(now);
  if (
    !Number.isSafeInteger(input.deadlineEpochMs) ||
    input.deadlineEpochMs <= nowEpochMs ||
    input.deadlineEpochMs - nowEpochMs > AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDeadlineAheadMs
  ) {
    throw controlError(
      "AGENT_BACKUP_RESTORE_V3_DEADLINE_INVALID",
      "Restore-v3 deadline is expired or outside its supported window",
      undefined,
      { field: "deadlineEpochMs" },
    );
  }
  const cleanupDeadlineMs = requireTimeout(
    input.cleanupDeadlineMs ?? AGENT_BACKUP_RESTORE_V3_CLEANUP_DEADLINE_MS,
    "cleanupDeadlineMs",
    MAX_TIMER_MS,
  );
  if (input.signal.aborted) {
    throw controlError(
      "AGENT_BACKUP_RESTORE_V3_ABORTED",
      "Restore-v3 was cancelled before it started",
      input.signal.reason,
      { phase: "initialization" },
    );
  }

  const logReporterFailure = (
    label: string,
    phase: AgentBackupRestoreV3DetachedFailurePhase,
    cause: unknown,
  ): void => {
    const failure = controlError(
      "AGENT_BACKUP_RESTORE_V3_DETACHED_REPORTER_FAILED",
      "Restore-v3 detached-failure reporter failed",
      cause,
      { label, phase },
    );
    logger.error("[AgentBackupRestoreV3Control] detached-failure reporter failed", {
      label,
      phase,
      error: normalizedControlError(failure),
    });
  };

  const reportDetachedFailure = (
    label: string,
    phase: AgentBackupRestoreV3DetachedFailurePhase,
    cause: unknown,
  ): void => {
    const event = Object.freeze({
      label,
      phase,
      error: normalizeDetachedFailure(label, phase, cause),
    });
    logger.error("[AgentBackupRestoreV3Control] detached failure", event);
    let reporting: void | PromiseLike<void>;
    try {
      reporting = input.reportDetachedFailure(event);
    } catch (reporterCause) {
      // error-policy:J7 diagnostics must not replace the already-authoritative
      // interruption or cleanup deadline when the reporter throws synchronously.
      logReporterFailure(label, phase, reporterCause);
      return;
    }
    void Promise.resolve(reporting).catch((reporterCause) => {
      // error-policy:J7 diagnostics must not replace the already-authoritative
      // interruption or cleanup deadline when the reporter rejects asynchronously.
      logReporterFailure(label, phase, reporterCause);
    });
  };

  const observeDetachedRejection = (
    pending: PromiseLike<unknown>,
    label: string,
    phase: AgentBackupRestoreV3DetachedFailurePhase,
  ): void => {
    void Promise.resolve(pending).catch((cause) => {
      // error-policy:J6 the interruption or cleanup deadline remains primary;
      // this detached settlement is observed, logged, and reported for repair.
      reportDetachedFailure(label, phase, cause);
    });
  };

  const controller = new AbortController();
  const abortFromCaller = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(
        controlError(
          "AGENT_BACKUP_RESTORE_V3_ABORTED",
          "Restore-v3 was cancelled",
          input.signal.reason,
          { phase: "operation", source: "caller" },
        ),
      );
    }
  };
  input.signal.addEventListener("abort", abortFromCaller, { once: true });
  const deadlineTimer = setTimeout(
    () => {
      if (!controller.signal.aborted) {
        controller.abort(
          controlError(
            "AGENT_BACKUP_RESTORE_V3_DEADLINE_EXCEEDED",
            "Restore-v3 exceeded its absolute deadline",
            undefined,
            { phase: "operation" },
          ),
        );
      }
    },
    Math.min(input.deadlineEpochMs - nowEpochMs, MAX_TIMER_MS),
  );

  const abortError = (label: string): AgentBackupRestoreV3ControlError => {
    const reason = controller.signal.reason;
    if (reason instanceof AgentBackupRestoreV3ControlError) return reason;
    return controlError("AGENT_BACKUP_RESTORE_V3_ABORTED", `${label} was cancelled`, reason, {
      label,
      phase: "operation",
    });
  };

  const runtime: AgentBackupRestoreV3Control = {
    signal: controller.signal,
    deadlineEpochMs: input.deadlineEpochMs,

    assertActive(label = "Restore-v3 operation"): void {
      if (controller.signal.aborted) throw abortError(label);
      if (requireClock(now) >= input.deadlineEpochMs) {
        const failure = controlError(
          "AGENT_BACKUP_RESTORE_V3_DEADLINE_EXCEEDED",
          `${label} exceeded the restore-v3 deadline`,
          undefined,
          { label, phase: "operation" },
        );
        controller.abort(failure);
        throw failure;
      }
    },

    async wait<T>(
      label: string,
      operation: () => T | PromiseLike<T>,
      onLateValue?: (
        value: T,
        cleanupControl: Readonly<AgentBackupRestoreV3OperationControlContract>,
      ) => void | PromiseLike<void>,
    ): Promise<T> {
      runtime.assertActive(label);
      const pending = Promise.resolve().then(() => {
        // Cancellation may win after `wait()` returns but before this queued
        // effect starts. Re-check inside the exact microtask that invokes it.
        runtime.assertActive(label);
        return operation();
      });
      let interrupted = false;
      let abortListener: (() => void) | undefined;
      const interruption = new Promise<never>((_resolve, reject) => {
        abortListener = () => {
          interrupted = true;
          reject(abortError(label));
        };
        controller.signal.addEventListener("abort", abortListener, { once: true });
        if (controller.signal.aborted) abortListener();
      });
      try {
        return await Promise.race([pending, interruption]).then(
          (value) => value,
          (cause) => {
            if (interrupted) {
              void pending.then(
                (lateValue) => {
                  if (!onLateValue) return;
                  observeDetachedRejection(
                    runtime.cleanup(`${label} late-value cleanup`, (cleanupControl) =>
                      onLateValue(lateValue, cleanupControl),
                    ),
                    label,
                    "late-value-cleanup",
                  );
                },
                (lateFailure) => {
                  // error-policy:J6 the interruption remains authoritative;
                  // observe the operation's detached rejection for repair.
                  reportDetachedFailure(label, "operation-settlement", lateFailure);
                },
              );
            }
            throw cause;
          },
        );
      } finally {
        if (abortListener) controller.signal.removeEventListener("abort", abortListener);
      }
    },

    async settle<T>(label: string, operation: () => T | PromiseLike<T>): Promise<T> {
      runtime.assertActive(label);
      const value = await Promise.resolve().then(() => {
        runtime.assertActive(label);
        return operation();
      });
      runtime.assertActive(label);
      return value;
    },

    async cleanup<T>(
      label: string,
      operation: (
        control: Readonly<AgentBackupRestoreV3OperationControlContract>,
      ) => T | PromiseLike<T>,
      timeoutMs = cleanupDeadlineMs,
    ): Promise<T> {
      const boundedTimeoutMs = requireTimeout(timeoutMs, "cleanup timeout", MAX_TIMER_MS);
      const cleanupController = new AbortController();
      const cleanupDeadlineEpochMs = requireClock(now) + boundedTimeoutMs;
      if (!Number.isSafeInteger(cleanupDeadlineEpochMs)) {
        throw controlError(
          "AGENT_BACKUP_RESTORE_V3_CLOCK_INVALID",
          "Restore-v3 cleanup deadline exceeds the safe clock range",
          undefined,
          { label, phase: "cleanup" },
        );
      }
      const cleanupControl = Object.freeze({
        signal: cleanupController.signal,
        deadlineEpochMs: cleanupDeadlineEpochMs,
      });
      const pending = Promise.resolve().then(() => operation(cleanupControl));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const interruption = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const failure = controlError(
            "AGENT_BACKUP_RESTORE_V3_CLEANUP_DEADLINE_EXCEEDED",
            `${label} exceeded its independent cleanup deadline`,
            undefined,
            { label, phase: "cleanup" },
          );
          cleanupController.abort(failure);
          reject(failure);
        }, boundedTimeoutMs);
      });
      try {
        return await Promise.race([pending, interruption]).then(
          (value) => value,
          (cause) => {
            if (cleanupController.signal.aborted) {
              observeDetachedRejection(pending, label, "cleanup-settlement");
            }
            throw cause;
          },
        );
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },

    close(): void {
      clearTimeout(deadlineTimer);
      input.signal.removeEventListener("abort", abortFromCaller);
    },
  };

  return Object.freeze(runtime);
}
