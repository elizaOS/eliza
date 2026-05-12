import { DashboardErrorState, DashboardLoadingState } from "@elizaos/cloud-ui";
import { Helmet } from "react-helmet-async";
import { useRequireAuth } from "../../lib/auth-hooks";
import { useApiKeys } from "../../lib/data/api-keys";
import { ApiKeysPage as ApiKeysPageView } from "./_components/api-keys-page";
import type { ApiKeyDisplay, ApiKeyStatus, ApiKeysSummaryData } from "./_components/types";

function getApiKeyStatus(isActive: boolean, expiresAt: string | null): ApiKeyStatus {
  if (!isActive) return "inactive";
  if (expiresAt && new Date(expiresAt) < new Date()) return "expired";
  return "active";
}

export default function ApiKeysPage() {
  const { ready, authenticated } = useRequireAuth();
  const { data: keys, isLoading, isError, error } = useApiKeys();

  if (!ready || !authenticated) return <DashboardLoadingState label="Loading API keys" />;

  return (
    <>
      <Helmet>
        <title>API Keys</title>
        <meta
          name="description"
          content="Manage your API keys and authentication credentials for elizaOS platform"
        />
      </Helmet>
      {isLoading ? (
        <DashboardLoadingState label="Loading API keys" />
      ) : isError ? (
        <DashboardErrorState message={(error as Error)?.message ?? "Failed to load API keys"} />
      ) : (
        (() => {
          const displayKeys: ApiKeyDisplay[] = (keys ?? []).map((key) => ({
            id: key.id,
            name: key.name,
            description: key.description,
            keyPrefix: key.key_prefix,
            status: getApiKeyStatus(key.is_active, key.expires_at),
            lastUsedAt: key.last_used_at,
            createdAt: key.created_at,
            permissions: key.permissions,
            usageCount: key.usage_count,
            rateLimit: key.rate_limit,
            expiresAt: key.expires_at,
          }));
          const summary: ApiKeysSummaryData = {
            totalKeys: displayKeys.length,
            activeKeys: displayKeys.filter((k) => k.status === "active").length,
            monthlyUsage: displayKeys.reduce((acc, k) => acc + k.usageCount, 0),
            rateLimit: 1000,
            lastGeneratedAt: displayKeys[0]?.createdAt ?? null,
          };
          return <ApiKeysPageView keys={displayKeys} summary={summary} />;
        })()
      )}
    </>
  );
}
