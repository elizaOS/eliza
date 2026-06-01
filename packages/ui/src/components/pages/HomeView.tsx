import { X } from "lucide-react";
import type * as React from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Homescreen } from "../../homescreen/Homescreen";
import type { OrbAnchor } from "../../homescreen/HomescreenCanvas";
import type { HomescreenPhase } from "../../homescreen/scene-types";
import { cn } from "../../lib/utils";
import type { Tab } from "../../navigation";
import type { HomeModelStatus } from "../../services/local-inference/home-model-status";
import { useApp } from "../../state";
import { useTranslation } from "../../state/TranslationContext";
import { AppIdentityTile } from "../apps/app-identity";
import { getHomeGridApps } from "../apps/home-grid-apps";
import { formatEta } from "../local-inference/hub-utils";
import { GlassPill } from "../shell/GlassPill";
import { GLASS_COMPOSER_CLASS, GlassIconButton } from "../shell/glass-composer";
import { useShellControllerContext } from "../shell/ShellControllerContext";
import { usePullGesture } from "../shell/use-pull-gesture";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
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
  onOrbAnchor,
  onEditModeChange,
  editRequestNonce,
}: {
  mode: VoiceWaveformMode;
  analyser: FrequencyAnalyser | null;
  userText: string;
  assistantText: string;
  onOrbAnchor: (anchor: OrbAnchor | null) => void;
  onEditModeChange: (editing: boolean) => void;
  editRequestNonce: number;
}): React.JSX.Element {
  return (
    <ShellViewAgentSurface viewId="home">
      <Homescreen
        analyser={analyser}
        phase={phaseForMode(mode)}
        userText={userText}
        assistantText={assistantText}
        onOrbAnchor={onOrbAnchor}
        onEditModeChange={onEditModeChange}
        editRequestNonce={editRequestNonce}
      />
    </ShellViewAgentSurface>
  );
});

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

  // Continuous voice mode: the WebGL orb is revealed at the top, the chat is
  // pushed down beneath it, and the mic records continuously until stopped.
  const [voiceMode, setVoiceMode] = useState(false);

  // The orb's projected screen position, reported by the WebGL scene, plus the
  // measured size of this view — together they reserve the orb's band at the top
  // of the chat so messages start beneath the *actual* rendered orb.
  const [orbAnchor, setOrbAnchor] = useState<OrbAnchor | null>(null);
  const handleOrbAnchor = useCallback(
    (anchor: OrbAnchor | null) => setOrbAnchor(anchor),
    [],
  );
  const viewRef = useRef<HTMLDivElement>(null);
  const [viewSize, setViewSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const measure = () =>
      setViewSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Pixel rect of the orb (anchor x/r are width/height fractions). A comfortable
  // size floor keeps it readable on tiny viewports.
  const orbRect = useMemo(() => {
    if (!orbAnchor || viewSize.h === 0) return null;
    const size = Math.max(72, orbAnchor.r * 2 * viewSize.h);
    return {
      left: orbAnchor.x * viewSize.w,
      top: orbAnchor.y * viewSize.h,
      size,
    };
  }, [orbAnchor, viewSize.w, viewSize.h]);

  // Height to reserve at the top of the chat in voice mode so messages clear the
  // orb (its center + radius + a gap). Falls back before the first anchor frame.
  const orbBandPx = useMemo(() => {
    if (!voiceMode) return 0;
    if (orbRect) return orbRect.top + orbRect.size / 2 + 16;
    return viewSize.h > 0 ? viewSize.h * 0.28 : 180;
  }, [voiceMode, orbRect, viewSize.h]);

  // The single global chat: open-state lives in the shell controller, shared by
  // every view. The apps fly-away, the curtain, and the chat pill all read this
  // ONE flag so the homescreen and the global chat never drift out of sync.
  const chatOpen = controller?.isOpen ?? false;
  const openChat = useCallback(() => controller?.open(), [controller]);
  const closeChat = useCallback(() => controller?.close(), [controller]);
  const setChatOpen = useCallback(
    (next: boolean) => {
      if (next) controller?.open();
      else controller?.close();
    },
    [controller],
  );

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

  const enterVoice = useCallback(() => {
    setVoiceMode(true);
    controller?.open();
    controller?.startRecording();
  }, [controller]);

  const exitVoice = useCallback(() => {
    setVoiceMode(false);
    controller?.stopRecording();
  }, [controller]);

  const toggleVoice = useCallback(() => {
    if (voiceMode) exitVoice();
    else enterVoice();
  }, [voiceMode, enterVoice, exitVoice]);

  // Pull up on the homescreen to open the chat, pull down to close it.
  const pullBindings = usePullGesture({
    onPullUp: openChat,
    onPullDown: closeChat,
  });

  return (
    <div className="relative h-full w-full overflow-hidden">
      <HomeVoiceBackground
        mode={mode}
        analyser={controller?.analyser ?? null}
        userText={latestUserText}
        assistantText={latestAssistant?.content ?? ""}
        onOrbAnchor={handleOrbAnchor}
        onEditModeChange={setEditingHome}
        editRequestNonce={editRequestNonce}
      />

      {/* System-color base. Opaque at rest — the home is chat-first on a plain
          surface and the WebGL orb stays hidden; fades out in voice mode to
          reveal the live orb behind. */}
      <div
        aria-hidden
        className={cn(
          "absolute inset-0 z-[5] bg-bg transition-opacity duration-500",
          voiceMode ? "pointer-events-none opacity-0" : "opacity-100",
        )}
      />

      <div
        ref={viewRef}
        data-testid="home-view"
        className={cn(
          "relative z-10 flex h-full w-full flex-col items-center overflow-hidden px-4 text-txt",
          "transition-[opacity,transform] duration-500 ease-out",
          editingHome && "pointer-events-none opacity-0",
        )}
        {...pullBindings}
      >
        {/* Voice mode: reserve the orb's band at the top so the chat sits below
            the live orb, plus a stop control to leave continuous voice. */}
        {voiceMode ? (
          <>
            <div
              aria-hidden
              className="w-full shrink-0 transition-[height] duration-500"
              style={{ height: orbBandPx }}
            />
            {transcriptChunk ? (
              <p
                className={cn(
                  "mb-3 max-w-xl shrink-0 text-center text-sm font-medium text-txt/85 transition-opacity duration-1000",
                  transcriptFaded && "opacity-0",
                )}
                aria-live="polite"
                data-testid="home-assistant-transcript"
              >
                {transcriptChunk}
              </p>
            ) : null}
            <button
              type="button"
              aria-label={t("homeview.orb.stop", {
                defaultValue: "Stop voice input",
              })}
              data-testid="home-voice-stop"
              onClick={exitVoice}
              className="absolute right-3 top-[calc(var(--safe-area-top,0px)+0.75rem)] z-30 flex h-10 w-10 items-center justify-center rounded-full border border-txt/15 bg-txt/5 text-txt/80 backdrop-blur-md transition-colors hover:bg-txt/10"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </>
        ) : null}

        {/* Rest home: apps + status. Hidden while the chat is open so the chat
            takes the full height. */}
        {!chatOpen ? (
          <div className="flex min-h-0 w-full max-w-3xl flex-1 flex-col items-center gap-6 pt-[calc(var(--safe-area-top,0px)+15vh)]">
            {showModelStatus && modelStatus ? (
              <ModelStatusPanel
                status={modelStatus}
                onOpenSettings={() => setTab("settings")}
              />
            ) : noLlmConnection ? (
              <NoLlmConnectionPanel onOpenSettings={() => setTab("settings")} />
            ) : null}

            <HomeAppGrid onLaunch={setTab} />

            <div className="flex-1" aria-hidden />

            <HomeNotifications />
          </div>
        ) : null}

        <HomeChatPill
          open={chatOpen}
          onOpenChange={setChatOpen}
          onRequestEdit={requestEdit}
          voiceMode={voiceMode}
          onToggleVoice={toggleVoice}
        />
      </div>
    </div>
  );
}

