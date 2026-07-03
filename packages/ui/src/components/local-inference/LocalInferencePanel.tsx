import type { VoiceModelId } from "@elizaos/shared";
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
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { useRole } from "../../hooks/useRole";
import { filterSettingsDefaultLocalModels } from "../../services/local-inference/catalog-policy";
import { useAppSelectorShallow } from "../../state";
import { resolveApiUrl } from "../../utils/asset-url";
import { getElizaApiToken } from "../../utils/eliza-globals";
import { openEventSource } from "../../utils/event-source";
import { AdvancedSettingsDisclosure } from "../settings/settings-control-primitives";
import { Button } from "../ui/button";
import { ActiveModelBar } from "./ActiveModelBar";
import { DeviceBridgeStatusBar } from "./DeviceBridgeStatus";
import { DevicesPanel } from "./DevicesPanel";
import { DownloadQueue } from "./DownloadQueue";
import { FirstRunOffer } from "./FirstRunOffer";
import { HardwareBadge } from "./HardwareBadge";
import { ModelHubView } from "./ModelHubView";
import type {
  VoiceModelInstallationView,
  VoiceUpdatePreferencesView,
} from "./ModelUpdatesPanel";
import { ModelUpdatesPanel } from "./ModelUpdatesPanel";
import { useDeviceBridgeStatus } from "./useDeviceBridgeStatus";

type HubTab = "curated" | "downloads";

