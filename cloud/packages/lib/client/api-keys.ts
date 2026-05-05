"use client";

import { copyTextToClipboard } from "@/lib/utils/copy-to-clipboard";

export interface ClientApiKey {
  id: string;
  name: string;
  description: string | null;
  key_prefix: string;
  permissions: string[];
  rate_limit: number;
  is_active: boolean;
  usage_count: number;
  last_used_at: string | null;
  created_at: string;
  expires_at: string | null;
}

interface ListApiKeysResponse {
  keys?: ClientApiKey[];
  error?: string;
}

export async function listClientApiKeys(): Promise<ClientApiKey[]> {
  const response = await fetch("/api/v1/api-keys", {
    cache: "no-store",
  });
  const data = (await response.json()) as ListApiKeysResponse;

  if (!response.ok) {
    throw new Error(data.error || "Failed to fetch API keys");
  }

  return data.keys ?? [];
}

export async function getClientApiKeySecret(id: string): Promise<string> {
  void id;
  throw new Error("Full API keys are only available immediately after creation.");
}

export async function copyApiKeyToClipboard(apiKey: string): Promise<void> {
  const ok = await copyTextToClipboard(apiKey);

  if (!ok) {
    throw new Error("Failed to copy API key");
  }
}
