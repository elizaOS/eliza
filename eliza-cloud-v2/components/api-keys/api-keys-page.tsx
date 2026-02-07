import type { ApiKeyDisplay, ApiKeysSummaryData } from "./types";
import { ApiKeysPageClient } from "./api-keys-page-client";

interface ApiKeysPageProps {
  keys?: ApiKeyDisplay[];
  summary?: ApiKeysSummaryData;
}

const placeholderSummary: ApiKeysSummaryData = {
  totalKeys: 0,
  activeKeys: 0,
  monthlyUsage: 0,
  rateLimit: 1000,
  lastGeneratedAt: null,
};

export function ApiKeysPage({
  keys = [],
  summary = placeholderSummary,
}: ApiKeysPageProps) {
  return <ApiKeysPageClient keys={keys} summary={summary} />;
}
