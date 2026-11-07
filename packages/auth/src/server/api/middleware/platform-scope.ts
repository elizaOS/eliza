import type { Context } from "hono";
import { hasPlatformScope } from "../../auth/index";
import type { ApiResponse, AppVariables } from "../../shared/index";

export function requirePlatformRouteScope(
  c: Context<{ Variables: AppVariables }>,
  scope: string,
): Response | null {
  if (hasPlatformScope(c.get("platformScopes"), scope)) return null;
  return c.json<ApiResponse>(
    {
      ok: false,
      error: `Platform route requires scoped platform key with ${scope}`,
    },
    403,
  );
}
