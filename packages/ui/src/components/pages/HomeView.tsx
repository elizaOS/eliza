import { Mic, MicOff, Send, X } from "lucide-react";
import type * as React from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Homescreen } from "../../homescreen/Homescreen";
import type { HomescreenPhase } from "../../homescreen/scene-types";
import { cn } from "../../lib/utils";
import type { Tab } from "../../navigation";
import type { HomeModelStatus } from "../../services/local-inference/home-model-status";
import { useApp } from "../../state";
import { useTranslation } from "../../state/TranslationContext";
import { AppIdentityTile } from "../apps/app-identity";
import { getHomeGridApps } from "../apps/home-grid-apps";
import { formatEta } from "../local-inference/hub-utils";
import { useShellControllerContext } from "../shell/ShellControllerContext";
import { usePullGesture } from "../shell/use-pull-gesture";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import type {
  FrequencyAnalyser,
  VoiceWaveformMode,
} from "../voice/VoiceWaveform";

function phaseForMode(mode: VoiceWaveformMode): HomescreenPhase {
  if (mode === "listening") return "listening";
  if (mode === "responding") return "speaking";
  return "idle";
}

function editCommandMatches(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (normalized === "/edit") return true;
  return /edit (the )?home\s?screen/.test(normalized);
}

const HomeVoiceBackground = memo(function HomeVoiceBackground({
  mode,
  analyser,
  userText,
  assistantText,
  onEditModeChange,
  editRequestNonce,
}: {
  mode: VoiceWaveformMode;
  analyser: FrequencyAnalyser | null;
  userText: string;
  assistantText: string;
  onEditModeChange: (editing: boolean) => void;
  editRequestNonce: number;
}): React.JSX.Element {
  return (
    <Homescreen
      analyser={analyser}
      phase={phaseForMode(mode)}
      userText={userText}
      assistantText={assistantText}
      onEditModeChange={onEditModeChange}
      editRequestNonce={editRequestNonce}
    />
  );
});

// ─── Expanded orb voice mode overlay ────────────────────────────────────────

/**
 * Animates the orb from its resting position (top ~6%, small) to center-screen
 * (large). Controls appear ABOVE the orb. Apps and chat are faded/pushed out
 * by the caller. Flick/swipe in any direction to dismiss.
 *
 * The orb itself stays as the WebGL canvas element (the caller hides that via
 * the foreground fade). This component renders a matching glass circle that
 * grows from the orb's anchor point to center.
 */
