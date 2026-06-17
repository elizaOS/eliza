export type ApiKeyStatus = "active" | "inactive" | "expired";

export interface ApiKeyDisplay {
  id: string;
  name: string;
  description?: string | null;
  keyPrefix: string;
  status: ApiKeyStatus;
  lastUsedAt?: string | null;
  createdAt: string;
  permissions: string[];
  usageCount: number;
  rateLimit: number;
  expiresAt?: string | null;
}

export interface ApiKeysSummaryData {
  totalKeys: number;
  activeKeys: number;
  monthlyUsage: number;
  rateLimit: number;
  lastGeneratedAt?: string | null;
}
