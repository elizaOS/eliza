/**
 * Owns the single cancellation/deadline fence for one restore-v3 execution.
 * Late values are always observed and may be disposed on a fresh bounded
 * cleanup control that never inherits the already-aborted operation signal.
 */

import {
  AGENT_BACKUP_CAPTURE_V2_LIMITS,
  type AgentBackupRestoreV3OperationControl as AgentBackupRestoreV3OperationControlContract,
} from "@elizaos/shared";

export const AGENT_BACKUP_RESTORE_V3_CLEANUP_DEADLINE_MS = 5_000;
const MAX_TIMER_MS = 2_147_483_647;

export class AgentBackupRestoreV3ControlError extends Error {
  override readonly name = "AgentBackupRestoreV3ControlError";

  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface CreateAgentBackupRestoreV3ControlInput {
  readonly signal: AbortSignal;
  readonly deadlineEpochMs: number;
  /** Injected only for deterministic boundary tests. */
  readonly now?: () => number;
  readonly cleanupDeadlineMs?: number;
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
): AgentBackupRestoreV3ControlError {
  return new AgentBackupRestoreV3ControlError(code, message, { cause });
}

function requireClock(now: () => number): number {
  const nowEpochMs = now();
  if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < 0 || Object.is(nowEpochMs, -0)) {
    throw controlError(
      "AGENT_BACKUP_RESTORE_V3_CLOCK_INVALID",
      "Restore-v3 requires a canonical millisecond clock",
    );
  }
  return nowEpochMs;
}

function requireTimeout(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw controlError(
      "AGENT_BACKUP_RESTORE_V3_DEADLINE_INVALID",
      `${field} must be an integer from 1 through ${maximum}`,
    );
  }
  return value;
}

function observeLateFailure(pending: PromiseLike<unknown>): void {
  void Promise.resolve(pending).catch((_lateFailure: unknown) => undefined);
}

/** Create one owned restore control; callers must invoke `close()` in finally. */
export function createAgentBackupRestoreV3Control(
  input: Readonly<CreateAgentBackupRestoreV3ControlInput>,
): AgentBackupRestoreV3Control {
  if (!(input?.signal instanceof AbortSignal)) {
    throw controlError(
      "AGENT_BACKUP_RESTORE_V3_CONTROL_INVALID",
      "Restore-v3 requires an explicit AbortSignal",
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
    );
  }

  const controller = new AbortController();
  const abortFromCaller = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(
        controlError(
          "AGENT_BACKUP_RESTORE_V3_ABORTED",
          "Restore-v3 was cancelled",
          input.signal.reason,
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
          ),
        );
      }
    },
    Math.min(input.deadlineEpochMs - nowEpochMs, MAX_TIMER_MS),
  );

  const abortError = (label: string): AgentBackupRestoreV3ControlError => {
    const reason = controller.signal.reason;
    if (reason instanceof AgentBackupRestoreV3ControlError) return reason;
    return controlError("AGENT_BACKUP_RESTORE_V3_ABORTED", `${label} was cancelled`, reason);
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
        return await Promise.race([pending, interruption]);
      } catch (cause) {
        if (interrupted) {
          void pending.then(
            (lateValue) => {
              if (!onLateValue) return;
              observeLateFailure(
                runtime.cleanup(`${label} late-value cleanup`, (cleanupControl) =>
                  onLateValue(lateValue, cleanupControl),
                ),
              );
            },
            (_lateFailure: unknown) => undefined,
          );
        }
        throw cause;
      } finally {
        if (abortListener) controller.signal.removeEventListener("abort", abortListener);
      }
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
          );
          cleanupController.abort(failure);
          reject(failure);
        }, boundedTimeoutMs);
      });
      try {
        return await Promise.race([pending, interruption]);
      } catch (cause) {
        if (cleanupController.signal.aborted) observeLateFailure(pending);
        throw cause;
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