function ExpandedOrbOverlay({
  onClose,
  onMuteToggle,
  muted,
  transcription,
  assistantText,
}: {
  onClose: () => void;
  onMuteToggle: () => void;
  muted: boolean;
  transcription: string;
  assistantText: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  // isOpen drives the CSS transition: starts false, flips to true on first frame.
  const [isOpen, setIsOpen] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setIsOpen(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const greeting =
    assistantText ||
    t("homeview.orb.greeting", { defaultValue: "hey, what's up?" });

  // Flick up or down to dismiss
  const dragStart = useRef<{ y: number } | null>(null);

  function onOverlayPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Don't start drag on buttons
    if ((e.target as Element).closest("button")) return;
    dragStart.current = { y: e.clientY };
  }

  function onOverlayPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragStart.current) return;
    const dy = Math.abs(e.clientY - dragStart.current.y);
    dragStart.current = null;
    if (dy > 60) onClose();
  }

  return (
    <div
      className={cn(
        "absolute inset-0 z-30 transition-[background,backdrop-filter] duration-500",
        isOpen ? "bg-black/35 backdrop-blur-sm" : "bg-transparent",
      )}
      data-testid="home-orb-expanded"
      onPointerDown={onOverlayPointerDown}
      onPointerUp={onOverlayPointerUp}
    >
      {/* Controls — above the orb, fade in after orb starts expanding */}
      <div
        className={cn(
          "absolute left-1/2 -translate-x-1/2 flex items-center gap-5 transition-all duration-300",
          // Sits above the orb center
          isOpen
            ? "top-[calc(50%-min(30vw,200px)-80px)] opacity-100"
            : "top-[15%] opacity-0",
        )}
      >
        <button
          type="button"
          aria-label={muted ? "Unmute" : "Mute"}
          onClick={onMuteToggle}
          className={cn(
            "flex h-12 w-12 items-center justify-center rounded-full border backdrop-blur-md transition-all",
            muted
              ? "border-warn/50 bg-warn/20 text-warn"
              : "border-white/25 bg-white/10 text-white/80 hover:bg-white/20",
          )}
        >
          {muted ? (
            <MicOff className="h-5 w-5" aria-hidden />
          ) : (
            <Mic className="h-5 w-5" aria-hidden />
          )}
        </button>

        <button
          type="button"
          aria-label="Cancel voice mode"
          onClick={onClose}
          className="flex h-12 w-12 items-center justify-center rounded-full border border-white/25 bg-white/10 text-white/80 backdrop-blur-md transition-all hover:bg-white/20"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>

      {/* Orb — transitions from the hit-target anchor (top ~6%, 12vh) to center */}
      <div
        aria-hidden
        className="absolute rounded-full bg-white/10 backdrop-blur-xl border border-white/25 transition-all duration-500 ease-[cubic-bezier(0.34,1.2,0.64,1)]"
        style={
          isOpen
            ? {
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%)",
                width: "min(60vw, 400px)",
                height: "min(60vw, 400px)",
                boxShadow:
                  "0 0 80px rgba(255,255,255,0.18), inset 0 0 60px rgba(255,255,255,0.06)",
              }
            : {
                top: "6%",
                left: "50%",
                transform: "translate(-50%, 0)",
                width: "12vh",
                height: "12vh",
                maxWidth: "128px",
                maxHeight: "128px",
                boxShadow: "0 0 32px rgba(255,255,255,0.1)",
              }
        }
      >
        {/* Inner ring pulses while voice is active */}
        <div className="absolute inset-0 animate-pulse rounded-full border border-white/15" />
        <div
          className="absolute inset-[12%] rounded-full border border-white/10"
          style={{ animation: "pulse 2.4s ease-in-out 0.6s infinite" }}
        />
      </div>

      {/* Greeting + transcription — fade in below orb */}
      <div
        className={cn(
          "absolute left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 px-8 text-center transition-all duration-400",
          isOpen
            ? "top-[calc(50%+min(30vw,200px)+24px)] opacity-100"
            : "top-[55%] opacity-0",
        )}
      >
        <p className="text-lg font-medium text-white/95 [text-shadow:0_2px_10px_rgba(0,0,0,0.6)]">
          {greeting}
        </p>
        {transcription ? (
          <p className="text-sm text-white/60">{transcription}</p>
        ) : null}
      </div>
    </div>
  );
}

// ─── HomeView ────────────────────────────────────────────────────────────────