export function LocalInferencePanel() {
  useRenderGuard("LocalInferencePanel");
  const { setActionNotice, t } = useAppSelectorShallow((s) => ({
    setActionNotice: s.setActionNotice,
    t: s.t,
  }));
  const [hub, setHub] = useState<ModelHubSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<HubTab>("curated");
  const eventSourceRef = useRef<EventSource | null>(null);
  const deviceBridgeStatus = useDeviceBridgeStatus();

  const refresh = useCallback(async () => {
    try {
      const snapshot = await client.getLocalInferenceHub();
      setHub(snapshot);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("localinference.loadError", {
              defaultValue: "Failed to load models",
            }),
      );
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    // Subscribe to server-side progress updates. EventSource doesn't allow
    // custom headers, so we pass the auth token as a query param — the
    // route's `isStreamAuthorized` accepts either source.
    const url = resolveApiUrl("/api/local-inference/downloads/stream");
    const withToken = appendTokenParam(url);
    // On-device runtimes are reached over the native IPC base, which
    // EventSource cannot open; skip live updates there rather than throwing.
    const es = openEventSource(withToken, { withCredentials: false });
    eventSourceRef.current = es;
    if (!es) return;

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
        setError(
          t("localinference.liveDisconnected", {
            defaultValue: "Live updates disconnected",
          }),
        );
      }
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [refresh, t]);

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
        setActionNotice(
          t("localinference.downloadStarted", {
            defaultValue: "Download started",
          }),
          "success",
          2000,
        );
      });
    },
    [setActionNotice, withBusy, t],
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
          setActionNotice(
            active.error ??
              t("localinference.activateError", {
                defaultValue: "Failed to activate",
              }),
            "error",
            4000,
          );
        } else if (active.status === "ready") {
          setActionNotice(
            t("localinference.modelActivated", {
              defaultValue: "Model activated",
            }),
            "success",
            2000,
          );
        }
      });
    },
    [setActionNotice, withBusy, t],
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
        setActionNotice(
          t("localinference.modelUninstalled", {
            defaultValue: "Model uninstalled",
          }),
          "success",
          2000,
        );
        await refresh();
      });
    },
    [refresh, setActionNotice, withBusy, t],
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
            ? t("localinference.verifyOk", { defaultValue: "Model verified" })
            : result.state === "unknown"
              ? t("localinference.verifyUnknown", {
                  defaultValue:
                    "Baseline hash recorded — future verifies will compare against it",
                })
              : result.state === "missing"
                ? t("localinference.verifyMissing", {
                    defaultValue: "Model file is missing from disk",
                  })
                : result.state === "truncated"
                  ? t("localinference.verifyTruncated", {
                      defaultValue: "Model file is corrupt (not a valid GGUF)",
                    })
                  : t("localinference.verifyMismatch", {
                      defaultValue:
                        "Model hash doesn't match the installed copy — re-download recommended",
                    });
        setActionNotice(message, tone, 4000);
        await refresh();
      });
    },
    [refresh, setActionNotice, withBusy, t],
  );

  const handleRedownload = useCallback(
    (modelId: string) => {
      void withBusy(async () => {
        // Uninstall + re-queue a fresh download. Safe for curated catalog
        // ids only; HF-search ad-hoc entries keep their install.
        await client.uninstallLocalInferenceModel(modelId);
        await client.startLocalInferenceDownload(modelId);
        setActionNotice(
          t("localinference.redownloadStarted", {
            defaultValue: "Redownload started",
          }),
          "success",
          2000,
        );
        await refresh();
      });
    },
    [refresh, setActionNotice, withBusy, t],
  );

  if (error && !hub) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
        <span>{error}</span>
        <Button
          size="sm"
          variant="outline"
          className="h-8 rounded-sm"
          onClick={refresh}
        >
          {t("localinference.retry", { defaultValue: "Retry" })}
        </Button>
      </div>
    );
  }

  if (!hub) {
    return (
      <p className="text-sm text-muted">
        {t("localinference.loading", {
          defaultValue: "Loading local models…",
        })}
      </p>
    );
  }

  const catalog = filterSettingsDefaultLocalModels(hub.catalog);

  return (
    <div className="flex flex-col gap-3">
      <HardwareBadge hardware={hub.hardware} />
      <DeviceBridgeStatusBar status={deviceBridgeStatus} />
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
      <nav className="inline-flex h-8 w-fit items-center rounded-sm border border-border/60 bg-bg/40 p-0.5">
        {(
          [
            ["curated", "Eliza-1"],
            [
              "downloads",
              t("localinference.tabDownloads", { defaultValue: "Downloads" }),
            ],
          ] as const
        ).map(([id, label]) => {
          const active = tab === id;
          return (
            <Button
              key={id}
              variant="ghost"
              onClick={() => setTab(id)}
              className={`h-7 rounded-sm px-2.5 text-xs font-medium transition-colors ${
                active ? "bg-card text-txt " : "text-muted hover:text-txt"
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
            </Button>
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

      {tab === "downloads" && (
        <DownloadQueue
          downloads={hub.downloads}
          catalog={hub.catalog}
          onCancel={handleCancel}
          onRetry={handleDownload}
        />
      )}

      <VoiceModelUpdatesSection />

      <AdvancedSettingsDisclosure
        title={t("localinference.devicesTitle", {
          defaultValue: "Local runtime devices",
        })}
        lazy
      >
        <DevicesPanel status={deviceBridgeStatus} />
      </AdvancedSettingsDisclosure>
    </div>
  );
}

function appendTokenParam(url: string): string {
  const token = getElizaApiToken()?.trim();
  if (!token) return url;
  const hasQuery = url.includes("?");
  return `${url}${hasQuery ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

/**
 * Voice sub-model auto-updater UI section (R5-versioning §5).
 *
 * Driven by the live `/api/local-inference/voice-models/*` compat routes
 * exposed by `plugin-local-inference/src/routes/voice-models-routes.ts`.
 * The routes resolve installed versions from `<state-dir>/models/voice/`,
 * walk the Cloud → GitHub → HF cascade for updates, and gate downloads
 * on the network policy decision. Preferences land at
 * `<state-dir>/local-inference/voice-update-prefs.json` and the
 * cellular/metered toggles are OWNER-only.
 */
function VoiceModelUpdatesSection() {
  const { setActionNotice, t } = useAppSelectorShallow((s) => ({
    setActionNotice: s.setActionNotice,
    t: s.t,
  }));
  const [preferences, setPreferences] = useState<VoiceUpdatePreferencesView>({
    autoUpdateOnWifi: true,
    autoUpdateOnCellular: false,
    autoUpdateOnMetered: false,
  });
  // #12087 Item 25: owner-tier gating comes from the canonical role context, not
  // a per-endpoint `isOwner` flag threaded through fetched state. The
  // voice-preferences endpoint's owner flag is no longer consumed here.
  const { isOwner } = useRole();
  const [installations, setInstallations] = useState<
    ReadonlyArray<VoiceModelInstallationView>
  >([]);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  // Bootstrap from the live API.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [prefsResp, listResp] = await Promise.all([
          client.getVoiceModelPreferences(),
          client.listVoiceModels(),
        ]);
        if (cancelled) return;
        setPreferences({
          autoUpdateOnWifi: prefsResp.preferences.autoUpdateOnWifi,
          autoUpdateOnCellular: prefsResp.preferences.autoUpdateOnCellular,
          autoUpdateOnMetered: prefsResp.preferences.autoUpdateOnMetered,
        });
        setInstallations(
          listResp.installations.map((i) => ({
            id: i.id,
            installedVersion: i.installedVersion,
            pinned: i.pinned,
            lastError: i.lastError,
          })),
        );
      } catch (err) {
        console.warn("[voice-models] bootstrap failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onCheckNow = useCallback(async () => {
    setChecking(true);
    try {
      const res = await client.checkVoiceModelUpdates({ force: true });
      setLastCheckedAt(res.lastCheckedAt);
      const list = await client.listVoiceModels();
      setInstallations(list.installations);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setActionNotice(
        t("localinference.updateCheckFailed", {
          message,
          defaultValue: "Update check failed: {{message}}",
        }),
        "error",
        4000,
      );
    } finally {
      setChecking(false);
    }
  }, [setActionNotice, t]);

  const onUpdateNow = useCallback(
    async (id: VoiceModelId) => {
      try {
        await client.triggerVoiceModelUpdate(id);
        const list = await client.listVoiceModels();
        setInstallations(list.installations);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setActionNotice(
          t("localinference.updateFailed", {
            message,
            defaultValue: "Update failed: {{message}}",
          }),
          "error",
          4000,
        );
      }
    },
    [setActionNotice, t],
  );

  const onTogglePin = useCallback(
    async (id: VoiceModelId, pinned: boolean) => {
      try {
        await client.pinVoiceModel(id, pinned);
        const list = await client.listVoiceModels();
        setInstallations(list.installations);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setActionNotice(
          pinned
            ? t("localinference.pinFailed", {
                message,
                defaultValue: "Pin failed: {{message}}",
              })
            : t("localinference.unpinFailed", {
                message,
                defaultValue: "Unpin failed: {{message}}",
              }),
          "error",
          4000,
        );
      }
    },
    [setActionNotice, t],
  );

  const onSetPreferences = useCallback(
    async (next: VoiceUpdatePreferencesView) => {
      // Optimistic update — revert to the prior value on failure so the
      // OWNER gate's 403 is visible (the flipped toggle snaps back).
      let previous: VoiceUpdatePreferencesView | null = null;
      setPreferences((prev) => {
        previous = prev;
        return next;
      });
      try {
        const res = await client.setVoiceModelPreferences({
          autoUpdateOnWifi: next.autoUpdateOnWifi,
          autoUpdateOnCellular: next.autoUpdateOnCellular,
          autoUpdateOnMetered: next.autoUpdateOnMetered,
        });
        setPreferences({
          autoUpdateOnWifi: res.preferences.autoUpdateOnWifi,
          autoUpdateOnCellular: res.preferences.autoUpdateOnCellular,
          autoUpdateOnMetered: res.preferences.autoUpdateOnMetered,
        });
      } catch (err) {
        if (previous) setPreferences(previous);
        const message = err instanceof Error ? err.message : String(err);
        setActionNotice(
          t("localinference.savePrefFailed", {
            message,
            defaultValue: "Could not save preference: {{message}}",
          }),
          "error",
          4000,
        );
      }
    },
    [setActionNotice, t],
  );

  return (
    <ModelUpdatesPanel
      installations={installations}
      preferences={preferences}
      isOwner={isOwner}
      lastCheckedAt={lastCheckedAt}
      checking={checking}
      onCheckNow={onCheckNow}
      onUpdateNow={onUpdateNow}
      onTogglePin={onTogglePin}
      onSetPreferences={onSetPreferences}
    />
  );
}

export default LocalInferencePanel;

// Avoid "unused" lints for re-exports that consumers may want.
export type { CatalogModel, HardwareProbe, InstalledModel };
