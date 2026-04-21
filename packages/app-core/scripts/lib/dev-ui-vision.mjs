export function buildVisionDepsFailureMessage(
  error,
  command = "node scripts/ensure-vision-deps.mjs",
) {
  const detail =
    error instanceof Error ? error.message : String(error ?? "unknown error");

  return [
    "",
    "  [eliza] Vision dependency auto-install failed.",
    "  [eliza] Camera and vision features will be unavailable in this session until the native tools are installed.",
    `  [eliza] Retry manually: ${command}`,
    `  [eliza] Failure detail: ${detail}`,
  ].join("\n");
}
