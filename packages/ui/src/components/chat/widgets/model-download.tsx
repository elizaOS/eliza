import { Download, Loader2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../../api";
import {
  deriveHomeModelStatus,
  type HomeModelStatus,
} from "../../../services/local-inference/home-model-status";
import type { LocalInferenceSlotReadiness } from "../../../services/local-inference/types";
import { resolveApiUrl } from "../../../utils/asset-url";
import { getElizaApiToken } from "../../../utils/eliza-globals";
import { openEventSource } from "../../../utils/event-source";
import { withTimeout } from "../../../utils/with-timeout";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";

const DEFAULT_SPAN = "col-span-2 row-span-1";
// Bound the hub fetch so a hung native bridge settles the tile (to not-required
// → null) instead of spinning forever — the same stuck-loading bug other home
// widgets guard against. The native IPC base can hang indefinitely early in boot.
const HUB_TIMEOUT_MS = 6_000;
// Debounce a hub refetch after each download-stream delta, matching the
// useHomeModelStatus cadence (the stream carries deltas, not recomputed
// readiness, so we refetch the authoritative `textReadiness`).
const STREAM_REFETCH_DEBOUNCE_MS = 400;
// Local-inference settings surface — the AI-model settings section hosts the
// LocalInferencePanel (model catalog / downloads / active). Selected via the
// settings hash (`#ai-model`), which SettingsView reads on mount + hashchange.
// Opened on tap for any non-error state.
const LOCAL_INFERENCE_VIEW_PATH = "/settings#ai-model";
const LOCAL_INFERENCE_VIEW_ID = "settings";

/**
 * A single assigned local text slot's download row. Derived from
 * `hub.textReadiness.slots`, skipping unassigned slots. Carries the failed
 * model id so the error state can re-enqueue exactly the model that failed.
 */
interface LocalModelRow {
  slot: LocalInferenceSlotReadiness["slot"];
  modelId: string | null;
  displayName: string | null;
  state: LocalInferenceSlotReadiness["state"];
}

interface LocalModelDownloads {
  /** Collapsed single-line status (max percent/eta across both text slots). */
  status: HomeModelStatus;
  /** Per-assigned-slot rows (failed-model id lives here for retry). */
  rows: LocalModelRow[];
  /** True until the first hub fetch settles — distinguishes loading from ready. */
  loading: boolean;
}

const NOT_REQUIRED_STATUS: HomeModelStatus = {
  kind: "not-required",
  blocksSend: false,
  percent: null,
  etaMs: null,
  modelName: null,
  errors: [],
};

const INITIAL: LocalModelDownloads = {
  status: NOT_REQUIRED_STATUS,
  rows: [],
  loading: true,
};

function appendTokenParam(url: string): string {
  const token = getElizaApiToken()?.trim();
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

function rowsFromReadiness(
  slots: Record<
    LocalInferenceSlotReadiness["slot"],
    LocalInferenceSlotReadiness
  >,
): LocalModelRow[] {
  return Object.values(slots)
    .filter((slot) => slot.assigned)
    .map((slot) => ({
      slot: slot.slot,
      modelId: slot.assignedModelId,
      displayName: slot.displayName,
      state: slot.state,
    }));
}

/**
 * Live reader for the local-inference download surface. ONE hub fetch (bounded
 * by `withTimeout`) seeds both the collapsed `deriveHomeModelStatus` status and
 * the per-slot rows, then a download-stream subscription debounces a refetch to
 * pick up fresh `textReadiness`. Mirrors `useHomeModelStatus` exactly (token
 * param + `openEventSource` native-IPC fallback), but also exposes the raw rows
 * so the error state can retry the specific failed model.
 *
 * On-device runtimes addressed via the native IPC base cannot open an
 * EventSource (`openEventSource` returns null) — the hook then relies on the
 * single initial fetch and never spins a render-loop poll.
 */
export function useLocalModelDownloads(): LocalModelDownloads {
  const [state, setState] = useState<LocalModelDownloads>(INITIAL);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const hub = await withTimeout(
          client.getLocalInferenceHub(),
          HUB_TIMEOUT_MS,
        );
        if (cancelled) return;
        setState({
          status: deriveHomeModelStatus(hub.textReadiness),
          rows: rowsFromReadiness(hub.textReadiness.slots),
          loading: false,
        });
      } catch {
        // Settle (keep last-good status, drop the loading flag) so the tile
        // resolves to not-required/null instead of spinning. A hung native
        // bridge or a transient error must never leave a permanent "Loading…".
        if (cancelled) return;
        setState((prev) => (prev.loading ? { ...prev, loading: false } : prev));
      }
    };

    void refresh();

    const url = appendTokenParam(
      resolveApiUrl("/api/local-inference/downloads/stream"),
    );
    const es = openEventSource(url, { withCredentials: false });
    if (es) {
      es.onmessage = () => {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(
          () => void refresh(),
          STREAM_REFETCH_DEBOUNCE_MS,
        );
      };
    }

    return () => {
      cancelled = true;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      es?.close();
    };
  }, []);

  return state;
}

