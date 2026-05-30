import { Mic, Send } from "lucide-react";
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
import {
  getInternalToolApps,
  getInternalToolAppTargetTab,
} from "../apps/internal-tool-apps";
import { formatEta } from "../local-inference/hub-utils";
import { useShellControllerContext } from "../shell/ShellControllerContext";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import type {
  FrequencyAnalyser,
  VoiceWaveformMode,
} from "../voice/VoiceWaveform";

// The voice waveform speaks in three modes; the homescreen scene contract has a
// richer four-phase vocabulary. Map the one onto the other at the boundary so
// scenes can distinguish assistant speech ("speaking") from silence ("idle").
function phaseForMode(mode: VoiceWaveformMode): HomescreenPhase {
  if (mode === "listening") return "listening";
  if (mode === "responding") return "speaking";
  return "idle";
}

// There is no on-screen edit button. Edit mode is entered by typing "/edit" or
// by asking (typed or voiced) to "edit the homescreen". Matches both phrasings.
function editCommandMatches(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (normalized === "/edit") return true;
  return /edit (the )?home\s?screen/.test(normalized);
}

// The home hero background: the editable WebGL homescreen canvas. Memoized on
// its inputs so the renderer never re-renders on the composer's keystroke/focus
// churn — only when the voice phase, audio source, or transcripts change.
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

// The eight default apps surfaced above the avatar. All are internal-tool apps,
// so a tap navigates straight to the owning tab — no catalog fetch required.
const DEFAULT_APP_NAMES: readonly string[] = [
  "@elizaos/plugin-lifeops",
  "@elizaos/plugin-steward-app",
  "@elizaos/plugin-task-coordinator",
  "@elizaos/plugin-training",
  "@elizaos/app-skills-viewer",
  "@elizaos/app-memory-viewer",
  "@elizaos/plugin-elizamaker",
  "@elizaos/app-plugin-viewer",
];

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

  const latestAssistantWords = useMemo(() => {
    const text = latestAssistant?.content.trim() ?? "";
    if (!text) return null;
    const words = text.split(/\s+/).slice(-14);
    return words.join(" ");
  }, [latestAssistant]);

  // Enter edit mode when the latest user message (typically a voice
  // transcription) asks to edit the homescreen. Typed "/edit" is intercepted
  // in the composer before it ever becomes a message.
  const lastEditUserText = useRef("");
  useEffect(() => {
    if (latestUserText && latestUserText !== lastEditUserText.current) {
      lastEditUserText.current = latestUserText;
      if (editCommandMatches(latestUserText)) requestEdit();
    }
  }, [latestUserText, requestEdit]);

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
      <div
        data-testid="home-view"
        className={cn(
          "relative z-10 flex h-full w-full flex-col items-center overflow-hidden px-4 pb-8 text-txt transition-opacity duration-200",
          // In edit mode the foreground collapses to a peekable overlay so the
          // canvas — and its edit toolbar — own the screen while customizing.
          editingHome && "pointer-events-none opacity-0",
        )}
      >
        {/* Apps sit at the top; the greeting/transcript sits just beneath them
            in the upper third, leaving the centre-lower open for the glass orb
            and its water. Notifications and the composer anchor the bottom. */}
        <div className="flex min-h-0 w-full max-w-3xl flex-1 flex-col items-center gap-5 pt-[calc(var(--safe-area-top,0px)+1rem)]">
          <DefaultApps onLaunch={setTab} />

          {showModelStatus && modelStatus ? (
            <ModelStatusPanel
              status={modelStatus}
              onOpenSettings={() => setTab("settings")}
            />
          ) : noLlmConnection ? (
            <NoLlmConnectionPanel onOpenSettings={() => setTab("settings")} />
          ) : (
            <p
              className="min-h-6 max-w-xl text-center text-lg font-medium text-white/95 [text-shadow:0_2px_10px_rgba(0,0,0,0.7),0_1px_4px_rgba(0,0,0,0.6)]"
              aria-live="polite"
              data-testid="home-assistant-transcript"
            >
              {latestAssistantWords ??
                t("homeview.assistant.prompt", {
                  defaultValue: "hey, what's up?",
                })}
            </p>
          )}

          <div className="flex-1" aria-hidden />

          <HomeNotifications />
        </div>

        <HomeComposer onRequestEdit={requestEdit} />
      </div>
    </div>
  );
}

