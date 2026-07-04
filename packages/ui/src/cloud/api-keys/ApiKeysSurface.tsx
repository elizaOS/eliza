/**
 * API-keys surface. Gates on the Steward session, fetches the keys with
 * {@link useApiKeys}, maps the server records to the cloud-ui display shape,
 * and renders {@link ApiKeysView}. Mounted twice: by the `cloud-api-keys`
 * Settings section (`/settings#cloud-api-keys`) in the app, and by the
 * standalone `dashboard/api-keys` console page (the apex-console home for
 * key management).
 */

import {
  DashboardErrorState,
  DashboardLoadingState,
} from "../../cloud-ui/components/dashboard/route-placeholders";
import type {
  ApiKeyDisplay,
  ApiKeyStatus,
  ApiKeysSummaryData,
} from "../../cloud-ui/components/data-list";
import { useDocumentTitle } from "../lib/use-document-title";
import { useSessionAuth } from "../lib/use-session-auth";
import { useCloudT } from "../shell/CloudI18nProvider";
import { ApiKeysView } from "./ApiKeysView";
import { type ApiKeyRecord, useApiKeys } from "./use-api-keys";

function getApiKeyStatus(
  isActive: boolean,
  expiresAt: string | null,
): ApiKeyStatus {
  if (!isActive) return "inactive";
  if (expiresAt && new Date(expiresAt) < new Date()) return "expired";
  return "active";
}

function toDisplayKey(key: ApiKeyRecord): ApiKeyDisplay {
  return {
    id: key.id,
    name: key.name,
    description: key.description,
    keyPrefix: key.key_prefix,
    status: getApiKeyStatus(key.is_active, key.expires_at),
    lastUsedAt: key.last_used_at,
    createdAt: key.created_at,
    usageCount: key.usage_count,
    rateLimit: key.rate_limit,
    expiresAt: key.expires_at,
  };
}

function deriveSummary(keys: ApiKeyDisplay[]): ApiKeysSummaryData {
  return {
    totalKeys: keys.length,
    activeKeys: keys.filter((k) => k.status === "active").length,
    monthlyUsage: keys.reduce((acc, k) => acc + k.usageCount, 0),
    rateLimit: 1000,
    lastGeneratedAt: keys[0]?.createdAt ?? null,
  };
}

/** The API-keys surface, rendered by the Settings → Developer section. */
export function ApiKeysSurface() {
  const t = useCloudT();
  // Canonical session hook: provider context when mounted, persisted-JWT
  // fallback otherwise. The previous raw context read treated "provider not
  // mounted" and "signed out" as loading, so the page skeletoned forever
  // instead of ever resolving.
  const { ready, authenticated } = useSessionAuth();

  const { data: keys, isLoading, isError, error } = useApiKeys();

  useDocumentTitle(t("cloud.apiKeys.metaTitle", { defaultValue: "API Keys" }));

  const loadingLabel = t("cloud.apiKeys.loading", {
    defaultValue: "Loading API keys",
  });

  if (!ready) {
    return <DashboardLoadingState label={loadingLabel} />;
  }

  if (!authenticated) {
    // Signed-out is a designed state, never an eternal skeleton.
    return (
      <DashboardErrorState
        message={t("cloud.apiKeys.signInRequired", {
          defaultValue: "Sign in to manage API keys.",
        })}
      />
    );
  }

  if (isLoading) {
    return <DashboardLoadingState label={loadingLabel} />;
  }

  if (isError) {
    return (
      <DashboardErrorState
        message={
          error instanceof Error
            ? error.message
            : t("cloud.apiKeys.loadError", {
                defaultValue: "Failed to load API keys",
              })
        }
      />
    );
  }

  const displayKeys = (keys ?? []).map(toDisplayKey);
  return (
    <ApiKeysView keys={displayKeys} summary={deriveSummary(displayKeys)} />
  );
}
