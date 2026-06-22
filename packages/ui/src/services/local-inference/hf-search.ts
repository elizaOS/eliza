import type { CatalogModel } from "./types";

export const CUSTOM_MODEL_SEARCH_DISABLED_MESSAGE =
  "Custom model search is disabled; local inference uses curated Eliza-1 bundles only.";

/**
 * Compatibility shim for older callers. Consumer local inference no longer
 * searches third-party hubs; setup is managed through the curated Eliza-1
 * bundles registered in the catalog.
 */
export async function searchHuggingFaceGguf(
  query: string,
  limit = 12,
): Promise<CatalogModel[]> {
  void query;
  void limit;
  return [];
}

export async function searchModelScopeGguf(
  query: string,
  limit = 12,
): Promise<CatalogModel[]> {
  void query;
  void limit;
  return [];
}

export async function searchModelHubGguf(
  query: string,
  hub: "huggingface" | "modelscope" = "huggingface",
  limit = 12,
): Promise<CatalogModel[]> {
  void query;
  void hub;
  void limit;
  return [];
}