// ─── Apps ────────────────────────────────────────────────────────────────────

/**
 * The homescreen launcher grid: the default-pinned tiles from {@link getHomeGridApps}
 * laid out 4-up, each tile an image-only {@link AppIdentityTile} with a small
 * label below. Tapping navigates to the app's tab.
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
      className="mx-auto grid w-full max-w-sm grid-cols-4 place-items-start gap-x-3 gap-y-4 overflow-visible"
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
            className="group flex w-full flex-col items-center gap-1 rounded-xs p-1 focus-visible:outline-none"
          >
            <AppIdentityTile
              app={app}
              size="md"
              imageOnly
              className="transition-transform duration-200 group-hover:scale-105 group-focus-visible:scale-105"
            />
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

/**
 * The chat composer + message list, controlled by the parent.
 *
 * Open: full-height chat — messages fill from the top, the refractive-glass
 * composer pins to the bottom. The composer's right control is the voice button
 * (taps into continuous voice mode) until text is typed, then a send arrow.
 * Collapsed: a compact glass opener pill — tap or swipe up to open.
 */
function HomeChatPill({
  open,
  onOpenChange,
  onRequestEdit,
  voiceMode,
  onToggleVoice,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestEdit: () => void;
  voiceMode: boolean;
  onToggleVoice: () => void;
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
    const handler = (e: PointerEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setExpanded(false);
      }
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [expanded, setExpanded]);

  const trimmed = draft.trim();
  const hasDraft = trimmed.length > 0;
  const isEditCommand = editCommandMatches(trimmed);
  const canSend = Boolean(hasDraft && (isEditCommand || controller?.canSend));
  const agentBooting = controller?.phase === "booting";
  const canUseComposer = Boolean(controller?.canSend);

  const recentMessages = useMemo(
    () => controller?.messages.slice(-50) ?? [],
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
  const suppressPillClick = useRef(false);

  function onPillPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    pillDrag.current = { y: e.clientY };
  }

  function onPillPointerUp() {
    if (!pillDrag.current) return;
    pillDrag.current = null;
    suppressPillClick.current = true;
    setExpanded(true);
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "w-full px-3 pb-[calc(var(--safe-area-bottom,0px)+0.5rem)]",
        // Full-height chat surface when open; compact opener when collapsed.
        expanded ? "flex min-h-0 flex-1 flex-col" : "shrink-0",
      )}
      data-testid="home-chat-pill-container"
    >
      {expanded ? (
        <div
          className="flex min-h-0 flex-1 origin-bottom flex-col overflow-hidden animate-[slide-up_180ms_ease-out] motion-reduce:animate-none"
          data-testid="home-chat-panel"
        >
          {/* Messages fill from the top; the composer pins to the bottom. */}
          {recentMessages.length > 0 ? (
            <ol
              className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-2"
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
                      ? "ml-auto bg-txt/15 text-txt/90"
                      : "mr-auto bg-txt/8 text-txt/65",
                  )}
                >
                  {message.content}
                </li>
              ))}
            </ol>
          ) : (
            <div className="flex-1" aria-hidden />
          )}

          {/* Composer — refractive glass bar; draft text stays in input until sent, no bubble preview */}
          <div className="mx-2 mt-2">
            <div className={cn("px-2 py-0.5", GLASS_COMPOSER_CLASS)}>
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
                className="min-w-0 flex-1 border-0 bg-transparent px-2 text-sm text-txt placeholder:text-txt/50 focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              {hasDraft ? (
                <GlassIconButton
                  icon="send"
                  label={t("homeview.composer.send", {
                    defaultValue: "Send message",
                  })}
                  disabled={!canSend}
                  onClick={sendDraft}
                />
              ) : (
                <GlassIconButton
                  icon="mic"
                  active={voiceMode}
                  disabled={!canUseComposer}
                  label={
                    voiceMode
                      ? t("homeview.composer.stopVoice", {
                          defaultValue: "Stop voice mode",
                        })
                      : t("homeview.composer.startVoice", {
                          defaultValue: "Start voice mode",
                        })
                  }
                  onClick={onToggleVoice}
                />
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* Collapsed pill — compact centered opener, not a fake composer. */}
      {!expanded ? (
        <button
          type="button"
          aria-label={t("homeview.pill.open", {
            defaultValue: "Open chat",
          })}
          aria-expanded={false}
          data-testid="home-chat-pill"
          className={cn(
            "group mx-auto flex min-h-12 w-40 cursor-pointer items-center justify-center rounded-[6px] border-0 bg-transparent px-4 py-3 shadow-none",
            "transition-transform duration-200 ease-out hover:scale-[1.04] active:scale-[1.04]",
            "focus:outline-none focus-visible:outline-none",
          )}
          onPointerDown={onPillPointerDown}
          onPointerUp={onPillPointerUp}
          onClick={() => {
            if (suppressPillClick.current) {
              suppressPillClick.current = false;
              return;
            }
            setExpanded(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setExpanded(true);
            }
          }}
        >
          <GlassPill
            testId="home-chat-pill-glass"
            className="h-7 w-28 transition-[width] duration-200 ease-out group-hover:w-32"
          />
        </button>
      ) : null}
    </div>
  );
}