export function HomeView(): React.JSX.Element {
  const controller = useShellControllerContext();
  const { setTab } = useApp();
  const { t } = useTranslation();
  const mode = controller?.waveformMode ?? "idle";
  const modelStatus = controller?.modelStatus ?? null;
  const showModelStatus =
    modelStatus != null &&
    modelStatus.kind !== "not-required" &&
    modelStatus.kind !== "ready";

  const [editingHome, setEditingHome] = useState(false);
  const [editRequestNonce, setEditRequestNonce] = useState(0);
  const requestEdit = useCallback(() => setEditRequestNonce((n) => n + 1), []);

  const [orbExpanded, setOrbExpanded] = useState(false);
  const [orbMuted, setOrbMuted] = useState(false);

  // Lifted chat expanded state — starts open; controls the apps fly-away animation.
  const [chatOpen, setChatOpen] = useState(true);

  // Transcript fade state
  const [transcriptFaded, setTranscriptFaded] = useState(false);

  const latestAssistant = useMemo(
    () =>
      [...(controller?.messages ?? [])]
        .reverse()
        .find((message) => message.role === "assistant"),
    [controller?.messages],
  );

  const latestUserText = useMemo(
    () =>
      [...(controller?.messages ?? [])]
        .reverse()
        .find((message) => message.role === "user")?.content ?? "",
    [controller?.messages],
  );

  const noLlmConnection = useMemo(() => {
    if (!latestAssistant) return false;
    if (
      latestAssistant.failureKind === "no_provider" ||
      latestAssistant.failureKind === "provider_issue"
    ) {
      return true;
    }
    return /something went wrong on my end/i.test(latestAssistant.content);
  }, [latestAssistant]);

  // Last 8 words of the latest assistant message — shown beneath the orb overlay.
  const latestAssistantWords = useMemo(() => {
    const text = latestAssistant?.content.trim() ?? "";
    if (!text) return null;
    const words = text.split(/\s+/).slice(-8);
    return words.join(" ");
  }, [latestAssistant]);

  // Transcript line: chunk long assistant text into ~14-word groups and cycle
  // through them, so we never render a long paragraph on the homescreen.
  const transcriptChunks = useMemo(() => {
    const words = (latestAssistant?.content.trim() ?? "")
      .split(/\s+/)
      .filter(Boolean);
    if (words.length === 0) return [] as string[];
    const groups: string[] = [];
    for (let i = 0; i < words.length; i += 14) {
      groups.push(words.slice(i, i + 14).join(" "));
    }
    return groups;
  }, [latestAssistant]);
  const [transcriptChunkIndex, setTranscriptChunkIndex] = useState(0);
  const transcriptChunk = transcriptChunks[transcriptChunkIndex] ?? null;
  const latestAssistantId = latestAssistant?.id ?? null;

  // Reset to the first chunk + un-fade on each new assistant message, then fade
  // the line out 15 seconds later.
  useEffect(() => {
    if (!latestAssistantId) return;
    setTranscriptChunkIndex(0);
    setTranscriptFaded(false);
    const id = setTimeout(() => setTranscriptFaded(true), 15000);
    return () => clearTimeout(id);
  }, [latestAssistantId]);

  // Cycle chunks while there is more than one, keeping each shown briefly.
  useEffect(() => {
    if (transcriptChunks.length <= 1) return;
    const id = setInterval(() => {
      setTranscriptChunkIndex(
        (current) => (current + 1) % transcriptChunks.length,
      );
    }, 3200);
    return () => clearInterval(id);
  }, [transcriptChunks.length]);

  const lastEditUserText = useRef("");
  useEffect(() => {
    if (latestUserText && latestUserText !== lastEditUserText.current) {
      lastEditUserText.current = latestUserText;
      if (editCommandMatches(latestUserText)) requestEdit();
    }
  }, [latestUserText, requestEdit]);

  function openOrbVoice() {
    setOrbExpanded(true);
    setOrbMuted(false);
    controller?.startRecording();
  }

  function closeOrbVoice() {
    setOrbExpanded(false);
    controller?.stopRecording();
  }

  function toggleOrbMute() {
    setOrbMuted((m) => !m);
    if (!orbMuted) {
      controller?.stopRecording();
    } else {
      controller?.startRecording();
    }
  }

  // Pull up on the homescreen to open the chat, pull down to close it.
  const pullBindings = usePullGesture({
    onPullUp: () => setChatOpen(true),
    onPullDown: () => setChatOpen(false),
  });

  return (
    <div className="relative h-full w-full overflow-hidden">
      <HomeVoiceBackground
        mode={mode}
        analyser={controller?.analyser ?? null}
        userText={latestUserText}
        assistantText={latestAssistant?.content ?? ""}
        onEditModeChange={setEditingHome}
        editRequestNonce={editRequestNonce}
      />

      {orbExpanded ? (
        <ExpandedOrbOverlay
          onClose={closeOrbVoice}
          onMuteToggle={toggleOrbMute}
          muted={orbMuted}
          transcription={latestUserText}
          assistantText={latestAssistantWords ?? ""}
        />
      ) : null}

      <div
        data-testid="home-view"
        className={cn(
          "relative z-10 flex h-full w-full flex-col items-center overflow-hidden px-4 text-txt",
          "transition-[opacity,transform] duration-400 ease-out",
          editingHome && "pointer-events-none opacity-0",
          orbExpanded && "pointer-events-none translate-y-12 opacity-0",
        )}
      >
        {/* Transparent hit target over the WebGL orb — the canvas renders the
            actual glass orb visual; this sits invisibly on top for click/tap.
            Slightly smaller than the original (12vh vs 16vh). */}
        <button
          type="button"
          aria-label={t("homeview.orb.activate", {
            defaultValue: "Talk to Eliza",
          })}
          data-testid="home-orb-hit"
          onClick={openOrbVoice}
          className="absolute left-1/2 top-[6%] z-20 h-[12vh] w-[12vh] max-h-32 max-w-32 -translate-x-1/2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        />

        {/* Apps + status sit below the orb — top padding clears the orb area.
            Pull up here to open the chat, pull down to close it. */}
        <div
          className="flex min-h-0 w-full max-w-3xl flex-1 flex-col items-center gap-6 pt-[calc(var(--safe-area-top,0px)+22vh)]"
          {...pullBindings}
        >
          {showModelStatus && modelStatus ? (
            <ModelStatusPanel
              status={modelStatus}
              onOpenSettings={() => setTab("settings")}
            />
          ) : noLlmConnection ? (
            <NoLlmConnectionPanel onOpenSettings={() => setTab("settings")} />
          ) : (
            <p
              className={cn(
                "min-h-5 max-w-xl text-center text-sm font-medium text-white/90 [text-shadow:0_2px_10px_rgba(0,0,0,0.7)] transition-opacity duration-1000 mb-2",
                transcriptFaded && "opacity-0",
              )}
              aria-live="polite"
              data-testid="home-assistant-transcript"
            >
              {transcriptChunk ??
                t("homeview.assistant.prompt", {
                  defaultValue: "hey, what's up?",
                })}
            </p>
          )}

          {/* Apps fly away when chat is expanded */}
          <div
            className={cn(
              "w-full transition-all duration-500",
              chatOpen &&
                "pointer-events-none h-0 -translate-y-4 overflow-hidden opacity-0",
            )}
          >
            <HomeAppGrid onLaunch={setTab} />
          </div>

          <div className="flex-1" aria-hidden />

          <HomeNotifications />
        </div>

        <HomeChatPill
          open={chatOpen}
          onOpenChange={setChatOpen}
          onRequestEdit={requestEdit}
        />
      </div>
    </div>
  );
}

