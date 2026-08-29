/** Abort/deadline control and late-settlement ownership for multipart I/O. */

import type { ObjectStorageLifecycleError } from "./object-store";
import {
  DEFAULT_MULTIPART_REQUEST_DURATION_MS,
  LATE_MULTIPART_CREATE_ABORT_MS,
  lifecycle,
  MAX_MULTIPART_REQUEST_DURATION_MS,
  type MultipartObjectRequestControl,
  type ProviderMultipartHandle,
  type QueuedOperation,
} from "./object-store-multipart-types";

export interface ProviderRequestContext {
  readonly signal: AbortSignal;
  ensureActive(): void;
  failure(): ObjectStorageLifecycleError;
  race<T>(request: Promise<T>, onLateResolve?: (value: T) => void | Promise<void>): Promise<T>;
  registerCleanup(cleanup: Promise<void>): void;
  waitForSettlements(): Promise<void>;
  dispose(): void;
}

export function createRequestContext(
  control: MultipartObjectRequestControl,
): ProviderRequestContext {
  if (typeof control?.registerLateSettlement !== "function") {
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_INVALID",
      "Multipart object upload requires a late-settlement registration hook",
    );
  }
  const now = Date.now();
  const suppliedDeadline = control.deadline?.getTime();
  if (suppliedDeadline !== undefined && !Number.isFinite(suppliedDeadline)) {
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_INVALID",
      "Multipart object upload requires a valid absolute deadline",
    );
  }
  const deadlineAt = suppliedDeadline ?? now + DEFAULT_MULTIPART_REQUEST_DURATION_MS;
  if (deadlineAt - now > MAX_MULTIPART_REQUEST_DURATION_MS) {
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_INVALID",
      "Multipart object upload deadline exceeds the bounded provider-I/O window",
    );
  }

  const controller = new AbortController();
  const tracked = new Set<Promise<void>>();
  let source: "caller" | "deadline" | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const abort = (next: "caller" | "deadline") => {
    if (source !== null || disposed) return;
    source = next;
    controller.abort();
  };
  const onCallerAbort = () => abort("caller");
  control.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (control.signal?.aborted) abort("caller");

  const armDeadline = () => {
    if (source !== null || disposed) return;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      abort("deadline");
      return;
    }
    deadlineTimer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
  };
  armDeadline();

  const failure = () =>
    source === "deadline"
      ? lifecycle(
          "OBJECT_STORAGE_MULTIPART_DEADLINE_EXCEEDED",
          "Multipart object upload exceeded its deadline",
        )
      : lifecycle("OBJECT_STORAGE_MULTIPART_ABORTED", "Multipart object upload was aborted");

  const track = <T>(request: Promise<T>): Promise<T> => {
    const observed = request.then(
      () => undefined,
      () => undefined,
    );
    tracked.add(observed);
    void observed.finally(() => tracked.delete(observed));
    return request;
  };

  const register = (settlement: Promise<void>) => {
    const observed = settlement.catch(() => undefined);
    try {
      control.registerLateSettlement(observed);
    } catch (error) {
      throw lifecycle(
        "OBJECT_STORAGE_MULTIPART_INVALID",
        "Multipart late-settlement hook rejected provider cleanup",
        error,
      );
    }
  };

  return {
    signal: controller.signal,
    ensureActive() {
      if (Date.now() >= deadlineAt) abort("deadline");
      if (control.signal?.aborted) abort("caller");
      if (controller.signal.aborted) throw failure();
    },
    failure,
    async race<T>(request: Promise<T>, onLateResolve?: (value: T) => void | Promise<void>) {
      let requestSettled = false;
      const provider = track(
        request.then(
          (value) => {
            requestSettled = true;
            return value;
          },
          (error) => {
            requestSettled = true;
            throw error;
          },
        ),
      );
      try {
        this.ensureActive();
      } catch (error) {
        if (!requestSettled) {
          register(
            provider.then(
              async (value) => {
                await onLateResolve?.(value);
              },
              () => undefined,
            ),
          );
        }
        throw error;
      }
      let onAbort: (() => void) | null = null;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(failure());
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([provider, aborted]);
      } catch (error) {
        if (controller.signal.aborted) {
          if (!requestSettled) {
            register(
              provider.then(
                async (value) => {
                  await onLateResolve?.(value);
                },
                () => undefined,
              ),
            );
          }
          throw failure();
        }
        throw error;
      } finally {
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      }
    },
    registerCleanup(cleanup: Promise<void>) {
      register(cleanup);
    },
    async waitForSettlements() {
      while (tracked.size > 0) await Promise.all([...tracked]);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      control.signal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

export function observedOperation<T>(
  context: ProviderRequestContext,
  operation: () => Promise<T>,
): QueuedOperation<T> {
  let markFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve;
  });
  const result = Promise.resolve().then(operation).finally(markFinished);
  const settlement = finished
    .then(() => context.waitForSettlements())
    .finally(() => context.dispose());
  return { result, settlement };
}

/** Abort a late-created upload without allowing cleanup to run forever. */
export async function lateAbortCreatedUpload(handle: ProviderMultipartHandle): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LATE_MULTIPART_CREATE_ABORT_MS);
  const request = Promise.resolve().then(() => handle.abort(controller.signal));
  try {
    await Promise.race([
      request,
      new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
  } catch {
    // error-policy:J6 late cleanup cannot replace the indeterminate create.
  } finally {
    clearTimeout(timer);
    void request.catch(() => undefined);
  }
}
