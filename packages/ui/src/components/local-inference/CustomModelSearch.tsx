import { Button } from "@elizaos/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../api";
import type {
  ActiveModelState,
  CatalogModel,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
} from "../../api/client-local-inference";
import {
  DEFAULT_LOCAL_MODEL_SEARCH_PROVIDER_ID,
  getLocalModelSearchProvider,
  type LocalModelSearchProviderId,
  type LocalModelSearchResult,
  listLocalModelSearchProviders,
  wrapLocalModelSearchResults,
} from "../../services/local-inference/custom-search";
import { ModelCard } from "./ModelCard";

interface CustomModelSearchProps {
  installed: InstalledModel[];
  downloads: DownloadJob[];
  active: ActiveModelState;
  hardware: HardwareProbe;
  onDownload: (spec: CatalogModel) => void;
  onCancel: (modelId: string) => void;
  onActivate: (modelId: string) => void;
  onUninstall: (modelId: string) => void;
  busy: boolean;
}

const SEARCH_PROVIDERS = listLocalModelSearchProviders();

async function searchProviderViaClient(
  providerId: LocalModelSearchProviderId,
  query: string,
): Promise<LocalModelSearchResult[]> {
  if (providerId === "huggingface" || providerId === "modelscope") {
    const response = await client.searchHuggingFaceGguf(
      query,
      undefined,
      providerId,
    );
    return wrapLocalModelSearchResults(providerId, response.models);
  }
  return [];
}

/**
 * Explicit custom search tab. Curated defaults stay Eliza-1 only; anything
 * from a third-party hub must be searched for here and selected manually.
 */
export function CustomModelSearch({
  installed,
  downloads,
  active,
  hardware,
  onDownload,
  onCancel,
  onActivate,
  onUninstall,
  busy,
}: CustomModelSearchProps) {
  const [providerId, setProviderId] = useState<LocalModelSearchProviderId>(
    DEFAULT_LOCAL_MODEL_SEARCH_PROVIDER_ID,
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LocalModelSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastRequestRef = useRef<string>("");
  const provider = getLocalModelSearchProvider(providerId);

  useEffect(() => {
    const trimmed = query.trim();
    const requestKey = `${providerId}:${trimmed}`;
    if (trimmed.length < 2) {
      setResults([]);
      setError(null);
      setLoading(false);
      lastRequestRef.current = "";
      return;
    }

    if (!provider.searchSupported) {
      lastRequestRef.current = requestKey;
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }

    lastRequestRef.current = requestKey;
    const handle = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const nextResults = await searchProviderViaClient(providerId, trimmed);
        if (lastRequestRef.current === requestKey) {
          setResults(nextResults);
        }
      } catch (err) {
        if (lastRequestRef.current === requestKey) {
          setError(err instanceof Error ? err.message : "Search failed");
          setResults([]);
        }
      } finally {
        if (lastRequestRef.current === requestKey) {
          setLoading(false);
        }
      }
    }, 400);

    return () => clearTimeout(handle);
  }, [provider.searchSupported, providerId, query]);

  const handleDownloadClick = useCallback(
    (modelId: string) => {
      const result = results.find((entry) => entry.model.id === modelId);
      if (result?.download.supported) onDownload(result.model);
    },
    [onDownload, results],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <fieldset
          className="inline-flex h-8 items-center rounded-lg border border-border/60 bg-bg/40 p-0.5"
          aria-label="Custom model search provider"
        >
          {SEARCH_PROVIDERS.map((candidate) => {
            const activeProvider = providerId === candidate.id;
            return (
              <button
                key={candidate.id}
                type="button"
                aria-pressed={activeProvider}
                onClick={() => {
                  setProviderId(candidate.id);
                  setResults([]);
                  setError(null);
                }}
                className={`h-7 rounded-md px-2.5 text-xs font-medium transition-colors ${
                  activeProvider
                    ? "bg-card text-txt shadow-sm"
                    : "text-muted hover:text-txt"
                }`}
              >
                {candidate.shortLabel}
              </button>
            );
          })}
        </fieldset>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={provider.placeholder}
          disabled={!provider.searchSupported}
          className="min-w-64 flex-1 rounded-md border border-border bg-bg/50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-70"
        />
        {query.trim().length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setQuery("");
              setResults([]);
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {!provider.searchSupported && provider.unavailableMessage && (
        <div className="rounded-md border border-border/60 bg-card/50 p-3 text-muted-foreground text-xs">
          {provider.unavailableMessage}
        </div>
      )}
      {loading && (
        <div className="text-muted-foreground text-sm">
          Searching {provider.label}...
        </div>
      )}
      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-rose-500 text-xs">
          {error}
        </div>
      )}
      {!loading &&
        !error &&
        provider.searchSupported &&
        query.trim().length >= 2 &&
        results.length === 0 && (
          <div className="text-muted-foreground text-sm">
            No GGUF repos matched. Try a different keyword or owner/model id.
          </div>
        )}

      {results.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {results.map((result) => (
            <ModelCard
              key={result.model.id}
              model={result.model}
              hardware={hardware}
              installed={installed}
              downloads={downloads}
              active={active}
              onDownload={handleDownloadClick}
              onCancel={onCancel}
              onActivate={onActivate}
              onUninstall={onUninstall}
              downloadDisabledReason={
                result.download.supported ? undefined : result.download.reason
              }
              busy={busy}
            />
          ))}
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        Custom search results are explicit opt-in only. They are never
        recommended, auto-selected, or used as the default local model.
      </p>
    </div>
  );
}
