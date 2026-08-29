import { describe, expect, test } from "bun:test";
import {
  AgentBackupRestoreV3ControlError,
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

async function captureFailure(operation: PromiseLike<unknown>): Promise<unknown> {
  try {
    await operation;
    throw new Error("Expected operation to fail");
  } catch (cause) {
    return cause;
  }
}

describe("createAgentBackupRestoreV3Control", () => {
  test("cancels a wait and disposes its late value on a fresh cleanup control", async () => {
    const caller = new AbortController();
    const late = deferred<{ id: string }>();
    const operationStarted = deferred<void>();
    const disposed = deferred<void>();
    const control = createAgentBackupRestoreV3Control({
      signal: caller.signal,
      deadlineEpochMs: Date.now() + 1_000,
      cleanupDeadlineMs: 100,
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
      const failure = await captureFailure(waiting);

      expect(failure).toBeInstanceOf(AgentBackupRestoreV3ControlError);
      expect((failure as AgentBackupRestoreV3ControlError).code).toBe(
        "AGENT_BACKUP_RESTORE_V3_ABORTED",
      );
      late.resolve({ id: "late-resource" });
      await disposed.promise;
      expect(cleanupSignal).toBeInstanceOf(AbortSignal);
      expect(cleanupSignal).not.toBe(control.signal);
      expect(cleanupSignal?.aborted).toBe(false);
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
    });

    try {
      caller.abort(new Error("primary cancelled"));
      const fresh = await control.cleanup("Synthetic rollback", (cleanupControl) => ({
        primaryAborted: control.signal.aborted,
        cleanupAborted: cleanupControl.signal.aborted,
      }));
      expect(fresh).toEqual({ primaryAborted: true, cleanupAborted: false });

      let cleanupSignal: AbortSignal | undefined;
      const failure = await captureFailure(
        control.cleanup("Stuck rollback", (cleanupControl) => {
          cleanupSignal = cleanupControl.signal;
          return new Promise<never>(() => undefined);
        }),
      );
      expect(failure).toBeInstanceOf(AgentBackupRestoreV3ControlError);
      expect((failure as AgentBackupRestoreV3ControlError).code).toBe(
        "AGENT_BACKUP_RESTORE_V3_CLEANUP_DEADLINE_EXCEEDED",
      );
      expect(cleanupSignal?.aborted).toBe(true);
      expect(cleanupSignal).not.toBe(control.signal);
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
