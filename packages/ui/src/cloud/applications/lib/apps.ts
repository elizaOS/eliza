/**
 * React-Query data hooks + typed mutation helpers for cloud OAuth applications.
 *
 * The `App` type narrows the canonical `AppDto` from `@elizaos/cloud-shared`
 * (the legacy user-database fields are optional here).
 *
 * Mutations go through the same typed `api<T>` client as the reads so that the
 * Steward Bearer token is attached on every target (native cloud included).
 * Each mutation invalidates the relevant query key.
 */

import type { AppDto } from "@elizaos/cloud-shared/types";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api-client";
import {
  authenticatedQueryKey,
  useAuthenticatedQueryGate,
} from "../../lib/auth-query";

type LegacyAppDatabaseFields =
  | "user_database_status"
  | "user_database_uri"
  | "user_database_region"
  | "user_database_error";

export type App = Omit<AppDto, LegacyAppDatabaseFields> &
  Partial<Pick<AppDto, LegacyAppDatabaseFields>>;

/** Stable list key — exported so mutations can invalidate it. */
export const APPS_QUERY_KEY = ["apps"] as const;
/** Single-app key factory — exported for targeted invalidation. */
export const appQueryKey = (id: string) => ["app", id] as const;

export type DeploymentStatus = "BUILDING" | "READY" | "ERROR" | "DRAFT";

export interface AppDeploymentRecord {
  success?: boolean;
  deploymentId: string | null;
  status: DeploymentStatus;
  vercelUrl: string | null;
  error: string | null;
  startedAt: string | null;
}

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
  /**
   * Create a TEMPLATE app (no GitHub repo). The dashboard has no
   * build-from-repo flow, and build-from-repo is intentionally OFF, so a
   * repo-backed app would have no image and DEPLOY would throw "build-from-repo
   * is disabled / no image to deploy". With skipGitHubRepo the server stamps a
   * first-party template image so the create -> deploy loop resolves. Defaults
   * to true so a dashboard-created app is always deployable.
   */
  skipGitHubRepo?: boolean;
}): Promise<{ app: App; apiKey: string }> {
  return api<{ app: App; apiKey: string }>("/api/v1/apps", {
    method: "POST",
    json: { skipGitHubRepo: true, ...input },
  });
}

/**
 * POST /api/v1/apps/:id/deploy — start a managed container deployment (#9145).
 * Gated server-side by APPS_DEPLOY_ENABLED: when off, the route rejects with
 * `apps_deploy_disabled`, which surfaces to the caller as a thrown error.
 */
export async function deployApp(id: string): Promise<{
  deploymentId?: string;
  status?: DeploymentStatus;
  startedAt?: string;
}> {
  return api<{
    deploymentId?: string;
    status?: DeploymentStatus;
    startedAt?: string;
  }>(`/api/v1/apps/${id}/deploy`, { method: "POST" });
}

/**
 * GET /api/v1/apps/:id/deploy/status — latest deployment record. The dashboard
 * polls this after a deploy trigger so users see the app move from BUILDING to
 * READY/ERROR without refreshing the page.
 */
export async function getLatestAppDeployment(
  id: string,
): Promise<AppDeploymentRecord> {
  return api<AppDeploymentRecord>(`/api/v1/apps/${id}/deploy/status`);
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
