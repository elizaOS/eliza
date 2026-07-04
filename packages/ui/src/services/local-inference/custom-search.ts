/**
 * Descriptors for the custom model-search providers (HuggingFace, ModelScope):
 * labels, placeholders, and whether search is supported for each.
 */
import type { CatalogModel } from "./types";

export type LocalModelSearchProviderId = "huggingface" | "modelscope";

export interface LocalModelSearchProviderDescriptor {
  id: LocalModelSearchProviderId;
  label: string;
  shortLabel: string;
  placeholder: string;
  searchSupported: boolean;
  downloadSupported: boolean;
  unavailableMessage?: string;
  downloadUnsupportedReason?: string;
}

export interface LocalModelSearchResult {
  providerId: LocalModelSearchProviderId;
  model: CatalogModel;
  externalUrl?: string;
  download: {
    supported: boolean;
    reason?: string;
  };
}

export interface LocalModelSearchResponse {
  provider: LocalModelSearchProviderDescriptor;
  results: LocalModelSearchResult[];
  unavailableMessage?: string;
}

export const DEFAULT_LOCAL_MODEL_SEARCH_PROVIDER_ID: LocalModelSearchProviderId =
  "huggingface";

export const CUSTOM_MODEL_SEARCH_DISABLED_MESSAGE =
  "Custom model search is disabled; local inference uses curated Eliza-1 bundles only.";

const PROVIDERS: readonly LocalModelSearchProviderDescriptor[] = [
  {
    id: "huggingface",
    label: "Hugging Face",
    shortLabel: "HF",
    placeholder: "Curated Eliza-1 only",
    searchSupported: false,
    downloadSupported: false,
    unavailableMessage: CUSTOM_MODEL_SEARCH_DISABLED_MESSAGE,
    downloadUnsupportedReason: CUSTOM_MODEL_SEARCH_DISABLED_MESSAGE,
  },
  {
    id: "modelscope",
    label: "ModelScope",
    shortLabel: "ModelScope",
    placeholder: "Curated Eliza-1 only",
    searchSupported: false,
    downloadSupported: false,
    unavailableMessage: CUSTOM_MODEL_SEARCH_DISABLED_MESSAGE,
    downloadUnsupportedReason: CUSTOM_MODEL_SEARCH_DISABLED_MESSAGE,
  },
] as const;

export function listLocalModelSearchProviders(): LocalModelSearchProviderDescriptor[] {
  return PROVIDERS.map((provider) => ({ ...provider }));
}

export function isLocalModelSearchProviderId(
  value: string,
): value is LocalModelSearchProviderId {
  return PROVIDERS.some((provider) => provider.id === value);
}

export function getLocalModelSearchProvider(
  id: LocalModelSearchProviderId,
): LocalModelSearchProviderDescriptor {
  return PROVIDERS.find((provider) => provider.id === id) ?? PROVIDERS[0];
}

export function wrapLocalModelSearchResults(
  providerId: LocalModelSearchProviderId,
  models: CatalogModel[],
): LocalModelSearchResult[] {
  const provider = getLocalModelSearchProvider(providerId);
  return models.map((model) => ({
    providerId,
    model,
    externalUrl:
      providerId === "huggingface"
        ? `https://huggingface.co/${model.hfRepo}`
        : providerId === "modelscope"
          ? `https://www.modelscope.cn/models/${model.hfRepo}`
          : undefined,
    download: {
      supported: provider.downloadSupported,
      ...(provider.downloadUnsupportedReason
        ? { reason: provider.downloadUnsupportedReason }
        : {}),
    },
  }));
}

export async function searchLocalModelProvider(
  providerId: LocalModelSearchProviderId,
  query: string,
  limit?: number,
): Promise<LocalModelSearchResponse> {
  void query;
  void limit;
  const provider = getLocalModelSearchProvider(providerId);
  return {
    provider,
    results: [],
    unavailableMessage: provider.unavailableMessage,
  };
}