function DefaultApps({
  onLaunch,
}: {
  onLaunch: (tab: Tab) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const apps = useMemo(() => {
    const byName = new Map(getInternalToolApps().map((app) => [app.name, app]));
    return DEFAULT_APP_NAMES.map((name) => byName.get(name)).filter(
      (app): app is NonNullable<typeof app> => Boolean(app),
    );
  }, []);

  if (apps.length === 0) return null;

  return (
    <div
      className="mx-auto grid w-full max-w-xs grid-cols-4 place-items-center gap-3"
      data-testid="home-default-apps"
    >
      {apps.map((app) => {
        const target = getInternalToolAppTargetTab(app.name);
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
            onClick={() => {
              if (target) onLaunch(target);
            }}
            className="rounded-sm transition-transform hover:scale-105 focus-visible:scale-105 focus-visible:outline-none"
          >
            <AppIdentityTile app={app} size="md" imageOnly />
          </button>
        );
      })}
    </div>
  );
}

// Agent-activity feed below the crystal ball. Surfaces notable agent lifecycle
// state (starting / restarting / stopped / error); a healthy running agent
// shows nothing so the home stays clean. No new backend — reads agentStatus.
function HomeNotifications(): React.JSX.Element | null {
  const { agentStatus } = useApp();
  const { t } = useTranslation();
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
        "flex max-w-md items-center gap-2 rounded-md border bg-bg/55 px-3 py-2 text-xs font-medium backdrop-blur",
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
      className="w-full max-w-md rounded-md border border-warn/30 bg-bg/55 p-4 text-center backdrop-blur"
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

// Local text-model readiness shown under the avatar: a live download bar while
// the assigned model installs/loads, or a recovery panel when it is missing or
// failed. Send is gated upstream (controller.canSend) on `status.blocksSend`.
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
        className="w-full max-w-md rounded-md border border-border/40 bg-bg/55 p-4 text-center backdrop-blur"
        data-testid="home-model-status"
        data-kind={status.kind}
        aria-live="polite"
      >
        <p className="mb-2 text-sm font-medium text-txt">{label}</p>
        <div
          className="h-2 w-full overflow-hidden rounded-sm bg-muted/60"
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
      className="w-full max-w-md rounded-md border border-warn/30 bg-bg/55 p-4 text-center backdrop-blur"
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

// Distinguishes a quick tap from a press-and-hold on the mic. A press shorter
// than this is "open voice" (toggle continuous capture); a longer press is
// push-to-talk (capture for the duration of the hold).
const PUSH_TO_TALK_HOLD_MS = 200;

// The home composer's primary control while the draft is empty: a microphone
// that supports two gestures. Quick tap → open voice; press-and-hold → push to
// talk (record while held, submit on release). Keyboard activation maps to a
// tap so the control stays operable without a pointer.
function MicButton({
  recording,
  onTap,
  onHoldStart,
  onHoldEnd,
  startLabel,
  stopLabel,
}: {
  recording: boolean;
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
      if (event.button > 0) return; // ignore non-primary (e.g. right-click)
      holdActive.current = false;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Detached node mid-gesture — capture is best-effort, release still works.
      }
      clearHoldTimer();
      holdTimer.current = setTimeout(() => {
        holdActive.current = true;
        onHoldStart();
      }, PUSH_TO_TALK_HOLD_MS);
    },
    [clearHoldTimer, onHoldStart],
  );

  const endPress = useCallback(() => {
    clearHoldTimer();
    if (holdActive.current) {
      holdActive.current = false;
      onHoldEnd();
    } else {
      onTap();
    }
  }, [clearHoldTimer, onHoldEnd, onTap]);

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
      onPointerDown={beginPress}
      onPointerUp={endPress}
      onPointerCancel={cancelPress}
      onClick={(event) => {
        // Pointer taps are resolved on pointerup (detail >= 1). Only keyboard
        // activation reaches here with detail 0 — route it to a tap.
        if (event.detail === 0) onTap();
      }}
      className={cn(
        "shrink-0 rounded-full text-txt/70 hover:bg-white/20 hover:text-txt",
        recording &&
          "animate-pulse bg-accent/20 text-accent hover:bg-accent/25 hover:text-accent",
      )}
    >
      <Mic className="h-4 w-4" aria-hidden />
    </Button>
  );
}

