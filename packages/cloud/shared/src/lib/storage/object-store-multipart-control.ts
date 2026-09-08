/** Abort/deadline control and late-settlement ownership for multipart I/O. */

import { logger } from "../utils/logger";
import type { ObjectStorageLifecycleError } from "./object-store";
import {
  DEFAULT_MULTIPART_REQUEST_DURATION_MS,
  LATE_MULTIPART_CREATE_ABORT_MS,
  lifecycle,
  MAX_MULTIPART_REQUEST_DURATION_MS,
  type MultipartObjectMutationControl,
  type MultipartObjectRequestControl,
  type ProviderMultipartHandle,
  type QueuedOperation,
} from "./object-store-multipart-types";

export interface ProviderRequestContext {
  readonly signal: AbortSignal;
  ensureActive(): void;
  failure(): ObjectStorageLifecycleError;
  race<T>(request: Promise<T>, onLateResolve?: (value: T) => void | Promise<void>): Promise<T>;
  waitForTurn(turn: Promise<void>): Promise<void>;
  registerCleanup(cleanup: Promise<void>): void;
  waitForSettlements(): Promise<void>;
  dispose(): void;
}

export interface ProviderMutationRequestContext extends ProviderRequestContext {
  authorizeMutation(): Promise<void>;
}

/** Report a teardown failure without exposing provider locators or replacing its primary error. */
export function reportMultipartCleanupFailure(scope: string, error: unknown): void {
  const failureKind =
    error instanceof Error && error.name.length > 0 ? error.name : `non-error:${typeof error}`;
  try {
    logger.warn("[ObjectStorageMultipart] teardown did not settle cleanly", {
      scope,
      failureKind,
    });
  } catch (diagnosticError) {
    // error-policy:J7 the structured logger is the last diagnostic boundary here;
    // its own failure must never replace the authoritative storage outcome.
    void diagnosticError;
  }
}

/** Register teardown while preserving an already-authoritative public failure. */
export function registerMultipartCleanupWithoutMasking(
  context: ProviderRequestContext,
  cleanup: Promise<void>,
  scope: string,
): unknown | null {
  try {
    context.registerCleanup(cleanup);
    return null;
  } catch (error) {
    // error-policy:J6 the caller retains its authoritative failure; this
    // registration failure is reported and returned for causal attachment.
    reportMultipartCleanupFailure(scope, error);
    return error;
  }
}

export function createRequestContext(
  control: MultipartObjectRequestControl,
): ProviderRequestContext {
  const registerLateSettlement = control?.registerLateSettlement;
  const callerSignal = control?.signal;
  if (typeof registerLateSettlement !== "function") {
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
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  if (callerSignal?.aborted) abort("caller");

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
    void settlement.catch((error) => {
      // error-policy:J5 the durable late-settlement hook below owns this same
      // rejection; this observer only prevents an unhandled rejection and logs it.
      reportMultipartCleanupFailure("registered-late-settlement", error);
    });
    try {
      registerLateSettlement.call(control, settlement);
    } catch (error) {
      // error-policy:J2 translate a rejected ownership hook into the public
      // lifecycle error while retaining the hook failure as its cause.
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
      if (callerSignal?.aborted) abort("caller");
      if (controller.signal.aborted) throw failure();
    },
    failure,
    async waitForTurn(turn: Promise<void>) {
      this.ensureActive();
      let onAbort: (() => void) | null = null;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(failure());
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        await Promise.race([turn, aborted]);
        this.ensureActive();
      } finally {
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      }
    },
    async race<T>(request: Promise<T>, onLateResolve?: (value: T) => void | Promise<void>) {
      const provider = track(request);
      const registerLateProviderResult = () => {
        register(
          provider.then(
            async (value) => {
              await onLateResolve?.(value);
            },
            () => undefined,
          ),
        );
      };
      try {
        this.ensureActive();
      } catch (error) {
        // error-policy:J2 add durable late-settlement ownership before
        // rethrowing the original typed cancellation/deadline.
        registerLateProviderResult();
        throw error;
      }
      let onAbort: (() => void) | null = null;
      const aborted = new Promise<{ readonly kind: "aborted" }>((resolve) => {
        onAbort = () => resolve({ kind: "aborted" });
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      const providerOutcome = provider.then(
        (value) => ({ kind: "resolved" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      try {
        const outcome = await Promise.race([providerOutcome, aborted]);
        if (outcome.kind === "aborted") {
          registerLateProviderResult();
          throw failure();
        }
        if (outcome.kind === "rejected") throw outcome.error;
        return outcome.value;
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
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

export function createMutationRequestContext(
  control: MultipartObjectMutationControl,
): ProviderMutationRequestContext {
  const beforeProviderMutation = control?.beforeProviderMutation;
  if (typeof beforeProviderMutation !== "function") {
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_INVALID",
      "Multipart provider mutations require a fenced authority hook",
    );
  }
  const context = createRequestContext(control);
  return Object.assign(context, {
    async authorizeMutation() {
      context.ensureActive();
      await context.race(Promise.resolve().then(() => beforeProviderMutation.call(control)));
      context.ensureActive();
    },
  });
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

/**
 * Abort a created upload that was never handed to the durable caller.
 * This exact compensation intentionally bypasses the caller fence: no other
 * owner can have adopted the private upload handle that is being removed.
 */
export async function lateAbortCreatedUpload(handle: ProviderMultipartHandle): Promise<void> {
  const controller = new AbortController();
  const request = Promise.resolve().then(() => handle.abort(controller.signal));
  let rejectTimeout!: (error: ObjectStorageLifecycleError) => void;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectTimeout(
      lifecycle(
        "OBJECT_STORAGE_MULTIPART_ABORT_UNCONFIRMED",
        "Late-created multipart upload cleanup exceeded its bounded confirmation window",
      ),
    );
  }, LATE_MULTIPART_CREATE_ABORT_MS);
  try {
    await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
