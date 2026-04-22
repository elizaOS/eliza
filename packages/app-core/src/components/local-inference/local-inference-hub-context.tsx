import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client } from "../../api";
import type {
  ActiveModelState,
  DownloadJob,
  ExternalLlmRuntimeRow,
  ModelHubSnapshot,
} from "../../api/client-local-inference";
import { sortExternalRuntimes } from "../../services/local-inference/sort-external-runtimes";
import { resolveApiUrl } from "../../utils/asset-url";
import { getElizaApiToken } from "../../utils/eliza-globals";

function appendTokenParam(url: string): string {
  const token = getElizaApiToken()?.trim();
  if (!token) return url;
  const hasQuery = url.includes("?");
  return `${url}${hasQuery ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

export type LocalInferenceHubContextValue = {
  hub: ModelHubSnapshot | null;
  busy: boolean;
  refresh: (opts?: { forceExternalProbe?: boolean }) => Promise<void>;
  routingRefreshSignal: number;
  bumpRoutingRefresh: () => void;
  backends: ExternalLlmRuntimeRow[];
};

const LocalInferenceHubContext =
  createContext<LocalInferenceHubContextValue | null>(null);

/**
 * Shared hub snapshot + download SSE for **Local AI** probe cards and the
 * embedding strip (AI Models ↔ Embeddings).
 */
export function LocalInferenceHubProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [hub, setHub] = useState<ModelHubSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [routingRefreshSignal, setRoutingRefreshSignal] = useState(0);
  const eventSourceRef = useRef<EventSource | null>(null);

  const refresh = useCallback(
    async (opts?: { forceExternalProbe?: boolean }) => {
      setBusy(true);
      try {
        const snapshot = await client.getLocalInferenceHub(
          opts?.forceExternalProbe ? { forceExternalProbe: true } : undefined,
        );
        setHub(snapshot);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const url = resolveApiUrl("/api/local-inference/downloads/stream");
    const withToken = appendTokenParam(url);
    const es = new EventSource(withToken, { withCredentials: false });
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as
          | {
              type: "snapshot";
              downloads: DownloadJob[];
              active: ActiveModelState;
            }
          | {
              type: "progress" | "completed" | "failed" | "cancelled";
              job: DownloadJob;
            }
          | { type: "active"; active: ActiveModelState };

        if (payload.type === "snapshot") {
          setHub((prev) =>
            prev
              ? {
                  ...prev,
                  downloads: payload.downloads,
                  active: payload.active,
                }
              : prev,
          );
        } else if (payload.type === "active") {
          setHub((prev) => (prev ? { ...prev, active: payload.active } : prev));
        } else {
          setHub((prev) => {
            if (!prev) return prev;
            const others = prev.downloads.filter(
              (d) => d.modelId !== payload.job.modelId,
            );
            const downloads =
              payload.type === "completed" || payload.type === "cancelled"
                ? others
                : [...others, payload.job];
            return { ...prev, downloads };
          });
          if (payload.type === "completed") {
            void refresh();
          }
        }
      } catch {
        /* ignore */
      }
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [refresh]);

  const bumpRoutingRefresh = useCallback(() => {
    setRoutingRefreshSignal((n) => n + 1);
  }, []);

  const backends = useMemo(
    () => sortExternalRuntimes(hub?.externalRuntimes ?? []),
    [hub?.externalRuntimes],
  );

  const value = useMemo(
    () =>
      ({
        hub,
        busy,
        refresh,
        routingRefreshSignal,
        bumpRoutingRefresh,
        backends,
      }) satisfies LocalInferenceHubContextValue,
    [hub, busy, refresh, routingRefreshSignal, bumpRoutingRefresh, backends],
  );

  return (
    <LocalInferenceHubContext.Provider value={value}>
      {children}
    </LocalInferenceHubContext.Provider>
  );
}

export function useLocalInferenceHub(): LocalInferenceHubContextValue {
  const ctx = useContext(LocalInferenceHubContext);
  if (!ctx) {
    throw new Error(
      "useLocalInferenceHub must be used under LocalInferenceHubProvider",
    );
  }
  return ctx;
}
