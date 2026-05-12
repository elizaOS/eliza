import { Button } from "@elizaos/ui";
import { CheckCircle2, Play } from "lucide-react";
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
import { AdvancedSettingsDisclosure } from "../settings/settings-control-primitives";
import { ActiveModelBar } from "./ActiveModelBar";
import { DeviceBridgeStatusBar } from "./DeviceBridgeStatus";
import { DevicesPanel } from "./DevicesPanel";
import { DownloadQueue } from "./DownloadQueue";
import { FirstRunOffer } from "./FirstRunOffer";
import { HardwareBadge } from "./HardwareBadge";
import { HuggingFaceSearch } from "./HuggingFaceSearch";
import { displayModelName } from "./hub-utils";
import { ModelHubView } from "./ModelHubView";
import { SlotAssignments } from "./SlotAssignments";

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
        setActionNotice(
          `Downloading ${displayModelName(spec)}`,
          "success",
          2000,
        );
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

  const handleVerify = useCallback(
    (modelId: string) => {
      void withBusy(async () => {
        const result = await client.verifyLocalInferenceModel(modelId);
        const tone =
          result.state === "ok"
            ? "success"
            : result.state === "unknown"
              ? "success"
              : "error";
        const message =
          result.state === "ok"
            ? "Model verified"
            : result.state === "unknown"
              ? "Baseline hash recorded — future verifies will compare against it"
              : result.state === "missing"
                ? "Model file is missing from disk"
                : result.state === "truncated"
                  ? "Model file is corrupt (not a valid GGUF)"
                  : "Model hash doesn't match the installed copy — re-download recommended";
        setActionNotice(message, tone, 4000);
        await refresh();
      });
    },
    [refresh, setActionNotice, withBusy],
  );

  const handleRedownload = useCallback(
    (modelId: string) => {
      void withBusy(async () => {
        // Uninstall + re-queue a fresh download. Safe for curated catalog
        // ids only; HF-search ad-hoc entries keep their install.
        await client.uninstallLocalInferenceModel(modelId);
        await client.startLocalInferenceDownload(modelId);
        setActionNotice("Redownload started", "success", 2000);
        await refresh();
      });
    },
    [refresh, setActionNotice, withBusy],
  );

  const handleAssignmentsChange = useCallback(
    (next: { [slot: string]: string | undefined }) => {
      setHub((prev) =>
        prev ? { ...prev, assignments: next as typeof prev.assignments } : prev,
      );
    },
    [],
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

  const catalog = hub.catalog.filter((model) =>
    model.id.startsWith("eliza-1-"),
  );

  return (
    <div className="flex flex-col gap-3">
      <HardwareBadge hardware={hub.hardware} />
      <DeviceBridgeStatusBar />
      <FirstRunOffer
        catalog={catalog}
        installed={hub.installed}
        downloads={hub.downloads}
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
      <nav className="inline-flex h-8 w-fit items-center rounded-lg border border-border/60 bg-bg/40 p-0.5">
        {(
          [
            ["curated", "Eliza-1"],
            ["search", "Custom HF"],
            ["downloads", "Downloads"],
          ] as const
        ).map(([id, label]) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`h-7 rounded-md px-2.5 text-xs font-medium transition-colors ${
                active
                  ? "bg-card text-txt shadow-sm"
                  : "text-muted hover:text-txt"
              }`}
            >
              <span className="inline-flex items-center gap-1.5">
                {label}
                {id === "downloads" && hub.downloads.length > 0 ? (
                  <span className="rounded-full border border-border/50 bg-card px-1.5 py-0.5 text-[10px] leading-none text-muted">
                    {hub.downloads.length}
                  </span>
                ) : null}
              </span>
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
          onVerify={handleVerify}
          onRedownload={handleRedownload}
          busy={busy}
        />
      )}

      {tab === "search" && (
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

      {tab === "downloads" && (
        <DownloadQueue
          downloads={hub.downloads}
          catalog={hub.catalog}
          onCancel={handleCancel}
        />
      )}

      <AdvancedSettingsDisclosure title="Local model assignments">
        <div className="flex flex-col gap-3">
          <SlotAssignments
            installed={hub.installed}
            assignments={hub.assignments}
            onChange={handleAssignmentsChange}
          />
          <DevicesPanel />
          <ExternalInstalledSummary
            installed={hub.installed}
            onActivate={handleActivate}
            active={hub.active}
            busy={busy}
          />
        </div>
      </AdvancedSettingsDisclosure>
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
  active: ActiveModelState;
  busy: boolean;
}) {
  const external = installed.filter((m) => m.source === "external-scan");
  if (external.length === 0) return null;

  return (
    <section className="space-y-2 border-t border-border/40 pt-3">
      <header>
        <h3
          className="text-[10px] font-medium uppercase tracking-wider text-muted"
          title="Eliza can load these models without re-downloading."
        >
          Discovered from other tools
        </h3>
      </header>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {external.map((m) => {
          const isActive = active.modelId === m.id && active.status !== "error";
          return (
            <div
              key={m.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-card/60 px-2 py-1.5"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-txt">
                  {displayModelName(m)}
                </div>
                <div className="truncate text-xs-tight text-muted">
                  {m.externalOrigin} · {formatSize(m.sizeBytes)}
                </div>
              </div>
              {isActive ? (
                <span
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-ok/35 bg-ok/10 text-ok"
                  title="Active"
                  role="img"
                  aria-label="Active"
                >
                  <CheckCircle2 className="h-4 w-4" aria-hidden />
                </span>
              ) : (
                <Button
                  size="sm"
                  className="h-7 rounded-md px-2 text-xs"
                  onClick={() => onActivate(m.id)}
                  disabled={busy}
                >
                  <Play className="h-3.5 w-3.5" aria-hidden />
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

export default LocalInferencePanel;

// Avoid "unused" lints for re-exports that consumers may want.
export type { CatalogModel, HardwareProbe, InstalledModel };