// Owns the volatile draft/focus state so keystrokes re-render only the composer
// — never HomeView or the memoized background behind it. The trailing control is
// a microphone until the user types, then it morphs into a send button.
function HomeComposer({
  onRequestEdit,
}: {
  onRequestEdit: () => void;
}): React.JSX.Element {
  const controller = useShellControllerContext();
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const trimmed = draft.trim();
  const hasDraft = trimmed.length > 0;
  const isEditCommand = editCommandMatches(trimmed);
  const canSend = Boolean(hasDraft && (isEditCommand || controller?.canSend));
  const recentMessages = useMemo(
    () => controller?.messages.slice(-4) ?? [],
    [controller?.messages],
  );

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

  const showRecent = focused || hasDraft;

  return (
    <div className="w-full max-w-2xl shrink-0 pb-[calc(var(--safe-area-bottom,0px)+0.25rem)]">
      {showRecent && (recentMessages.length > 0 || hasDraft) ? (
        <ol
          className="mb-3 flex max-h-32 flex-col gap-1 overflow-hidden"
          data-testid="home-recent-chats"
          aria-label={t("homeview.composer.recentChat", {
            defaultValue: "Recent chat",
          })}
        >
          {recentMessages.map((message) => (
            <li
              key={message.id}
              className={cn(
                "truncate rounded-sm border border-border/30 bg-bg/45 px-3 py-1.5 text-xs backdrop-blur",
                message.role === "user"
                  ? "ml-auto max-w-[82%]"
                  : "mr-auto max-w-[82%]",
              )}
            >
              {message.content}
            </li>
          ))}
          {hasDraft ? (
            <li className="ml-auto max-w-[82%] truncate rounded-sm border border-accent/25 bg-accent/10 px-3 py-1.5 text-xs text-txt backdrop-blur">
              {trimmed}
            </li>
          ) : null}
        </ol>
      ) : null}

      <div className="flex items-center gap-1.5 rounded-full border border-white/30 bg-white/12 p-2 text-txt shadow-[0_6px_28px_rgba(0,0,0,0.16)] backdrop-blur-xl transition-colors focus-within:border-white/50 focus-within:bg-white/20">
        <Input
          type="text"
          value={draft}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              sendDraft();
            }
          }}
          placeholder={t("homeview.composer.placeholder", {
            defaultValue: "Ask Eliza...",
          })}
          aria-label={t("homeview.composer.messageLabel", {
            defaultValue: "Message Eliza",
          })}
          data-testid="home-chat-input"
          style={{ outline: "none" }}
          className="min-w-0 flex-1 border-0 bg-transparent px-3 text-white placeholder:text-white/60 focus-visible:ring-0 focus-visible:ring-offset-0"
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
            className="shrink-0 rounded-full text-bg disabled:opacity-45"
          >
            <Send className="h-4 w-4" aria-hidden />
          </Button>
        ) : (
          <MicButton
            recording={controller?.recording ?? false}
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
  );
}
