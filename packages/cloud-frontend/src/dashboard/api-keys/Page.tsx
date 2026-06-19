import { DashboardErrorState, DashboardLoadingState } from "@elizaos/ui";
import { Helmet } from "react-helmet-async";
import { useT } from "@/providers/I18nProvider";
import { useRequireAuth } from "../../lib/auth-hooks";
import { useApiKeys } from "../../lib/data/api-keys";
import { ApiKeysPage as ApiKeysPageView } from "./_components/api-keys-page";
import type {
  ApiKeyDisplay,
  ApiKeyStatus,
  ApiKeysSummaryData,
} from "./_components/types";

function getApiKeyStatus(
  isActive: boolean,
  expiresAt: string | null,
): ApiKeyStatus {
  if (!isActive) return "inactive";
  if (expiresAt && new Date(expiresAt) < new Date()) return "expired";
  return "active";
}

export default function ApiKeysPage() {
  const t = useT();
  const { ready, authenticated } = useRequireAuth();
  const { data: keys, isLoading, isError, error } = useApiKeys();

  const head = (
    <Helmet>
      <title>
        {t("cloud.apiKeys.metaTitle", { defaultValue: "API Keys" })}
      </title>
      <meta
        name="description"
        content={t("cloud.apiKeys.metaDescription", {
          defaultValue:
            "Manage your API keys and authentication credentials for elizaOS platform",
        })}
      />
    </Helmet>
  );
  const loadingLabel = t("cloud.apiKeys.loading", {
    defaultValue: "Loading API keys",
  });

  if (!ready || !authenticated)
    return (
      <>
        {head}
        <DashboardLoadingState label={loadingLabel} />
      </>
    );

  return (
    <>
      {head}
      {isLoading ? (
        <DashboardLoadingState label={loadingLabel} />
      ) : isError ? (
        <DashboardErrorState
          message={
            (error as Error)?.message ??
            t("cloud.apiKeys.loadError", {
              defaultValue: "Failed to load API keys",
            })
          }
        />
      ) : (
        <ApiKeysPageContent keys={keys} />
      )}
    </>
  );
}

function ApiKeysPageContent({
  keys,
}: {
  keys: ReturnType<typeof useApiKeys>["data"];
}) {
  const displayKeys: ApiKeyDisplay[] = (keys ?? []).map((key) => ({
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
  }));
  const summary: ApiKeysSummaryData = {
    totalKeys: displayKeys.length,
    activeKeys: displayKeys.filter((k) => k.status === "active").length,
    monthlyUsage: displayKeys.reduce((acc, k) => acc + k.usageCount, 0),
    rateLimit: 1000,
    lastGeneratedAt: displayKeys[0]?.createdAt ?? null,
  };
  return <ApiKeysPageView keys={displayKeys} summary={summary} />;
}
