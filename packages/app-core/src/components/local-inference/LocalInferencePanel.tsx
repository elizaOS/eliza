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
import { isAndroid, isIOS } from "../../platform/init";
import { useApp } from "../../state";
import { resolveApiUrl } from "../../utils/asset-url";
import { getElizaApiToken } from "../../utils/eliza-globals";
import { ActiveModelBar } from "./ActiveModelBar";
import { DeviceBridgeStatusBar } from "./DeviceBridgeStatus";
import { DownloadQueue } from "./DownloadQueue";
import { FirstRunOffer } from "./FirstRunOffer";
import { HardwareBadge } from "./HardwareBadge";
import { HuggingFaceSearch } from "./HuggingFaceSearch";
import { ModelHubView } from "./ModelHubView";

/**
 * Settings page entry for local inference. Owns the hub snapshot state,
 * subscribes to the download SSE stream, and dispatches mutations back
 * through the typed client helpers.
 */
type HubTab = "curated" | "search" | "downloads";

export function LocalInferencePanel() {
  const { setActionNotice } = useApp();
  const [hub, setHub] = useState<ModelHubSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<HubTab>("curated");
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
          // Single-job event: merge into the downloads list.
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

  const handleDownloadSpec = useCallback(
    (spec: CatalogModel) => {
      void withBusy(async () => {
        await client.startLocalInferenceDownload(spec);
        setActionNotice(`Downloading ${spec.displayName}`, "success", 2000);
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
      <div className="flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
        <span>{error}</span>
        <Button
          size="sm"
          variant="outline"
          className="h-8 rounded-lg"
          onClick={refresh}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (!hub) {
    return <p className="text-sm text-muted">Loading local models…</p>;
  }

  // On mobile (Capacitor iOS / Android) users can only realistically run
  // small and tiny models, so we hide the larger buckets entirely and
  // surface a note about the mobile runtime story. The server-side
  // catalog is unchanged; this is a pure display filter.
  const mobile = isIOS || isAndroid;
  const catalog = mobile
    ? hub.catalog.filter(
        (m) =>
          m.bucket === "small" &&
          (m.params === "1B" || m.params === "1.7B" || m.params === "3B"),
      )
    : hub.catalog;

  return (
    <div className="flex flex-col gap-4">
      <HardwareBadge hardware={hub.hardware} />
      <DeviceBridgeStatusBar />
      {mobile && (
        <div className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          On-device inference on mobile requires the Milady native runtime
          plugin (follow-up). Until then, select a small model and Milady will
          run inference via the companion desktop or cloud server.
        </div>
      )}
      <FirstRunOffer
        catalog={catalog}
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
      <nav className="flex gap-4 border-b border-border/40">
        {(
          [
            ["curated", "Curated"],
            ["search", "Search HuggingFace"],
            [
              "downloads",
              `Downloads${hub.downloads.length > 0 ? ` (${hub.downloads.length})` : ""}`,
            ],
          ] as const
        ).map(([id, label]) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`-mb-px border-b-2 px-1 pb-2 text-sm font-medium transition-colors ${
                active
                  ? "border-accent text-txt"
                  : "border-transparent text-muted hover:text-txt"
              }`}
            >
              {label}
            </button>
          );
        })}
      </nav>

      {tab === "curated" && (
        <ModelHubView
          catalog={catalog}
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
      )}

      {tab === "search" && !mobile && (
        <HuggingFaceSearch
          installed={hub.installed}
          downloads={hub.downloads}
          active={hub.active}
          hardware={hub.hardware}
          onDownload={handleDownloadSpec}
          onCancel={handleCancel}
          onActivate={handleActivate}
          onUninstall={handleUninstall}
          busy={busy}
        />
      )}
      {tab === "search" && mobile && (
        <p className="text-sm text-muted">
          HuggingFace search is desktop-only for now — most results would be too
          large for a phone.
        </p>
      )}

      {tab === "downloads" && (
        <DownloadQueue
          downloads={hub.downloads}
          catalog={hub.catalog}
          onCancel={handleCancel}
        />
      )}

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
    <section className="space-y-2 border-t border-border/40 pt-4">
      <header className="space-y-0.5">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
          Discovered from other tools
        </h3>
        <p className="text-xs-tight text-muted">
          Milady can load these models without re-downloading. We never modify
          files owned by another tool.
        </p>
      </header>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {external.map((m) => {
          const isActive = active.modelId === m.id && active.status !== "error";
          return (
            <div
              key={m.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-card/60 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-txt">
                  {m.displayName}
                </div>
                <div className="truncate text-xs-tight text-muted">
                  {m.externalOrigin} · {formatSize(m.sizeBytes)}
                </div>
              </div>
              {isActive ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 rounded-lg"
                  disabled
                >
                  Active
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="h-8 rounded-lg"
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
  return gb >= 1
    ? `${gb.toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
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
