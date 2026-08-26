/**
 * Retries a briefly missing runtime route during deferred capability startup.
 * Typed unavailable errors remain terminal; only an untyped 404 route miss is
 * treated as warm-up, and the original error is preserved after the bound.
 */

import { useCallback, useEffect, useRef } from "react";
import { isApiError } from "../api/client-types-core";

export const CAPABILITY_WARMUP_DELAYS_MS = [250, 500, 1_000, 2_000] as const;

const TERMINAL_UNAVAILABLE_CODES = new Set([
  "documents_runtime_unavailable",
  "memory_runtime_unavailable",
  "relationships_runtime_unavailable",
  "trajectories_runtime_unavailable",
]);

export function isCapabilityWarmupMiss(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.status === 404 &&
    !TERMINAL_UNAVAILABLE_CODES.has(error.code ?? "")
  );
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("Capability load aborted", "AbortError");
  }
  const error = new Error("Capability load aborted");
  error.name = "AbortError";
  return error;
}

export function isCapabilityWarmupAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface CapabilityWarmupOptions {
  delaysMs?: readonly number[];
  retryWhen?: (error: unknown) => boolean;
  signal?: AbortSignal;
}

export async function loadAfterCapabilityWarmup<T>(
  load: () => Promise<T>,
  options?: CapabilityWarmupOptions,
): Promise<T> {
  const delaysMs = options?.delaysMs ?? CAPABILITY_WARMUP_DELAYS_MS;
  const retryWhen = options?.retryWhen ?? isCapabilityWarmupMiss;
  const signal = options?.signal;

  for (const delayMs of delaysMs) {
    throwIfAborted(signal);
    try {
      const result = await load();
      throwIfAborted(signal);
      return result;
    } catch (error) {
      throwIfAborted(signal);
      if (!retryWhen(error)) throw error;
      await wait(delayMs, signal);
    }
  }

  throwIfAborted(signal);
  const result = await load();
  throwIfAborted(signal);
  return result;
}

type AbortableCapabilityWarmupOptions = Omit<CapabilityWarmupOptions, "signal">;

export type AbortableCapabilityWarmupLoader = <T>(
  load: () => Promise<T>,
  options?: AbortableCapabilityWarmupOptions,
) => Promise<T>;

/**
 * Runs capability warm-up loads within the mounted component lifecycle.
 * Unmounting aborts both pending backoff timers and responses that resolve
 * after teardown, so a repointed global client cannot retry against the next
 * agent or write that response into the previous agent's cache namespace.
 */
export function useAbortableCapabilityWarmup(): AbortableCapabilityWarmupLoader {
  const controllersRef = useRef(new Set<AbortController>());
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      for (const controller of controllersRef.current) controller.abort();
      controllersRef.current.clear();
    };
  }, []);

  return useCallback(async function runCapabilityWarmup<T>(
    load: () => Promise<T>,
    options?: AbortableCapabilityWarmupOptions,
  ): Promise<T> {
    if (!activeRef.current) throw abortError();
    const controller = new AbortController();
    controllersRef.current.add(controller);
    try {
      return await loadAfterCapabilityWarmup(load, {
        ...options,
        signal: controller.signal,
      });
    } finally {
      controllersRef.current.delete(controller);
    }
  }, []);
}
