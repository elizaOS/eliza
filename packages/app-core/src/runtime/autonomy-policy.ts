export function isRuntimeAutonomyEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.ENABLE_AUTONOMY ?? "true").toLowerCase() !== "false";
}
