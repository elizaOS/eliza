/**
 * Home widget with a real progress track for the recommended local model's
 * download (see the `ModelDownloadWidget` JSDoc below). `useLocalModelDownloads`
 * subscribes to the local-inference download stream and derives the home model
 * status; the widget is the ONLY model-loading status surface (the chat overlay
 * shows no floating pill) and self-hides when no local slot needs a download.
 */
import { Download, Loader2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../../api";
import { useIsAuthenticated } from "../../../hooks/useAuthStatus";
import { cn } from "../../../lib/utils";
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
import { Button } from "../../ui/button";
import { useWidgetNavigation } from "./home-widget-card";

const DEFAULT_SPAN = "col-span-4 row-span-2";
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
  // Auth gate (#11084): the home surface mounts this widget before the auth
  // probe resolves, so the hub fetch + download SSE stream must stay dormant
  // until the session is authenticated (mirrors useHomeModelStatus).
  const authenticated = useIsAuthenticated();

  useEffect(() => {
    if (!authenticated) {
      setState(INITIAL);
      return;
    }

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
  }, [authenticated]);

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
 * MODEL DOWNLOAD home widget (id `local-inference.model-download`). A
 * full-width, double-height row with a real progress track that surfaces the
 * recommended local text model's download as the user lands on home — queued /
 * downloading-% / loading / failed-with-retry — so a fresh on-device agent
 * shows progress instead of a dead chat. This is the ONLY model-loading status
 * surface; the chat overlay renders no floating pill.
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
        <ModelProgressCard
          icon={<TriangleAlert />}
          value={`${modelName} download failed`}
          meta={detail ? truncateDetail(detail) : undefined}
          badge="Retry"
          tone="danger"
          percent={null}
          ariaLabel={`${modelName} download failed${detail ? `: ${detail}` : ""}. Tap to retry the download.`}
          onActivate={() => void retry()}
        />
      </div>
    );
  }

  if (status.kind === "downloading" || retrying) {
    const percent = roundedPercent(status.percent);
    const eta = formatEta(status.etaMs);
    return (
      <div className={spanClassName}>
        <ModelProgressCard
          icon={<Download />}
          value={`Downloading ${modelName}`}
          meta={
            percent != null ? `${percent}%${eta ? ` · ${eta}` : ""}` : undefined
          }
          percent={status.percent}
          ariaLabel={`Downloading ${modelName}${percent != null ? `, ${percent} percent` : ""}${eta ? `, ${eta}` : ""}. Tap to manage local models.`}
          onActivate={openSettings}
        />
      </div>
    );
  }

  if (status.kind === "loading") {
    return (
      <div className={spanClassName}>
        <ModelProgressCard
          icon={<Loader2 className="animate-spin" />}
          value={`Loading ${modelName}…`}
          percent={null}
          indeterminate
          ariaLabel={`Loading ${modelName} into the local runtime. Tap to manage local models.`}
          onActivate={openSettings}
        />
      </div>
    );
  }

  // `missing` — assigned but not yet downloading (queued / awaiting enqueue).
  return (
    <div className={spanClassName}>
      <ModelProgressCard
        icon={<Download />}
        value={`Queued ${modelName}`}
        percent={0}
        ariaLabel={`${modelName} is queued for download. Tap to manage local models.`}
        onActivate={openSettings}
      />
    </div>
  );
}

/**
 * Full-row model-status card: icon + one-line status + a real progress track.
 * Mirrors HomeWidgetCard's chromeless whole-card-button idiom, with the track
 * as the second row of the widget's double-height cell. `indeterminate`
 * (runtime activation has no sub-progress) renders a full pulsing bar instead
 * of a percent fill.
 */
function ModelProgressCard({
  icon,
  value,
  meta,
  badge,
  tone = "default",
  percent,
  indeterminate = false,
  ariaLabel,
  onActivate,
}: {
  icon: React.ReactNode;
  value: string;
  meta?: string;
  badge?: string;
  tone?: "default" | "danger";
  /** 0–100 fill, or null for no fill (error) / indeterminate. */
  percent: number | null;
  indeterminate?: boolean;
  ariaLabel: string;
  onActivate: () => void;
}): React.JSX.Element {
  const fill =
    percent == null ? null : Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <Button
      data-testid="chat-widget-model-download"
      aria-label={ariaLabel}
      onClick={onActivate}
      variant="ghost"
      className="group flex h-full w-full flex-col items-stretch justify-center gap-2.5 whitespace-normal px-3 py-2.5 text-left font-normal transition-opacity hover:opacity-80"
    >
      <span className="flex w-full items-center gap-3">
        <span
          className={cn(
            "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white/85 [&>svg]:h-4 [&>svg]:w-4",
            tone === "danger" && "text-danger",
          )}
        >
          {icon}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm font-semibold leading-tight",
            tone === "danger" ? "text-danger" : "text-white",
          )}
        >
          {value}
        </span>
        {meta != null ? (
          <span className="shrink-0 text-2xs tabular-nums text-white/60">
            {meta}
          </span>
        ) : null}
        {badge != null ? (
          <span
            className={cn(
              "shrink-0 rounded-full px-1.5 py-0.5 text-2xs font-semibold",
              tone === "danger"
                ? "bg-danger/15 text-danger"
                : "bg-accent-subtle text-accent",
            )}
          >
            {badge}
          </span>
        ) : null}
      </span>
      <span
        aria-hidden="true"
        data-testid="chat-widget-model-download-track"
        className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
      >
        {indeterminate ? (
          <span className="block h-full w-full animate-pulse rounded-full bg-accent/70 motion-reduce:animate-none" />
        ) : fill != null ? (
          <span
            className={cn(
              "block h-full rounded-full transition-[width] duration-500",
              tone === "danger" ? "bg-danger/70" : "bg-accent",
            )}
            style={{ width: `${fill}%` }}
          />
        ) : null}
      </span>
    </Button>
  );
}

/** Keep the error detail meta tight so it never wraps the naked tile. */
function truncateDetail(detail: string): string {
  const trimmed = detail.trim();
  return trimmed.length > 40 ? `${trimmed.slice(0, 39)}…` : trimmed;
}

/**
 * Home-widget registration metadata for `local-inference.model-download`
 * (consumed by the widget registry). A full-width double-height row surfacing
 * the local model download progress as the user lands on home.
 */
export const MODEL_DOWNLOAD_HOME_WIDGET = {
  pluginId: "local-inference",
  id: "local-inference.model-download",
  // High order so the tile surfaces near the top of the home grid while a model
  // is downloading (it self-hides once ready, so it never permanently crowds).
  order: 55,
  size: "4x2",
  signalKinds: ["activity", "notification"],
  Component: ModelDownloadWidget,
} as const;
