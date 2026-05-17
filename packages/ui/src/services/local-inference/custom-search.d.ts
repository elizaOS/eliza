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
export declare const DEFAULT_LOCAL_MODEL_SEARCH_PROVIDER_ID: LocalModelSearchProviderId;
export declare function listLocalModelSearchProviders(): LocalModelSearchProviderDescriptor[];
export declare function isLocalModelSearchProviderId(
  value: string,
): value is LocalModelSearchProviderId;
export declare function getLocalModelSearchProvider(
  id: LocalModelSearchProviderId,
): LocalModelSearchProviderDescriptor;
export declare function wrapLocalModelSearchResults(
  providerId: LocalModelSearchProviderId,
  models: CatalogModel[],
): LocalModelSearchResult[];
export declare function searchLocalModelProvider(
  providerId: LocalModelSearchProviderId,
  query: string,
  limit?: number,
): Promise<LocalModelSearchResponse>;
//# sourceMappingURL=custom-search.d.ts.map
