/**
 * API-keys cloud route entry.
 *
 * Lifted from `@elizaos/cloud-frontend/src/dashboard/api-keys/Page.tsx`. Gates
 * on the Steward session, fetches the keys with {@link useApiKeys}, maps the
 * server records to the cloud-ui display shape, derives the summary metrics, and
 * renders {@link ApiKeysView}. Loading / error states use the cloud-ui dashboard
 * placeholders; the page title is set via {@link useDocumentTitle} (no Helmet).
 *
 * The same component is exported for both the registered standalone route and
 * the Wave-3 settings-section wrapper (see `index.ts`).
 */

import { useContext } from "react";
import {
  DashboardErrorState,
  DashboardLoadingState,
} from "../../cloud-ui/components/dashboard/route-placeholders";
import type {
  ApiKeyDisplay,
  ApiKeyStatus,
  ApiKeysSummaryData,
} from "../../cloud-ui/components/data-list";
import { useCloudT } from "../shell/CloudI18nProvider";
import { LocalStewardAuthContext } from "../shell/StewardProvider";
import { ApiKeysView } from "./ApiKeysView";
import { type ApiKeyRecord, useApiKeys } from "./use-api-keys";
import { useDocumentTitle } from "./use-document-title";

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

/**
 * The API-keys surface. Embeddable: used directly by the Wave-3 settings
 * section and wrapped by {@link ApiKeysRoute} for the standalone route.
 */
export function ApiKeysSurface() {
  const t = useCloudT();
  const auth = useContext(LocalStewardAuthContext);
  const ready = auth ? !auth.isLoading : false;
  const authenticated = auth?.isAuthenticated ?? false;

  const { data: keys, isLoading, isError, error } = useApiKeys();

  useDocumentTitle(t("cloud.apiKeys.metaTitle", { defaultValue: "API Keys" }));

  const loadingLabel = t("cloud.apiKeys.loading", {
    defaultValue: "Loading API keys",
  });

  if (!ready || !authenticated) {
    return <DashboardLoadingState label={loadingLabel} />;
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

/** Default export consumed by the cloud-route registry. */
export default function ApiKeysRoute() {
  return <ApiKeysSurface />;
}
