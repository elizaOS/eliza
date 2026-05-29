import {
  Gamepad2,
  MessageSquare,
  Send,
  Settings,
  UserRound,
  Wallet,
} from "lucide-react";
import type * as React from "react";
import { memo, useMemo, useState } from "react";

import { CloudVideoBackground } from "../../backgrounds/CloudVideoBackground";
import { cn } from "../../lib/utils";
import type { Tab } from "../../navigation";
import { useApp } from "../../state";
import { useTranslation } from "../../state/TranslationContext";
import type { HomeModelStatus } from "../../services/local-inference/home-model-status";
import { AppIdentityTile } from "../apps/app-identity";
import {
  getInternalToolApps,
  getInternalToolAppTargetTab,
} from "../apps/internal-tool-apps";
import { formatEta } from "../local-inference/hub-utils";
import { useShellControllerContext } from "../shell/ShellControllerContext";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { VoiceWaveform } from "../voice/VoiceWaveform";

// Mounted once and never re-rendered. The background takes no volatile props
// and no children, so React.memo keeps it stable across every home-view state
// change (typing, focus, new messages). Load-bearing for perf: the cloud video
// must never re-render on state changes.
const HomeBackground = memo(function HomeBackground(): React.JSX.Element {
  return (
    <CloudVideoBackground
      scrim={0.08}
      style={{ position: "absolute", inset: 0, height: "100%", width: "100%" }}
    />
  );
});

const HEADER_NAV: ReadonlyArray<{
  tab: Tab;
  labelKey: string;
  defaultLabel: string;
  icon: typeof MessageSquare;
}> = [
  {
    tab: "chat",
    labelKey: "homeview.nav.chat",
    defaultLabel: "Chat",
    icon: MessageSquare,
  },
  {
    tab: "apps",
    labelKey: "homeview.nav.apps",
    defaultLabel: "Apps",
    icon: Gamepad2,
  },
  {
    tab: "character",
    labelKey: "homeview.nav.character",
    defaultLabel: "Character",
    icon: UserRound,
  },
  {
    tab: "inventory",
    labelKey: "homeview.nav.inventory",
    defaultLabel: "Wallet",
    icon: Wallet,
  },
  {
    tab: "settings",
    labelKey: "homeview.nav.settings",
    defaultLabel: "Settings",
    icon: Settings,
  },
];

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

  const latestAssistant = useMemo(
    () =>
      [...(controller?.messages ?? [])]
        .reverse()
        .find((message) => message.role === "assistant"),
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

  return (
    <div className="relative h-full w-full overflow-hidden">
      <HomeBackground />
      <div
        data-testid="home-view"
        className="relative z-10 flex h-full w-full flex-col items-center overflow-hidden px-4 pb-8 text-txt"
      >
        <HomeHeader onNavigate={setTab} />

        <div className="flex min-h-0 w-full max-w-3xl flex-1 flex-col items-center justify-center gap-5">
          <DefaultApps onLaunch={setTab} />

          <div className="relative grid h-[min(38vh,260px)] min-h-44 w-full place-items-center">
            <VoiceWaveform
              mode={mode}
              analyser={controller?.analyser ?? null}
              size={240}
            />
          </div>

          {showModelStatus && modelStatus ? (
            <ModelStatusPanel
              status={modelStatus}
              onOpenSettings={() => setTab("settings")}
            />
          ) : noLlmConnection ? (
            <NoLlmConnectionPanel onOpenSettings={() => setTab("settings")} />
          ) : (
            <p
              className="min-h-6 max-w-xl text-center text-sm text-muted"
              aria-live="polite"
              data-testid="home-assistant-transcript"
            >
              {latestAssistantWords ??
                t("homeview.assistant.prompt", {
                  defaultValue: "How can I help?",
                })}
            </p>
          )}
        </div>

        <HomeComposer />
      </div>
    </div>
  );
}

function HomeHeader({
  onNavigate,
}: {
  onNavigate: (tab: Tab) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <header
      data-testid="home-header"
      className="flex w-full max-w-3xl shrink-0 items-center justify-center gap-1 pt-[calc(var(--safe-area-top,0px)+0.5rem)] pb-2"
    >
      {HEADER_NAV.map(({ tab, labelKey, defaultLabel, icon: Icon }) => {
        const label = t(labelKey, { defaultValue: defaultLabel });
        return (
          <button
            key={tab}
            type="button"
            aria-label={label}
            title={label}
            onClick={() => onNavigate(tab)}
            className="flex min-h-9 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold text-white/90 transition-colors [text-shadow:0_2px_10px_rgba(0,0,0,0.75),0_1px_4px_rgba(0,0,0,0.65)] hover:bg-white/10 hover:text-white focus-visible:bg-white/10 focus-visible:outline-none"
          >
            <Icon className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">{label}</span>
          </button>
        );
      })}
    </header>
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
      className="flex w-full max-w-md flex-wrap items-center justify-center gap-2.5"
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
            <AppIdentityTile app={app} size="sm" imageOnly />
          </button>
        );
      })}
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

// Owns the volatile draft/focus state so keystrokes re-render only the composer
// — never HomeView or the memoized background behind it.
function HomeComposer(): React.JSX.Element {
  const controller = useShellControllerContext();
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const trimmed = draft.trim();
  const canSend = Boolean(controller?.canSend && trimmed.length > 0);
  const recentMessages = useMemo(
    () => controller?.messages.slice(-4) ?? [],
    [controller?.messages],
  );

  function sendDraft() {
    if (!canSend || !controller) return;
    controller.send(trimmed);
    setDraft("");
  }

  const draftPreview = trimmed;
  const showRecent = focused || draftPreview.length > 0;

  return (
    <div className="w-full max-w-2xl shrink-0 pb-[calc(var(--safe-area-bottom,0px)+0.25rem)]">
      {showRecent && (recentMessages.length > 0 || draftPreview.length > 0) ? (
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
          {draftPreview.length > 0 ? (
            <li className="ml-auto max-w-[82%] truncate rounded-sm border border-accent/25 bg-accent/10 px-3 py-1.5 text-xs text-txt backdrop-blur">
              {draftPreview}
            </li>
          ) : null}
        </ol>
      ) : null}

      <div className="mb-2 flex justify-center">
        <button
          type="button"
          aria-label={
            controller?.recording
              ? t("homeview.composer.stopVoice", {
                  defaultValue: "Stop voice input",
                })
              : t("homeview.composer.startVoice", {
                  defaultValue: "Start voice input",
                })
          }
          aria-pressed={controller?.recording ?? false}
          onClick={() => controller?.toggleRecording()}
          className={cn(
            "min-h-8 bg-transparent px-2 text-xs font-semibold text-white transition-colors [text-shadow:0_2px_10px_rgba(0,0,0,0.75),0_1px_4px_rgba(0,0,0,0.65)] hover:text-white focus-visible:underline focus-visible:outline-none",
            controller?.recording && "animate-pulse",
          )}
        >
          {controller?.recording
            ? t("homeview.composer.listening", { defaultValue: "Listening" })
            : t("homeview.composer.notListening", {
                defaultValue: "Not listening",
              })}
        </button>
      </div>

      <div className="flex items-center gap-2 rounded-full border border-border bg-card/80 p-2 text-txt backdrop-blur-md transition-colors focus-within:border-muted">
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
          className="min-w-0 flex-1 border-0 bg-transparent px-3 text-txt placeholder:text-muted focus-visible:ring-0 focus-visible:ring-offset-0"
        />
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
      </div>
    </div>
  );
}
