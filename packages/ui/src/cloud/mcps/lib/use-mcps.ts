/**
 * React Query hooks for the MCP registry surfaces.
 *
 * Reads go through the shared cloud `api<T>` client (auth injection +
 * structured `ApiError`) and gate on the Steward session via
 * {@link useAuthenticatedQueryGate}. Mutations (create/update/delete/publish)
 * live in `mcp-mutations.ts` and invalidate {@link MCPS_QUERY_KEY} directly.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api-client";
import {
  authenticatedQueryKey,
  useAuthenticatedQueryGate,
} from "../../lib/auth-query";
import type {
  BuiltinMcpListResponse,
  ListUserMcpsResponse,
  McpStatus,
  UserMcpDetailResponse,
} from "./api-types";

/** Root query key for all MCP registry data. */
export const MCPS_QUERY_KEY = ["mcps"] as const;

// User MCPs change only on explicit user action (create/edit/publish), so a
// short stale window is fine — mutations invalidate the key directly.
const MCPS_STALE_MS = 30_000;
// The built-in platform catalog is effectively static; cache it longer.
const BUILTIN_STALE_MS = 10 * 60 * 1000;

export interface UseUserMcpsOptions {
  /** `own` (default) lists the org's MCPs; `public` lists the live registry. */
  scope?: "own" | "public" | "all";
  status?: McpStatus;
  category?: string;
  search?: string;
}

function buildListQuery(options: UseUserMcpsOptions): string {
  const params = new URLSearchParams();
  if (options.scope) params.set("scope", options.scope);
  if (options.status) params.set("status", options.status);
  if (options.category) params.set("category", options.category);
  if (options.search) params.set("search", options.search);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** List the user/organization's own MCP servers (all statuses). */
export function useUserMcps(options: UseUserMcpsOptions = {}) {
  const gate = useAuthenticatedQueryGate();
  const scope = options.scope ?? "own";
  return useQuery({
    queryKey: authenticatedQueryKey(
      [...MCPS_QUERY_KEY, "list", scope, options] as const,
      gate,
    ),
    queryFn: () =>
      api<ListUserMcpsResponse>(
        `/api/v1/mcps${buildListQuery({ ...options, scope })}`,
      ),
    enabled: gate.enabled,
    staleTime: MCPS_STALE_MS,
  });
}

/** List the public, live MCP registry (community + the org's published MCPs). */
export function usePublicMcps(
  options: Omit<UseUserMcpsOptions, "scope" | "status"> = {},
) {
  return useUserMcps({ ...options, scope: "public" });
}

/** Fetch a single MCP's detail (+ owner stats when the caller owns it). */
export function useUserMcpDetail(mcpId: string | null) {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(
      [...MCPS_QUERY_KEY, "detail", mcpId] as const,
      gate,
    ),
    queryFn: () => api<UserMcpDetailResponse>(`/api/v1/mcps/${mcpId}`),
    enabled: gate.enabled && !!mcpId,
    staleTime: MCPS_STALE_MS,
  });
}

/**
 * Fetch the built-in platform MCP catalog (`/api/mcp/list`). This endpoint is
 * unauthenticated (static definitions), so it is not gated on the session.
 */
export function useBuiltinMcps() {
  return useQuery({
    queryKey: [...MCPS_QUERY_KEY, "builtin"] as const,
    queryFn: () => api<BuiltinMcpListResponse>("/api/mcp/list"),
    staleTime: BUILTIN_STALE_MS,
  });
}
