import { Button } from "@elizaos/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../api";
import type {
  ActiveModelState,
  CatalogModel,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
  ModelHubSnapshot,
} from "../../api/client-local-inference";
import { useApp } from "../../state";
import { resolveApiUrl } from "../../utils/asset-url";
import { getElizaApiToken } from "../../utils/eliza-globals";
import { ActiveModelBar } from "./ActiveModelBar";
import { FirstRunOffer } from "./FirstRunOffer";
import { HardwareBadge } from "./HardwareBadge";
import { ModelHubView } from "./ModelHubView";

/**
 * Settings page entry for local inference. Owns the hub snapshot state,
 * subscribes to the download SSE stream, and dispatches mutations back
 * through the typed client helpers.
 */
export function LocalInferencePanel() {
  const { setActionNotice } = useApp();
  const [hub, setHub] = useState<ModelHubSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const refresh = useCallback(async () => {
    try {
      const snapshot = await client.getLocalInferenceHub();
      setHub(snapshot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load models");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    // Subscribe to server-side progress updates. EventSource doesn't allow
    // custom headers, so we pass the auth token as a query param — the
    // route's `isStreamAuthorized` accepts either source.
    const url = resolveApiUrl("/api/local-inference/downloads/stream");
    const withToken = appendTokenParam(url);
    const es = new EventSource(withToken, { withCredentials: false });
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as
          | { type: "snapshot"; downloads: DownloadJob[]; active: ActiveModelState }
          | { type: "progress" | "completed" | "failed" | "cancelled"; job: DownloadJob }
          | { type: "active"; active: ActiveModelState };

        if (payload.type === "snapshot") {
          setHub((prev) =>
            prev
              ? { ...prev, downloads: payload.downloads, active: payload.active }
              : prev,
          );
        } else if (payload.type === "active") {
          setHub((prev) => (prev ? { ...prev, active: payload.active } : prev));
        } else {
          // Single-job event: merge into the downloads list.
          setHub((prev) => {
            if (!prev) return prev;
            const others = prev.downloads.filter(
              (d) => d.modelId !== payload.job.modelId,
            );
            const downloads =
              payload.type === "completed" ||
              payload.type === "cancelled"
                ? others
                : [...others, payload.job];
            return { ...prev, downloads };
          });
          if (payload.type === "completed") {
            // A completed download adds to `installed`; refetch to pick it up.
            void refresh();
          }
        }
      } catch {
        // Ignore malformed events rather than blow away the panel.
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects; we only surface the error if it
      // outright closes.
      if (es.readyState === EventSource.CLOSED) {
        setError("Live updates disconnected");
      }
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [refresh]);

  const withBusy = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      try {
        return await fn();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setActionNotice(message, "error", 4000);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [setActionNotice],
  );

  const handleDownload = useCallback(
    (modelId: string) => {
      void withBusy(async () => {
        await client.startLocalInferenceDownload(modelId);
        setActionNotice("Download started", "success", 2000);
      });
    },
    [setActionNotice, withBusy],
  );

  const handleCancel = useCallback(
    (modelId: string) => {
      void withBusy(async () => {
        await client.cancelLocalInferenceDownload(modelId);
      });
    },
    [withBusy],
  );

  const handleActivate = useCallback(
    (modelId: string) => {
      void withBusy(async () => {
        const active = await client.setLocalInferenceActive(modelId);
        setHub((prev) => (prev ? { ...prev, active } : prev));
        if (active.status === "error") {
          setActionNotice(active.error ?? "Failed to activate", "error", 4000);
        } else if (active.status === "ready") {
          setActionNotice("Model activated", "success", 2000);
        }
      });
    },
    [setActionNotice, withBusy],
  );

  const handleUnload = useCallback(() => {
    void withBusy(async () => {
      const active = await client.clearLocalInferenceActive();
      setHub((prev) => (prev ? { ...prev, active } : prev));
    });
  }, [withBusy]);

  const handleUninstall = useCallback(
    (modelId: string) => {
      void withBusy(async () => {
        await client.uninstallLocalInferenceModel(modelId);
        setActionNotice("Model uninstalled", "success", 2000);
        await refresh();
      });
    },
    [refresh, setActionNotice, withBusy],
  );

  if (error && !hub) {
    return (
      <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm">
        {error}{" "}
        <Button size="sm" variant="outline" onClick={refresh}>
          Retry
        </Button>
      </div>
    );
  }

  if (!hub) {
    return (
      <div className="text-sm text-muted-foreground">Loading local models…</div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <HardwareBadge hardware={hub.hardware} />
      <FirstRunOffer
        catalog={hub.catalog}
        installed={hub.installed}
        hardware={hub.hardware}
        onDownload={handleDownload}
        busy={busy}
      />
      <ActiveModelBar
        active={hub.active}
        installed={hub.installed}
        onUnload={handleUnload}
        busy={busy}
      />
      <ModelHubView
        catalog={hub.catalog}
        installed={hub.installed}
        downloads={hub.downloads}
        active={hub.active}
        hardware={hub.hardware}
        onDownload={handleDownload}
        onCancel={handleCancel}
        onActivate={handleActivate}
        onUninstall={handleUninstall}
        busy={busy}
      />
      <ExternalInstalledSummary
        installed={hub.installed}
        onActivate={handleActivate}
        onUninstall={handleUninstall}
        active={hub.active}
        busy={busy}
      />
    </div>
  );
}

function ExternalInstalledSummary({
  installed,
  onActivate,
  onUninstall,
  active,
  busy,
}: {
  installed: InstalledModel[];
  onActivate: (id: string) => void;
  onUninstall: (id: string) => void;
  active: ActiveModelState;
  busy: boolean;
}) {
  const external = installed.filter((m) => m.source === "external-scan");
  if (external.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Discovered from other tools
      </h3>
      <p className="text-xs text-muted-foreground">
        Milady can load these models without re-downloading. We never modify
        files owned by another tool.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {external.map((m) => {
          const isActive = active.modelId === m.id && active.status !== "error";
          return (
            <div
              key={m.id}
              className="rounded-xl border border-border bg-card p-3 flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{m.displayName}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {m.externalOrigin} · {formatSize(m.sizeBytes)}
                </div>
              </div>
              {isActive ? (
                <Button size="sm" variant="outline" disabled>
                  Active
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => onActivate(m.id)}
                  disabled={busy}
                >
                  Activate
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function formatSize(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function appendTokenParam(url: string): string {
  const token = getElizaApiToken()?.trim();
  if (!token) return url;
  const hasQuery = url.includes("?");
  return `${url}${hasQuery ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

/**
 * Drop-in exports for prop-less consumption by the settings panel.
 */
export default LocalInferencePanel;

// Avoid "unused" lints for re-exports that consumers may want.
export type { CatalogModel, HardwareProbe, InstalledModel };
