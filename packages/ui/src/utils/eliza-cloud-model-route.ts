/** Heuristic: SSE `estimatedUsage.model` for Eliza Cloud–hosted Kimi / moonshot routes. */
export function modelLooksLikeElizaCloudHosted(
  model: string | undefined,
): boolean {
  if (!model || typeof model !== "string") return false;
  const m = model.toLowerCase();
  return (
    m.includes("kimi") ||
    m.includes("moonshot") ||
    (m.includes("eliza") && m.includes("cloud"))
  );
}
