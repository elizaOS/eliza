export function isRuntimeAutonomyEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env.ENABLE_AUTONOMY?.toLowerCase();
  return value === "true" || value === "1";
}
