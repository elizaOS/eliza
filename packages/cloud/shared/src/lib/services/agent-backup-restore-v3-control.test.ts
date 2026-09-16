/**
 * Deterministically exercises the restore-v3 cancellation, owned settlement,
 * cleanup deadline, and detached-failure reporting contract with deferred
 * promises and bounded timers; no provider, database, route, or runtime is used.
 */

import { describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import {
  AgentBackupRestoreV3ControlError,
  type AgentBackupRestoreV3DetachedFailureEvent,
  createAgentBackupRestoreV3Control,
} from "./agent-backup-restore-v3-control";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const ignoreDetachedFailure = (_event: Readonly<AgentBackupRestoreV3DetachedFailureEvent>): void =>
  undefined;

function detachedFailureCollector(): {
  readonly events: AgentBackupRestoreV3DetachedFailureEvent[];
  readonly observed: Deferred<void>;
  readonly report: (event: Readonly<AgentBackupRestoreV3DetachedFailureEvent>) => void;
} {
  const events: AgentBackupRestoreV3DetachedFailureEvent[] = [];
  const observed = deferred<void>();
  return {
    events,
    observed,
    report(event) {
      events.push(event);
      observed.resolve();
    },
  };
}

describe("createAgentBackupRestoreV3Control", () => {
  test("uses fatal structured control errors and requires a detached reporter", () => {
    const cause = new Error("synthetic cause");
    const failure = new AgentBackupRestoreV3ControlError(
      "AGENT_BACKUP_RESTORE_V3_SYNTHETIC",
      "Synthetic control failure",
      { cause, context: { label: "Synthetic boundary" } },
    );
    expect(failure).toBeInstanceOf(ElizaError);
    expect(failure).toMatchObject({
      code: "AGENT_BACKUP_RESTORE_V3_SYNTHETIC",
      context: { label: "Synthetic boundary" },
      severity: "fatal",
      cause,
    });

    const invalidInput = {
      signal: new AbortController().signal,
      deadlineEpochMs: Date.now() + 1_000,
      reportDetachedFailure: undefined,
    } as unknown as Parameters<typeof createAgentBackupRestoreV3Control>[0];
    expect(() => createAgentBackupRestoreV3Control(invalidInput)).toThrow(
      AgentBackupRestoreV3ControlError,
    );
    expect(() => createAgentBackupRestoreV3Control(invalidInput)).toThrow(
      "requires an explicit detached-failure reporter",
    );
  });

  test("cancels a wait and disposes its late value on a fresh cleanup control", async () => {
    const caller = new AbortController();
    const late = deferred<{ id: string }>();
    const operationStarted = deferred<void>();
    const disposed = deferred<void>();
    const control = createAgentBackupRestoreV3Control({
      signal: caller.signal,
      deadlineEpochMs: Date.now() + 1_000,
      cleanupDeadlineMs: 100,
      reportDetachedFailure: ignoreDetachedFailure,
    });
    let cleanupSignal: AbortSignal | undefined;

    try {
      const waiting = control.wait(
        "Synthetic acquisition",
        () => {
          operationStarted.resolve();
          return late.promise;
        },
        (value, cleanupControl) => {
          expect(value).toEqual({ id: "late-resource" });
          cleanupSignal = cleanupControl.signal;
          disposed.resolve();
        },
      );
      await operationStarted.promise;
      const reason = new Error("caller cancelled");
      caller.abort(reason);
      await expect(waiting).rejects.toBeInstanceOf(AgentBackupRestoreV3ControlError);
      await expect(waiting).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_ABORTED",
        severity: "fatal",
      });
      late.resolve({ id: "late-resource" });
      await disposed.promise;
      expect(cleanupSignal).toBeInstanceOf(AbortSignal);
      expect(cleanupSignal).not.toBe(control.signal);
      expect(cleanupSignal?.aborted).toBe(false);
    } finally {
      control.close();
    }
  });

  test("reports the exact detached operation rejection after interruption", async () => {
    const caller = new AbortController();
    const late = deferred<string>();
    const operationStarted = deferred<void>();
    const failures = detachedFailureCollector();
    const control = createAgentBackupRestoreV3Control({
      signal: caller.signal,
      deadlineEpochMs: Date.now() + 1_000,
      reportDetachedFailure: failures.report,
    });

    try {
      const waiting = control.wait("Deferred provider read", () => {
        operationStarted.resolve();
        return late.promise;
      });
      await operationStarted.promise;
      caller.abort(new Error("cancel provider read"));
      await expect(waiting).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_ABORTED",
      });

      late.reject(new Error("provider rejected after cancellation"));
      await failures.observed.promise;
      expect(failures.events).toEqual([
        {
          label: "Deferred provider read",
          phase: "operation-settlement",
          error: {
            name: "AgentBackupRestoreV3ControlError",
            code: "AGENT_BACKUP_RESTORE_V3_OPERATION_SETTLEMENT_FAILED",
            message: "Restore-v3 operation rejected after interruption",
            severity: "fatal",
          },
        },
      ]);
      expect(Object.isFrozen(failures.events[0])).toBe(true);
      expect(Object.isFrozen(failures.events[0]?.error)).toBe(true);
    } finally {
      control.close();
    }
  });

  test("reports late-value cleanup failure without serializing the late value", async () => {
    const caller = new AbortController();
    const late = deferred<{
      key: string;
      dek: string;
      handle: string;
      ciphertext: string;
    }>();
    const operationStarted = deferred<void>();
    const failures = detachedFailureCollector();
    const control = createAgentBackupRestoreV3Control({
      signal: caller.signal,
      deadlineEpochMs: Date.now() + 1_000,
      cleanupDeadlineMs: 100,
      reportDetachedFailure: failures.report,
    });

    try {
      const waiting = control.wait(
        "Deferred sensitive acquisition",
        () => {
          operationStarted.resolve();
          return late.promise;
        },
        () => Promise.reject(new Error("key dek handle ciphertext must never enter the event")),
      );
      await operationStarted.promise;
      caller.abort(new Error("cancel sensitive acquisition"));
      await expect(waiting).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_ABORTED",
      });

      late.resolve({
        key: "secret-key",
        dek: "secret-dek",
        handle: "secret-handle",
        ciphertext: "secret-ciphertext",
      });
      await failures.observed.promise;
      expect(failures.events).toEqual([
        {
          label: "Deferred sensitive acquisition",
          phase: "late-value-cleanup",
          error: {
            name: "AgentBackupRestoreV3ControlError",
            code: "AGENT_BACKUP_RESTORE_V3_LATE_VALUE_CLEANUP_FAILED",
            message: "Restore-v3 late-value cleanup failed",
            severity: "fatal",
          },
        },
      ]);
      const serialized = JSON.stringify(failures.events[0]).toLowerCase();
      for (const forbidden of ["key", "dek", "handle", "ciphertext"]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      control.close();
    }
  });

  test("runs cleanup after primary cancellation and bounds it independently", async () => {
    const caller = new AbortController();
    const control = createAgentBackupRestoreV3Control({
      signal: caller.signal,
      deadlineEpochMs: Date.now() + 1_000,
      cleanupDeadlineMs: 15,
      reportDetachedFailure: ignoreDetachedFailure,
    });

    try {
      caller.abort(new Error("primary cancelled"));
      const fresh = await control.cleanup("Synthetic rollback", (cleanupControl) => ({
        primaryAborted: control.signal.aborted,
        cleanupAborted: cleanupControl.signal.aborted,
      }));
      expect(fresh).toEqual({ primaryAborted: true, cleanupAborted: false });

      let cleanupSignal: AbortSignal | undefined;
      const cleanup = control.cleanup("Stuck rollback", (cleanupControl) => {
        cleanupSignal = cleanupControl.signal;
        return new Promise<never>(() => undefined);
      });
      await expect(cleanup).rejects.toBeInstanceOf(AgentBackupRestoreV3ControlError);
      await expect(cleanup).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_CLEANUP_DEADLINE_EXCEEDED",
        severity: "fatal",
      });
      expect(cleanupSignal?.aborted).toBe(true);
      expect(cleanupSignal).not.toBe(control.signal);
    } finally {
      control.close();
    }
  });

  test("reports a cleanup rejection that settles after its timeout", async () => {
    const caller = new AbortController();
    const lateCleanup = deferred<void>();
    const cleanupStarted = deferred<void>();
    const failures = detachedFailureCollector();
    const control = createAgentBackupRestoreV3Control({
      signal: caller.signal,
      deadlineEpochMs: Date.now() + 1_000,
      cleanupDeadlineMs: 10,
      reportDetachedFailure: failures.report,
    });

    try {
      const cleanup = control.cleanup("Deferred rollback", () => {
        cleanupStarted.resolve();
        return lateCleanup.promise;
      });
      await cleanupStarted.promise;
      await expect(cleanup).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_CLEANUP_DEADLINE_EXCEEDED",
      });

      lateCleanup.reject(new Error("rollback rejected after timeout"));
      await failures.observed.promise;
      expect(failures.events).toEqual([
        {
          label: "Deferred rollback",
          phase: "cleanup-settlement",
          error: {
            name: "AgentBackupRestoreV3ControlError",
            code: "AGENT_BACKUP_RESTORE_V3_CLEANUP_SETTLEMENT_FAILED",
            message: "Restore-v3 cleanup rejected after its deadline",
            severity: "fatal",
          },
        },
      ]);
    } finally {
      control.close();
    }
  });

  test("contains a rejecting reporter without changing the primary interruption", async () => {
    const caller = new AbortController();
    const operation = deferred<void>();
    const operationStarted = deferred<void>();
    const reporterCalled = deferred<void>();
    const control = createAgentBackupRestoreV3Control({
      signal: caller.signal,
      deadlineEpochMs: Date.now() + 1_000,
      reportDetachedFailure: () => {
        reporterCalled.resolve();
        return Promise.reject(new Error("synthetic reporter rejection"));
      },
    });

    try {
      const waiting = control.wait("Reporter isolation", () => {
        operationStarted.resolve();
        return operation.promise;
      });
      await operationStarted.promise;
      const abortCause = new Error("authoritative caller cancellation");
      caller.abort(abortCause);
      const primaryFailure = control.signal.reason;
      await expect(waiting).rejects.toBe(primaryFailure);
      expect(primaryFailure).toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_ABORTED",
        cause: abortCause,
      });

      operation.reject(new Error("late provider rejection"));
      await reporterCalled.promise;
      await Promise.resolve();
      expect(control.signal.reason).toBe(primaryFailure);
    } finally {
      control.close();
    }
  });

  test("settle joins an owned operation before giving cancellation priority", async () => {
    const caller = new AbortController();
    const operation = deferred<string>();
    const operationStarted = deferred<void>();
    const control = createAgentBackupRestoreV3Control({
      signal: caller.signal,
      deadlineEpochMs: Date.now() + 1_000,
      reportDetachedFailure: ignoreDetachedFailure,
    });
    let settled = false;

    try {
      const settlement = control.settle("Owned key callback", () => {
        operationStarted.resolve();
        return operation.promise;
      });
      void settlement.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await operationStarted.promise;
      caller.abort(new Error("cancel owned key callback"));
      await Promise.resolve();
      expect(settled).toBe(false);

      operation.resolve("completed");
      await expect(settlement).rejects.toBe(control.signal.reason);
      expect(settled).toBe(true);
    } finally {
      control.close();
    }
  });

  test("fails closed when the injected absolute deadline has elapsed", () => {
    const caller = new AbortController();
    let nowEpochMs = 1_000;
    const control = createAgentBackupRestoreV3Control({
      signal: caller.signal,
      deadlineEpochMs: 2_000,
      now: () => nowEpochMs,
      reportDetachedFailure: ignoreDetachedFailure,
    });

    try {
      nowEpochMs = 2_000;
      expect(() => control.assertActive("Synthetic boundary")).toThrow(
        "Synthetic boundary exceeded the restore-v3 deadline",
      );
      expect(control.signal.aborted).toBe(true);
      expect((control.signal.reason as AgentBackupRestoreV3ControlError).code).toBe(
        "AGENT_BACKUP_RESTORE_V3_DEADLINE_EXCEEDED",
      );
    } finally {
      control.close();
    }
  });

  test("does not start a queued effect after synchronous cancellation", async () => {
    const caller = new AbortController();
    const control = createAgentBackupRestoreV3Control({
      signal: caller.signal,
      deadlineEpochMs: Date.now() + 1_000,
      reportDetachedFailure: ignoreDetachedFailure,
    });
    let operationCount = 0;

    try {
      const waiting = control.wait("Queued provider effect", () => {
        operationCount += 1;
        return "started";
      });
      caller.abort(new Error("cancel before microtask"));
      await expect(waiting).rejects.toMatchObject({
        code: "AGENT_BACKUP_RESTORE_V3_ABORTED",
      });
      expect(operationCount).toBe(0);
    } finally {
      control.close();
    }
  });
});
