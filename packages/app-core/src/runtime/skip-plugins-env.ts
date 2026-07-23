/**
 * Preserves the operator's ELIZA_SKIP_PLUGINS across dev-server runtime
 * bootstrap cycles. The PGlite-recovery retry reuses that same env var to
 * skip crash-implicated plugins on its one retry boot, which makes the
 * variable scratch state during recovery; dev-server captures the operator's
 * value once at module load and threads it through these helpers so the
 * recovery retry unions rather than replaces the operator's list, and every
 * successful boot settles the env var back to the operator's value instead
 * of deleting it (deletion made any later in-process runtime re-bootstrap
 * silently resurrect every operator-skipped plugin).
 */

/** Restore ELIZA_SKIP_PLUGINS to the captured operator-provided value. */
export function restoreOperatorSkipPlugins(
  operatorSkipPlugins: string | undefined,
): void {
  if (operatorSkipPlugins === undefined) {
    delete process.env.ELIZA_SKIP_PLUGINS;
  } else {
    process.env.ELIZA_SKIP_PLUGINS = operatorSkipPlugins;
  }
}

/** Operator skips plus the PGlite-recovery skips, deduped. */
export function mergedRecoverySkipPlugins(
  operatorSkipPlugins: string | undefined,
  recovery: string[],
): string {
  const merged = new Set(
    (operatorSkipPlugins ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  for (const name of recovery) merged.add(name);
  return [...merged].join(",");
}
