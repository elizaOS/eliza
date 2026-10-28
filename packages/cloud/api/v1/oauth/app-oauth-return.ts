/** Optional native-app handoff, recovered only from server-owned OAuth state. */
export interface AppOAuthReturn {
  url: string;
  state: string;
  source: string;
}
export function resolveAppOAuthReturn(
  value: unknown,
  providerId: string,
  allowlist: string | undefined,
  now = Date.now(),
): AppOAuthReturn | null {
  if (
    !allowlist ||
    providerId !== "google" ||
    !value ||
    typeof value !== "object"
  )
    return null;
  const record = value as Record<string, unknown>;
  if (
    record.providerId !== providerId ||
    typeof record.redirectUrl !== "string" ||
    typeof record.createdAt !== "number" ||
    !Number.isFinite(record.createdAt) ||
    record.createdAt > now ||
    now - record.createdAt >= 600_000 ||
    typeof record.organizationId !== "string" ||
    !record.organizationId ||
    typeof record.userId !== "string" ||
    !record.userId
  )
    return null;
  try {
    const url = new URL(record.redirectUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.port
    )
      return null;
    const state = url.searchParams.get("state");
    if (
      !state ||
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      [...url.searchParams.keys()].length !== 1
    )
      return null;
    url.search = "";
    if (
      !allowlist
        .split(",")
        .map((s) => s.trim())
        .includes(url.href)
    )
      return null;
    return { url: url.href, state, source: record.redirectUrl };
  } catch {
    return null;
  }
}
export function buildAppOAuthReturn(
  target: AppOAuthReturn,
  result: "connected" | "denied" | "failed",
  connectionId?: string,
): string {
  const url = new URL(target.url);
  const params = new URLSearchParams({ state: target.state, result });
  if (result === "connected") {
    if (!connectionId || !/^[A-Za-z0-9_-]{1,128}$/.test(connectionId))
      throw new Error("Invalid connector ID");
    params.set("connectionId", connectionId);
  }
  url.hash = params.toString();
  return url.href;
}
