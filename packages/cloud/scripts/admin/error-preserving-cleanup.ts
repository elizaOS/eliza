/**
 * Runs ordered resource teardown without allowing cleanup failures to replace
 * the operation error that made teardown necessary. Every cleanup failure is
 * still reported, and cleanup remains fatal when the operation itself passed.
 */

/** One ordered resource teardown action. */
export interface CleanupStep {
  label: string;
  run(): Promise<void>;
}

/** Cleanup diagnostics with the operation failure retained separately. */
export interface CleanupFailure {
  label: string;
  cleanupError: unknown;
  primaryFailure: { error: unknown } | null;
}

/** Observes cleanup failures without deciding which error escapes. */
export type CleanupFailureReporter = (failure: CleanupFailure) => void;

/** Runs every cleanup step and gives a primary failure precedence when present. */
export async function runCleanupSteps(
  steps: CleanupStep[],
  reportFailure: CleanupFailureReporter,
  primaryFailure: { error: unknown } | null = null,
): Promise<void> {
  let firstCleanupFailure: { error: unknown } | null = null;

  for (const step of steps) {
    try {
      await step.run();
    } catch (cleanupError) {
      // error-policy:J6 Teardown failures are observed without replacing the
      // operation failure that initiated cleanup.
      reportFailure({
        label: step.label,
        cleanupError,
        primaryFailure,
      });
      firstCleanupFailure ??= { error: cleanupError };
    }
  }

  if (!firstCleanupFailure) return;
  if (primaryFailure) throw primaryFailure.error;
  throw firstCleanupFailure.error;
}

/** Runs an operation and all cleanup steps while retaining exact error identity. */
export async function runWithCleanup<T>(
  operation: () => Promise<T>,
  steps: CleanupStep[],
  reportFailure: CleanupFailureReporter,
): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await operation() };
  } catch (error) {
    // error-policy:J6 Cleanup must complete before the primary failure escapes.
    outcome = { ok: false, error };
  }

  const primaryFailure = outcome.ok ? null : { error: outcome.error };
  await runCleanupSteps(steps, reportFailure, primaryFailure);

  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
