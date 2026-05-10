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
import { ModelCard } from "./ModelCard";

interface HuggingFaceSearchProps {
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

/**
 * Secondary tab of the Model Hub: free-form HuggingFace search for any
 * GGUF-tagged repo. Results are shaped like CatalogModel so they render
 * with the same ModelCard the curated view uses.
 *
 * Debounced so a user typing a query doesn't hammer the HF API.
 */
export function HuggingFaceSearch({
  installed,
  downloads,
  active,
  hardware,
  onDownload,
  onCancel,
  onActivate,
  onUninstall,
  busy,
}: HuggingFaceSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastQueryRef = useRef<string>("");

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setError(null);
      lastQueryRef.current = "";
      return;
    }

    const handle = setTimeout(async () => {
      // Re-entry guard: if the user typed more while waiting, skip this
      // response and let the next timer handle it.
      lastQueryRef.current = trimmed;
      setLoading(true);
      setError(null);
      try {
        const response = await client.searchHuggingFaceGguf(trimmed);
        if (lastQueryRef.current === trimmed) {
          setResults(response.models);
        }
      } catch (err) {
        if (lastQueryRef.current === trimmed) {
          setError(err instanceof Error ? err.message : "Search failed");
          setResults([]);
        }
      } finally {
        if (lastQueryRef.current === trimmed) {
          setLoading(false);
        }
      }
    }, 400);

    return () => clearTimeout(handle);
  }, [query]);

  const handleDownloadClick = useCallback(
    (_modelId: string) => {
      // ModelCard hands us the catalog id; we need the full spec for HF
      // results since they aren't in the curated catalog. Look it up from
      // our results list.
      const spec = results.find((r) => r.id === _modelId);
      if (spec) onDownload(spec);
    },
    [onDownload, results],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search HuggingFace (e.g. phi-3, mixtral, llama 3.3)"
          className="flex-1 rounded-md border border-border bg-bg/50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
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

      {loading && (
        <div className="text-sm text-muted-foreground">
          Searching HuggingFace…
        </div>
      )}
      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-500">
          {error}
        </div>
      )}
      {!loading &&
        !error &&
        query.trim().length >= 2 &&
        results.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No GGUF repos matched. Try a different keyword.
          </div>
        )}

      {results.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {results.map((model) => (
            <ModelCard
              key={model.id}
              model={model}
              hardware={hardware}
              installed={installed}
              downloads={downloads}
              active={active}
              onDownload={handleDownloadClick}
              onCancel={onCancel}
              onActivate={onActivate}
              onUninstall={onUninstall}
              busy={busy}
            />
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Results are live HuggingFace repos tagged <code>gguf</code>, sorted by
        downloads. Eliza picks the best quant (preferring Q4_K_M) when a repo
        has several.
      </p>
    </div>
  );
}
