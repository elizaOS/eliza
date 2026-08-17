/** Heuristic: SSE `estimatedUsage.model` for Eliza Cloud–hosted Kimi / moonshot routes. */
export function modelLooksLikeElizaCloudHosted(
  model: string | null | undefined,
): boolean {
  if (!model || typeof model !== "string") return false;
  const m = model.trim().toLowerCase();
  if (!m) return false;
  return (
    m.includes("kimi") ||
    m.includes("moonshot") ||
    (m.includes("eliza") && m.includes("cloud"))
  );
}