// ─── Apps ────────────────────────────────────────────────────────────────────

/**
 * The homescreen launcher grid: the curated 24 apps from {@link getHomeGridApps}
 * laid out 4-up, each tile an image-only {@link AppIdentityTile} with a small
 * label below. Scrolls when it overflows. Tapping navigates to the app's tab.
 */
function HomeAppGrid({
  onLaunch,
}: {
  onLaunch: (tab: Tab) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const apps = useMemo(() => getHomeGridApps(), []);

  if (apps.length === 0) return null;

  return (
    <div
      className="mx-auto grid w-full max-w-sm grid-cols-4 place-items-start gap-x-3 gap-y-4 overflow-y-auto"
      data-testid="home-app-grid"
    >
      {apps.map((app) => {
        const displayName = app.displayName ?? app.name;
        return (
          <button
            key={app.name}
            type="button"
            title={displayName}
            aria-label={t("homeview.apps.openApp", {
              name: displayName,
              defaultValue: "Open {{name}}",
            })}
            onClick={() => onLaunch(app.targetTab)}
            className="flex w-full flex-col items-center gap-1 rounded-xs transition-transform hover:scale-105 focus-visible:scale-105 focus-visible:outline-none"
          >
            <AppIdentityTile app={app} size="md" imageOnly />
            <span className="line-clamp-1 w-full text-center text-[0.62rem] font-medium text-white/90 [text-shadow:0_1px_4px_rgba(0,0,0,0.7)]">
              {displayName}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Notifications ───────────────────────────────────────────────────────────

function HomeNotifications(): React.JSX.Element | null {
  const { agentStatus, firstRunComplete, startupCoordinator } = useApp();
  const { t } = useTranslation();
  const startupPhase = startupCoordinator.phase;
  if (firstRunComplete && startupPhase !== "ready") {
    const label =
      startupPhase === "restoring-session" ||
      startupPhase === "resolving-target" ||
      startupPhase === "polling-backend"
        ? t("homeview.notifications.connectingBackend", {
            defaultValue: "Connecting to Eliza…",
          })
        : startupPhase === "hydrating"
          ? t("homeview.notifications.loadingWorkspace", {
              defaultValue: "Loading workspace…",
            })
          : t("homeview.notifications.starting", {
              defaultValue: "Starting Eliza…",
            });

    return (
      <div
        data-testid="home-notifications"
        data-state={startupPhase}
        role="status"
        aria-live="polite"
        className="flex max-w-md items-center gap-2 rounded border border-accent/40 bg-bg/55 px-3 py-2 text-xs font-medium text-txt backdrop-blur"
      >
        <Spinner size={14} className="shrink-0 opacity-90" aria-hidden />
        <span className="leading-snug">{label}</span>
      </div>
    );
  }

  const state = agentStatus?.state ?? null;

  if (!state || state === "running" || state === "not_started") return null;

  const busy = state === "starting" || state === "restarting";
  const label =
    state === "starting"
      ? t("homeview.notifications.starting", {
          defaultValue: "Starting Eliza…",
        })
      : state === "restarting"
        ? t("homeview.notifications.restarting", {
            defaultValue: "Restarting Eliza…",
          })
        : state === "stopped"
          ? t("homeview.notifications.stopped", {
              defaultValue: "Eliza is stopped",
            })
          : t("homeview.notifications.error", {
              defaultValue: "Eliza hit a problem starting up",
            });

  return (
    <div
      data-testid="home-notifications"
      data-state={state}
      role="status"
      aria-live="polite"
      className={cn(
        "flex max-w-md items-center gap-2 rounded border bg-bg/55 px-3 py-2 text-xs font-medium backdrop-blur",
        state === "error"
          ? "border-danger/40 text-danger"
          : state === "stopped"
            ? "border-warn/40 text-warn"
            : "border-accent/40 text-txt",
      )}
    >
      {busy ? (
        <Spinner size={14} className="shrink-0 opacity-90" aria-hidden />
      ) : (
        <span
          aria-hidden
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            state === "error" ? "bg-danger" : "bg-warn",
          )}
        />
      )}
      <span className="leading-snug">{label}</span>
    </div>
  );
}

// ─── No-LLM / Model-status panels ───────────────────────────────────────────

function NoLlmConnectionPanel({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}): React.JSX.Element {
  const { elizaCloudConnected, elizaCloudLoginBusy, handleCloudLogin } =
    useApp();
  const { t } = useTranslation();

  return (
    <div
      className="w-full max-w-md rounded border border-warn/30 bg-bg/55 p-4 text-center backdrop-blur"
      data-testid="home-no-llm-panel"
    >
      <p className="mb-3 text-sm font-medium text-txt">
        {t("homeview.noLlm.title", { defaultValue: "No LLM connection" })}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
        {!elizaCloudConnected ? (
          <Button
            type="button"
            size="sm"
            disabled={elizaCloudLoginBusy}
            onClick={() => void handleCloudLogin()}
          >
            {t("homeview.noLlm.connect", {
              defaultValue: "Connect to Eliza Cloud",
            })}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onOpenSettings}
        >
          {t("homeview.noLlm.settings", { defaultValue: "Settings" })}
        </Button>
      </div>
    </div>
  );
}

function ModelStatusPanel({
  status,
  onOpenSettings,
}: {
  status: HomeModelStatus;
  onOpenSettings: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const modelName =
    status.modelName ??
    t("homeview.model.fallbackName", { defaultValue: "the local model" });

  if (status.kind === "downloading" || status.kind === "loading") {
    const percent = status.percent ?? 0;
    const eta = formatEta(status.etaMs);
    const label =
      status.kind === "downloading"
        ? t("homeview.model.downloading", {
            name: modelName,
            defaultValue: "Downloading {{name}}…",
          })
        : t("homeview.model.loading", {
            name: modelName,
            defaultValue: "Loading {{name}}…",
          });
    return (
      <div
        className="w-full max-w-md rounded border border-border/40 bg-bg/55 p-4 text-center backdrop-blur"
        data-testid="home-model-status"
        data-kind={status.kind}
        aria-live="polite"
      >
        <p className="mb-2 text-sm font-medium text-txt">{label}</p>
        <div
          className="h-2 w-full overflow-hidden rounded bg-muted/60"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full bg-accent transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="mt-1 text-xs text-muted">
          {percent}%{eta ? ` · ${eta} left` : ""}
        </p>
      </div>
    );
  }

  return <ModelRecoveryPanel status={status} onOpenSettings={onOpenSettings} />;
}

function ModelRecoveryPanel({
  status,
  onOpenSettings,
}: {
  status: HomeModelStatus;
  onOpenSettings: () => void;
}): React.JSX.Element {
  const { elizaCloudConnected, elizaCloudLoginBusy, handleCloudLogin } =
    useApp();
  const { t } = useTranslation();
  const modelName =
    status.modelName ??
    t("homeview.model.fallbackName", { defaultValue: "the local model" });

  const title =
    status.kind === "error"
      ? t("homeview.model.errorTitle", {
          name: modelName,
          defaultValue: "Couldn't load {{name}}",
        })
      : t("homeview.model.missingTitle", {
          name: modelName,
          defaultValue: "{{name}} isn't downloaded yet",
        });

  return (
    <div
      className="w-full max-w-md rounded border border-warn/30 bg-bg/55 p-4 text-center backdrop-blur"
      data-testid="home-model-status"
      data-kind={status.kind}
    >
      <p className="mb-1 text-sm font-medium text-txt">{title}</p>
      {status.errors.length > 0 ? (
        <p className="mb-3 text-xs text-muted">{status.errors[0]}</p>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
        <Button type="button" size="sm" onClick={onOpenSettings}>
          {t("homeview.model.manage", { defaultValue: "Manage models" })}
        </Button>
        {!elizaCloudConnected ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={elizaCloudLoginBusy}
            onClick={() => void handleCloudLogin()}
          >
            {t("homeview.model.useCloud", {
              defaultValue: "Use Eliza Cloud",
            })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ─── Bottom chat pill ────────────────────────────────────────────────────────

const PUSH_TO_TALK_HOLD_MS = 200;

function MicButton({
  recording,
  disabled,
  onTap,
  onHoldStart,
  onHoldEnd,
  startLabel,
  stopLabel,
}: {
  recording: boolean;
  disabled?: boolean;
  onTap: () => void;
  onHoldStart: () => void;
  onHoldEnd: () => void;
  startLabel: string;
  stopLabel: string;
}): React.JSX.Element {
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdActive = useRef(false);

  const clearHoldTimer = useCallback(() => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }, []);

  const beginPress = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (disabled) return;
      if (event.button > 0) return;
      holdActive.current = false;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Detached node mid-gesture — best-effort.
      }
      clearHoldTimer();
      holdTimer.current = setTimeout(() => {
        holdActive.current = true;
        onHoldStart();
      }, PUSH_TO_TALK_HOLD_MS);
    },
    [clearHoldTimer, disabled, onHoldStart],
  );

  const endPress = useCallback(() => {
    if (disabled) return;
    clearHoldTimer();
    if (holdActive.current) {
      holdActive.current = false;
      onHoldEnd();
    } else {
      onTap();
    }
  }, [clearHoldTimer, disabled, onHoldEnd, onTap]);

  const cancelPress = useCallback(() => {
    clearHoldTimer();
    if (holdActive.current) {
      holdActive.current = false;
      onHoldEnd();
    }
  }, [clearHoldTimer, onHoldEnd]);

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      data-testid="home-mic"
      aria-label={recording ? stopLabel : startLabel}
      aria-pressed={recording}
      disabled={disabled}
      onPointerDown={beginPress}
      onPointerUp={endPress}
      onPointerCancel={cancelPress}
      onClick={(event) => {
        if (disabled) return;
        if (event.detail === 0) onTap();
      }}
      className={cn(
        "shrink-0 rounded-full text-txt/70 hover:bg-white/20 hover:text-txt disabled:opacity-45",
        recording &&
          "animate-pulse bg-accent/20 text-accent hover:bg-accent/25 hover:text-accent",
      )}
    >
      <Mic className="h-4 w-4" aria-hidden />
    </Button>
  );
}

/**
 * The chat composer at the bottom of the home screen, controlled by the parent.
 *
 * Open (default on home): recent messages push up, chat input appears with
 * drag-down to close. Chat icon navigates to the full /chat view. X closes it.
 * Collapsed: a thin, theme-adaptive bar (no icons) — swipe up or tap to open.
 */
function HomeChatPill({
  open,
  onOpenChange,
  onRequestEdit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestEdit: () => void;
}): React.JSX.Element {
  const controller = useShellControllerContext();
  const { t } = useTranslation();
  const expanded = open;
  const setExpanded = onOpenChange;
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Collapse on outside click when expanded.
  useEffect(() => {
    if (!expanded) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [expanded, setExpanded]);

  const trimmed = draft.trim();
  const hasDraft = trimmed.length > 0;
  const isEditCommand = editCommandMatches(trimmed);
  const canSend = Boolean(hasDraft && (isEditCommand || controller?.canSend));
  const agentBooting = controller?.phase === "booting";
  const canUseComposer = Boolean(controller?.canSend);

  const recentMessages = useMemo(
    () => controller?.messages.slice(-6) ?? [],
    [controller?.messages],
  );

  useEffect(() => {
    if (expanded) {
      const id = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
  }, [expanded]);

  function sendDraft() {
    if (isEditCommand) {
      onRequestEdit();
      setDraft("");
      return;
    }
    if (!canSend || !controller) return;
    controller.send(trimmed);
    setDraft("");
  }

  // Swipe-down on the messages list to collapse
  const swipeDrag = useRef<{ y: number; time: number } | null>(null);

  function onMessagesPointerDown(e: React.PointerEvent<HTMLOListElement>) {
    swipeDrag.current = { y: e.clientY, time: Date.now() };
  }

  function onMessagesPointerUp(e: React.PointerEvent<HTMLOListElement>) {
    if (!swipeDrag.current) return;
    const dy = e.clientY - swipeDrag.current.y;
    const dt = Date.now() - swipeDrag.current.time;
    swipeDrag.current = null;
    if (dy > 40 || (dy > 20 && dt < 250)) {
      setExpanded(false);
    }
  }

  // Swipe-up on the collapsed pill
  const pillDrag = useRef<{ y: number } | null>(null);

  function onPillPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    pillDrag.current = { y: e.clientY };
  }

  function onPillPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    if (!pillDrag.current) return;
    const dy = pillDrag.current.y - e.clientY; // positive = swipe up
    pillDrag.current = null;
    if (dy > 20 || Math.abs(dy) < 10) {
      // swipe up OR tap
      setExpanded(true);
    }
  }

  return (
    <div
      ref={containerRef}
      className="w-full shrink-0 pb-[calc(var(--safe-area-bottom,0px)+0.5rem)]"
      data-testid="home-chat-pill-container"
    >
      {expanded ? (
        <div
          className="mb-2 flex flex-col overflow-hidden"
          data-testid="home-chat-panel"
        >
          {/* Recent messages */}
          {recentMessages.length > 0 ? (
            <ol
              className="flex flex-col gap-1 px-3 pb-2"
              data-testid="home-recent-chats"
              aria-label={t("homeview.composer.recentChat", {
                defaultValue: "Recent chat",
              })}
              onPointerDown={onMessagesPointerDown}
              onPointerUp={onMessagesPointerUp}
            >
              {recentMessages.map((message) => (
                <li
                  key={message.id}
                  className={cn(
                    "max-w-[84%] rounded px-3 py-1.5 text-xs leading-relaxed",
                    message.role === "user"
                      ? "ml-auto bg-white/20 text-white/95"
                      : "mr-auto bg-white/10 text-white/75",
                  )}
                >
                  {message.content}
                </li>
              ))}
            </ol>
          ) : null}

          {/* Composer — draft text stays in input until sent, no bubble preview */}
          <div className="flex items-center gap-1.5 border-t border-white/10 px-2 py-2">
            <Input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  sendDraft();
                }
              }}
              placeholder={
                agentBooting
                  ? t("chat.agentStarting", {
                      defaultValue: "Starting Eliza...",
                    })
                  : t("homeview.composer.placeholder", {
                      defaultValue: "Ask Eliza...",
                    })
              }
              aria-label={t("homeview.composer.messageLabel", {
                defaultValue: "Message Eliza",
              })}
              data-testid="home-chat-input"
              style={{ outline: "none" }}
              className="min-w-0 flex-1 border-0 bg-transparent px-2 text-sm text-white placeholder:text-white/45 focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            {hasDraft ? (
              <Button
                type="button"
                size="icon"
                aria-label={t("homeview.composer.send", {
                  defaultValue: "Send message",
                })}
                disabled={!canSend}
                onClick={sendDraft}
                className="shrink-0 rounded text-bg disabled:opacity-45"
              >
                <Send className="h-4 w-4" aria-hidden />
              </Button>
            ) : (
              <MicButton
                recording={controller?.recording ?? false}
                disabled={!canUseComposer}
                onTap={() => controller?.toggleRecording()}
                onHoldStart={() => controller?.startRecording()}
                onHoldEnd={() => controller?.stopRecording()}
                startLabel={t("homeview.composer.startVoice", {
                  defaultValue: "Start voice input",
                })}
                stopLabel={t("homeview.composer.stopVoice", {
                  defaultValue: "Stop voice input",
                })}
              />
            )}
          </div>
        </div>
      ) : null}

      {/* Collapsed pill — thin bar, no icons, theme-adaptive */}
      {!expanded ? (
        <button
          type="button"
          aria-label={t("homeview.pill.open", {
            defaultValue: "Open chat",
          })}
          aria-expanded={false}
          data-testid="home-chat-pill"
          className="mx-auto flex cursor-pointer items-center justify-center py-3"
          onPointerDown={onPillPointerDown}
          onPointerUp={onPillPointerUp}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setExpanded(true);
            }
          }}
        >
          {/* Theme-adaptive thin bar: white/30 on dark backgrounds, fg/25 on light */}
          <div className="h-1.5 w-24 rounded-full bg-foreground/25 transition-all duration-200 hover:w-28 hover:bg-foreground/35" />
        </button>
      ) : null}
    </div>
  );
}
