/**
 * Classifies startup endpoint probes without collapsing missing capabilities,
 * transient transport failures, and terminal protocol failures into `null`.
 */

import { asApiLikeError } from "./parsers";

export type StartupProbeResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "unsupported"; error: unknown }
  | { kind: "retryable-error"; error: unknown }
  | { kind: "terminal-error"; error: unknown };

export interface StartupProbeOptions {
  /** Status codes that explicitly mean this optional capability is absent. */
  unsupportedStatuses?: readonly number[];
}

export class StartupProbeTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Startup probe timed out after ${timeoutMs}ms`);
    this.name = "StartupProbeTimeoutError";
  }
}

export async function runStartupProbe<T>(
  operation: () => Promise<T>,
  options: StartupProbeOptions = {},
): Promise<StartupProbeResult<T>> {
  try {
    return { kind: "ok", value: await operation() };
  } catch (error) {
    const apiError = asApiLikeError(error);
    if (
      apiError?.status !== undefined &&
      options.unsupportedStatuses?.includes(apiError.status)
    ) {
      return { kind: "unsupported", error };
    }
    if (
      apiError?.kind === "network" ||
      apiError?.kind === "timeout" ||
      apiError?.status === 408 ||
      apiError?.status === 425 ||
      apiError?.status === 429 ||
      (apiError?.status !== undefined && apiError.status >= 500) ||
      apiError === null
    ) {
      return { kind: "retryable-error", error };
    }
    return { kind: "terminal-error", error };
  }
}

export function unwrapStartupProbe<T>(result: StartupProbeResult<T>): T {
  if (result.kind === "ok") return result.value;
  throw result.error;
}

export async function runStartupProbeWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  options: StartupProbeOptions = {},
): Promise<StartupProbeResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new StartupProbeTimeoutError(timeoutMs);
  const timeoutResult = new Promise<StartupProbeResult<T>>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: "retryable-error", error: timeoutError }),
      timeoutMs,
    );
  });
  const result = await Promise.race([
    runStartupProbe(operation, options),
    timeoutResult,
  ]);
  if (timer) clearTimeout(timer);
  return result;
}
