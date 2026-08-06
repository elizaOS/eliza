/**
 * Server-side search API client.
 *
 * Currently a stub — the app uses client-side search via client-search.ts.
 * When a backend search endpoint is available, swap clientSearch calls
 * in GlobalSearch.tsx for apiSearch.
 */
import type { SearchFilters, SearchResult } from "@/lib/types";

export interface SearchApiResponse {
  results: SearchResult[];
  total: number;
  took: number; // ms
}

export async function apiSearch(
  query: string,
  filters: SearchFilters = {},
  page = 0,
  pageSize = 20,
  apiUrl = ""
): Promise<SearchApiResponse> {
  const params = new URLSearchParams({ q: query, page: String(page), pageSize: String(pageSize) });

  if (filters.dateFrom) params.set("dateFrom", String(filters.dateFrom));
  if (filters.dateTo) params.set("dateTo", String(filters.dateTo));
  if (filters.role) params.set("role", filters.role);
  if (filters.conversationId) params.set("conversationId", filters.conversationId);
  if (filters.contentType) params.set("contentType", filters.contentType);
  if (filters.model) params.set("model", filters.model);
  if (filters.tagIds?.length) params.set("tagIds", filters.tagIds.join(","));

  const res = await fetch(`${apiUrl}/api/search?${params.toString()}`);
  if (!res.ok) throw new Error(`Search API error: ${res.status}`);
  return res.json() as Promise<SearchApiResponse>;
}
