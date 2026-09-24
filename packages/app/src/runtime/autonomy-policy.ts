/**
 * Resolves whether the runtime autonomy loop is enabled from the ENABLE_AUTONOMY
 * environment variable. Defaults off; only the literal "true" (any case) or "1"
 * turns it on — every other value leaves autonomy disabled.
 */
export function isRuntimeAutonomyEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env.ENABLE_AUTONOMY?.toLowerCase();
  return value === "true" || value === "1";
}
