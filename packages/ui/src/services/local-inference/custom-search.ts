import { searchModelHubGguf } from "./hf-search";
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

const PROVIDERS: readonly LocalModelSearchProviderDescriptor[] = [
  {
    id: "huggingface",
    label: "Hugging Face",
    shortLabel: "HF",
    placeholder: "Search custom Hugging Face GGUF repos",
    searchSupported: true,
    downloadSupported: true,
  },
  {
    id: "modelscope",
    label: "ModelScope",
    shortLabel: "ModelScope",
    placeholder: "Search ModelScope owner or owner/model",
    searchSupported: true,
    downloadSupported: false,
    downloadUnsupportedReason:
      "ModelScope direct downloads are not implemented in this build.",
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
  const provider = getLocalModelSearchProvider(providerId);
  if (!provider.searchSupported) {
    return {
      provider,
      results: [],
      unavailableMessage: provider.unavailableMessage,
    };
  }

  if (provider.id === "huggingface" || provider.id === "modelscope") {
    const models = await searchModelHubGguf(query, provider.id, limit);
    return {
      provider,
      results: wrapLocalModelSearchResults(provider.id, models),
    };
  }

  return {
    provider,
    results: [],
    unavailableMessage: provider.unavailableMessage,
  };
}
