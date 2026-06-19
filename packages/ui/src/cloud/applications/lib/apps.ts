/**
 * React-Query data hooks + typed mutation helpers for cloud OAuth applications.
 *
 * Ported from `@elizaos/cloud-frontend/src/lib/data/apps.ts`, re-pointed at the
 * app-hosted shared infra (`../../lib/api-client` + the applications-domain auth
 * gate). The `App` type narrows the canonical `AppDto` from
 * `@elizaos/cloud-shared` exactly as cloud-frontend did (the legacy
 * user-database fields are optional here).
 *
 * Mutations go through the same typed `api<T>` client as the reads so that the
 * Steward Bearer token is attached on every target (native cloud included) —
 * the cloud-frontend originals used bare same-origin `fetch`, which only worked
 * with the cookie session on the apex. Each mutation invalidates the relevant
 * query key instead of `window.location.reload()`.
 */

import type { AppDto } from "@elizaos/cloud-shared/types";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api-client";
import { authenticatedQueryKey, useAuthenticatedQueryGate } from "./auth-query";

type LegacyAppDatabaseFields =
  | "user_database_status"
  | "user_database_uri"
  | "user_database_project_id"
  | "user_database_branch_id"
  | "user_database_region"
  | "user_database_error";

export type App = Omit<AppDto, LegacyAppDatabaseFields> &
  Partial<Pick<AppDto, LegacyAppDatabaseFields>>;

/** Stable list key — exported so mutations can invalidate it. */
export const APPS_QUERY_KEY = ["apps"] as const;
/** Single-app key factory — exported for targeted invalidation. */
export const appQueryKey = (id: string) => ["app", id] as const;

// Apps list changes only on create/edit/delete. Relax to 2 minutes so list
// pages don't refetch on every nav while still staying responsive after
// mutations (which also invalidate this key directly).
const APP_STALE_MS = 2 * 60 * 1000;

/** GET /api/v1/apps — list of the caller's apps. */
export function useApps() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(APPS_QUERY_KEY, gate),
    queryFn: async () => {
      const data = await api<{ apps: App[] }>("/api/v1/apps");
      return data.apps;
    },
    enabled: gate.enabled,
    staleTime: APP_STALE_MS,
  });
}

/** GET /api/v1/apps/:id — single app record. */
export function useApp(id: string | undefined) {
  const gate = useAuthenticatedQueryGate(Boolean(id));
  return useQuery({
    queryKey: authenticatedQueryKey(["app", id], gate),
    queryFn: () => api<{ app: App }>(`/api/v1/apps/${id}`).then((r) => r.app),
    enabled: gate.enabled,
    staleTime: APP_STALE_MS,
  });
}

/** POST /api/v1/apps/check-name — debounced availability check. */
export async function checkAppNameAvailable(name: string): Promise<boolean> {
  const data = await api<{ available?: boolean }>("/api/v1/apps/check-name", {
    method: "POST",
    json: { name },
  });
  return Boolean(data.available);
}

/** POST /api/v1/apps — create an app; returns the record + one-time API key. */
export async function createApp(input: {
  name: string;
  app_url: string;
  allowed_origins: string[];
}): Promise<{ app: App; apiKey: string }> {
  return api<{ app: App; apiKey: string }>("/api/v1/apps", {
    method: "POST",
    json: input,
  });
}

/** PUT /api/v1/apps/:id — update editable app fields. */
export async function updateApp(
  id: string,
  patch: {
    name?: string;
    description?: string;
    app_url?: string;
    website_url?: string;
    contact_email?: string;
    is_active?: boolean;
    allowed_origins?: string[];
  },
): Promise<void> {
  await api(`/api/v1/apps/${id}`, { method: "PUT", json: patch });
}

/** DELETE /api/v1/apps/:id — permanently delete an app. */
export async function deleteApp(id: string): Promise<void> {
  await api(`/api/v1/apps/${id}`, { method: "DELETE" });
}

/** POST /api/v1/apps/:id/regenerate-api-key — rotate the server-to-server key. */
export async function regenerateAppApiKey(id: string): Promise<string> {
  const data = await api<{ apiKey?: string }>(
    `/api/v1/apps/${id}/regenerate-api-key`,
    { method: "POST" },
  );
  if (typeof data.apiKey !== "string" || data.apiKey.length === 0) {
    throw new Error("Regeneration response did not include an API key");
  }
  return data.apiKey;
}