function roundedPercent(percent: number | null): number | null {
  if (percent == null || !Number.isFinite(percent)) return null;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/** Compact ETA, e.g. "~3m left", "~45s left". Null when the ETA is unknown. */
function formatEta(etaMs: number | null): string | null {
  if (etaMs == null || !Number.isFinite(etaMs) || etaMs <= 0) return null;
  const totalSeconds = Math.round(etaMs / 1000);
  if (totalSeconds < 60) return `~${totalSeconds}s left`;
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `~${minutes}m left`;
  const hours = Math.round(minutes / 60);
  return `~${hours}h left`;
}

/**
 * MODEL DOWNLOAD home widget (id `local-inference.model-download`). A naked 2x1
 * tile that surfaces the recommended local text model's download as the user
 * lands on home — queued / downloading-% / loading / failed-with-retry — so a
 * fresh on-device agent shows progress instead of a dead chat.
 *
 * Self-hides (renders null) when no local text slot is assigned (cloud/remote
 * runtime → `not-required`) or every assigned slot is ready (`ready`): a
 * zero-setup widget with nothing to show, matching the home self-hide rule.
 *
 * On error (any slot failed/cancelled) the whole card becomes a RETRY control:
 * tapping re-enqueues the failed model's download (the downloader resumes from
 * the `.part` staging file) and optimistically flips to downloading; the
 * download stream reconciles. In every other state, tapping opens the
 * local-inference settings surface to manage models.
 */
export function ModelDownloadWidget({
  spanClassName = DEFAULT_SPAN,
}: Partial<WidgetProps>) {
  const { status, rows, loading } = useLocalModelDownloads();
  const nav = useWidgetNavigation();
  // Optimistic flip after a retry tap, cleared once the stream refetch reports a
  // non-error state. Lets the card show "downloading" immediately on retry.
  const [retrying, setRetrying] = useState(false);

  const failedRow = rows.find(
    (row) => row.state === "failed" || row.state === "cancelled",
  );
  const failedModelId = failedRow?.modelId ?? null;

  useEffect(() => {
    if (status.kind !== "error") setRetrying(false);
  }, [status.kind]);

  const retry = useCallback(async () => {
    if (!failedModelId) {
      nav.openView(LOCAL_INFERENCE_VIEW_PATH, LOCAL_INFERENCE_VIEW_ID);
      return;
    }
    setRetrying(true);
    try {
      await client.startLocalInferenceDownload(failedModelId);
    } catch {
      // Re-enqueue failed (e.g. all tiers pending on the hub) — drop the
      // optimistic flip so the error state (with its retry affordance) returns.
      setRetrying(false);
    }
  }, [failedModelId, nav]);

  const openSettings = useCallback(() => {
    nav.openView(LOCAL_INFERENCE_VIEW_PATH, LOCAL_INFERENCE_VIEW_ID);
  }, [nav]);

  // Hold the first render until the initial hub fetch settles — never show a
  // value until we know whether a local model is even required.
  if (loading) return null;

  // Self-hide: no local model required, or everything is ready. Nothing to show.
  if (status.kind === "not-required" || status.kind === "ready") return null;

  const modelName = status.modelName ?? "Local model";

  if (status.kind === "error" && !retrying) {
    const detail = status.errors.find((message) => message.trim().length > 0);
    return (
      <div className={spanClassName}>
        <HomeWidgetCard
          icon={<TriangleAlert />}
          label="Local model"
          value={`${modelName} download failed`}
          meta={detail ? truncateDetail(detail) : undefined}
          badge="Retry"
          tone="danger"
          testId="chat-widget-model-download"
          ariaLabel={`${modelName} download failed${detail ? `: ${detail}` : ""}. Tap to retry the download.`}
          onActivate={() => void retry()}
        />
      </div>
    );
  }

  if (status.kind === "downloading" || retrying) {
    const percent = roundedPercent(status.percent);
    const eta = formatEta(status.etaMs);
    const value =
      percent != null
        ? `${modelName} — ${percent}%`
        : `Downloading ${modelName}`;
    return (
      <div className={spanClassName}>
        <HomeWidgetCard
          icon={<Download />}
          label="Local model"
          value={value}
          meta={eta ?? undefined}
          testId="chat-widget-model-download"
          ariaLabel={`Downloading ${modelName}${percent != null ? `, ${percent} percent` : ""}${eta ? `, ${eta}` : ""}. Tap to manage local models.`}
          onActivate={openSettings}
        />
      </div>
    );
  }

  if (status.kind === "loading") {
    return (
      <div className={spanClassName}>
        <HomeWidgetCard
          icon={<Loader2 className="animate-spin" />}
          label="Local model"
          value={`Loading ${modelName}…`}
          testId="chat-widget-model-download"
          ariaLabel={`Loading ${modelName} into the local runtime. Tap to manage local models.`}
          onActivate={openSettings}
        />
      </div>
    );
  }

  // `missing` — assigned but not yet downloading (queued / awaiting enqueue).
  return (
    <div className={spanClassName}>
      <HomeWidgetCard
        icon={<Download />}
        label="Local model"
        value={`Queued ${modelName}`}
        testId="chat-widget-model-download"
        ariaLabel={`${modelName} is queued for download. Tap to manage local models.`}
        onActivate={openSettings}
      />
    </div>
  );
}

/** Keep the error detail meta tight so it never wraps the naked tile. */
function truncateDetail(detail: string): string {
  const trimmed = detail.trim();
  return trimmed.length > 40 ? `${trimmed.slice(0, 39)}…` : trimmed;
}

/**
 * Home-widget registration metadata for `local-inference.model-download`
 * (consumed by the widget registry). A naked 2x1 tile surfacing the local model
 * download as the user lands on home.
 */
export const MODEL_DOWNLOAD_HOME_WIDGET = {
  pluginId: "local-inference",
  id: "local-inference.model-download",
  // High order so the tile surfaces near the top of the home grid while a model
  // is downloading (it self-hides once ready, so it never permanently crowds).
  order: 55,
  size: "2x1",
  signalKinds: ["activity", "notification"],
  Component: ModelDownloadWidget,
} as const;
