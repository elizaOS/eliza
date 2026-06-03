// Static import: CharacterEditor is statically re-exported by app-core's
// browser entry, so the previous lazy() was eagerly merged back into the
// main chunk. Drop the wrapper to silence the dynamic↔static collision
// warning and remove the unnecessary Suspense boundary overhead.

import { useAgentElement } from "@elizaos/ui/agent-surface";
import { CharacterEditor } from "@elizaos/ui/components";
import {
  dispatchAppEmoteEvent,
  dispatchAppEvent,
  STOP_EMOTE_EVENT,
} from "@elizaos/ui/events";
import { useRenderGuard } from "@elizaos/ui/hooks";
import { useApp } from "@elizaos/ui/state";
import {
  type CSSProperties,
  memo,
  type ReactNode,
  Suspense,
  useCallback,
  useMemo,
  useState,
} from "react";
import {
  AGENT_EMOTE_CATALOG,
  EMOTE_CATALOG,
  type EmoteCategory,
  getEmote,
} from "../../emotes/catalog";
import { CompanionHeader, type CompanionShellView } from "./CompanionHeader";
import { CompanionSceneHost } from "./CompanionSceneHost";
import { CompanionSettingsPanel } from "./CompanionSettingsPanel";
import { EmotePicker } from "./EmotePicker";
import { InferenceCloudAlertButton } from "./InferenceCloudAlertButton";
import { resolveCompanionInferenceNotice } from "./resolve-companion-inference-notice";

/**
 * Inner overlay that subscribes to useApp() for frequently-changing data
 * (conversationMessages, chatLastUsage, etc.). Extracted so that
 * CompanionView itself doesn't subscribe — keeping the children prop
 * passed to CompanionSceneHost referentially stable and avoiding
 * cascading re-renders into the 3D scene.
 */
const CompanionViewOverlay = memo(function CompanionViewOverlay() {
  useRenderGuard("CompanionView");
  const {
    uiLanguage,
    setUiLanguage,
    uiTheme,
    setUiTheme,
    chatAgentVoiceMuted,
    chatLastUsage,
    conversationMessages,
    elizaCloudAuthRejected,
    elizaCloudConnected,
    elizaCloudCreditsError,
    elizaCloudEnabled,
    emotePickerOpen,
    openEmotePicker,
    closeEmotePicker,
    handleNewConversation,
    navigation,
    setState,
    setTab,
    t,
  } = useApp();

  const [companionView, setCompanionView] =
    useState<CompanionShellView>("companion");

  const handleExitToDesktop = useCallback(() => {
    setState("activeOverlayApp", null);
    setTab("chat");
  }, [setState, setTab]);

  const handleSwitchToCharacter = useCallback(() => {
    setCompanionView("character");
  }, []);

  const handleOpenSettings = useCallback(() => {
    setCompanionView("settings");
  }, []);

  const handleSwitchToCompanion = useCallback(() => {
    setCompanionView("companion");
  }, []);

  const handleToggleEmotePicker = useCallback(() => {
    if (emotePickerOpen) {
      closeEmotePicker();
      return;
    }
    openEmotePicker();
  }, [closeEmotePicker, emotePickerOpen, openEmotePicker]);

  const hasInterruptedAssistant = useMemo(
    () =>
      conversationMessages.some((m) => m.role === "assistant" && m.interrupted),
    [conversationMessages],
  );

  const inferenceNotice = useMemo(
    () =>
      resolveCompanionInferenceNotice({
        elizaCloudConnected,
        elizaCloudAuthRejected,
        elizaCloudCreditsError,
        elizaCloudEnabled,
        chatLastUsageModel: chatLastUsage?.model,
        hasInterruptedAssistant,
        t,
      }),
    [
      chatLastUsage?.model,
      elizaCloudAuthRejected,
      elizaCloudConnected,
      elizaCloudCreditsError,
      elizaCloudEnabled,
      hasInterruptedAssistant,
      t,
    ],
  );

  const handleInferenceAlertClick = useCallback(() => {
    if (!inferenceNotice) return;
    setState("activeOverlayApp", null);
    navigation.scheduleAfterTabCommit(() => {
      setTab("settings");
      if (inferenceNotice.kind === "cloud") {
        setState("cloudDashboardView", "billing");
      }
    });
  }, [inferenceNotice, navigation, setState, setTab]);

  const companionHeaderRightExtras = (
    <>
      {inferenceNotice ? (
        <InferenceCloudAlertButton
          notice={inferenceNotice}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={handleInferenceAlertClick}
        />
      ) : null}
    </>
  );

  return (
    <div className="absolute inset-0 z-10 flex flex-col pointer-events-none">
      <div>
        <CompanionHeader
          activeView={companionView}
          onExitToDesktop={handleExitToDesktop}
          onExitToCharacter={handleSwitchToCharacter}
          onOpenSettings={handleOpenSettings}
          onSwitchToCompanion={handleSwitchToCompanion}
          uiLanguage={uiLanguage}
          setUiLanguage={setUiLanguage}
          uiTheme={uiTheme}
          setUiTheme={setUiTheme}
          t={t}
          chatAgentVoiceMuted={chatAgentVoiceMuted}
          onToggleVoiceMute={() =>
            setState("chatAgentVoiceMuted", !chatAgentVoiceMuted)
          }
          onNewChat={() => void handleNewConversation()}
          onToggleEmotePicker={handleToggleEmotePicker}
          rightExtras={companionHeaderRightExtras}
        />
      </div>

      {/* In-view chat removed — the global floating pill is the only chat
          surface. The companion view shows the avatar; chat/voice happen in
          the pill that floats on top of every view. */}

      {companionView === "character" && (
        <Suspense fallback={null}>
          <CharacterEditor sceneOverlay />
        </Suspense>
      )}

      {companionView === "settings" && <CompanionSettingsPanel />}

      <EmotePicker />

      {/* Center (empty to show character) */}
      <div className="flex-1 grid grid-cols-[1fr_auto] gap-6 min-h-0 relative">
        <div className="w-full h-full" />
      </div>
    </div>
  );
});

/**
 * CompanionView — thin shell that composes CompanionSceneHost + overlay.
 * Does NOT subscribe to useApp() so CompanionSceneHost receives stable
 * children and avoids re-rendering the 3D scene on unrelated state changes.
 */
export const CompanionView = memo(function CompanionView() {
  return (
    <CompanionSceneHost active>
      <CompanionViewOverlay />
    </CompanionSceneHost>
  );
});

function countByCategory() {
  return EMOTE_CATALOG.reduce<Record<EmoteCategory, number>>(
    (counts, emote) => {
      counts[emote.category] = (counts[emote.category] ?? 0) + 1;
      return counts;
    },
    {
      greeting: 0,
      emotion: 0,
      dance: 0,
      combat: 0,
      idle: 0,
      movement: 0,
      gesture: 0,
      other: 0,
    },
  );
}

function lastMessageSummary(messages: readonly unknown[]) {
  const last = messages[messages.length - 1];
  if (!last || typeof last !== "object") return null;
  const record = last as Record<string, unknown>;
  return {
    role: typeof record.role === "string" ? record.role : "unknown",
    interrupted: record.interrupted === true,
  };
}

function messageRole(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const role = (message as Record<string, unknown>).role;
  return typeof role === "string" ? role : null;
}

function messageInterrupted(message: unknown): boolean {
  return (
    Boolean(message) &&
    typeof message === "object" &&
    (message as Record<string, unknown>).interrupted === true
  );
}

export function CompanionTuiView() {
  const {
    uiLanguage,
    uiTheme,
    chatAgentVoiceMuted,
    chatLastUsage,
    conversationMessages,
    elizaCloudAuthRejected,
    elizaCloudConnected,
    elizaCloudCreditsError,
    elizaCloudEnabled,
    emotePickerOpen,
    openEmotePicker,
    closeEmotePicker,
    handleNewConversation,
    navigation,
    setState,
    setTab,
    t,
  } = useApp();

  const messages = Array.isArray(conversationMessages)
    ? conversationMessages
    : [];
  const assistantCount = messages.filter(
    (message) => messageRole(message) === "assistant",
  ).length;
  const userCount = messages.filter(
    (message) => messageRole(message) === "user",
  ).length;
  const interruptedAssistantCount = messages.filter(
    (message) =>
      messageRole(message) === "assistant" && messageInterrupted(message),
  ).length;

  const inferenceNotice = resolveCompanionInferenceNotice({
    elizaCloudConnected,
    elizaCloudAuthRejected,
    elizaCloudCreditsError,
    elizaCloudEnabled,
    chatLastUsageModel: chatLastUsage?.model,
    hasInterruptedAssistant: interruptedAssistantCount > 0,
    t,
  });

  const viewState = {
    viewType: "tui",
    viewId: "companion",
    uiLanguage,
    uiTheme,
    voiceMuted: Boolean(chatAgentVoiceMuted),
    messageCount: messages.length,
    assistantCount,
    userCount,
    interruptedAssistantCount,
    lastMessage: lastMessageSummary(messages),
    lastUsageModel: chatLastUsage?.model ?? null,
    elizaCloudConnected: Boolean(elizaCloudConnected),
    elizaCloudEnabled: Boolean(elizaCloudEnabled),
    elizaCloudAuthRejected: Boolean(elizaCloudAuthRejected),
    elizaCloudCreditsError: Boolean(elizaCloudCreditsError),
    inferenceNoticeKind: inferenceNotice?.kind ?? null,
    emotePickerOpen: Boolean(emotePickerOpen),
    emoteCount: EMOTE_CATALOG.length,
    agentEmoteCount: AGENT_EMOTE_CATALOG.length,
    emotesByCategory: countByCategory(),
  };

  const toggleVoiceMute = () => {
    setState("chatAgentVoiceMuted", !chatAgentVoiceMuted);
  };

  const toggleEmotePicker = () => {
    if (emotePickerOpen) {
      closeEmotePicker();
      return;
    }
    openEmotePicker();
  };

  const openSettings = () => {
    setState("activeOverlayApp", null);
    navigation.scheduleAfterTabCommit(() => setTab("settings"));
  };

  return (
    <div
      data-view-state={JSON.stringify(viewState)}
      style={{
        minHeight: "100vh",
        background: "#020617",
        color: "#cbd5e1",
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        padding: 20,
      }}
    >
      <div style={{ color: "#7dd3fc", marginBottom: 4 }}>
        elizaos://companion --type=tui
      </div>
      <div style={{ color: "#475569", marginBottom: 16 }}>
        {messages.length} messages | voice{" "}
        {chatAgentVoiceMuted ? "muted" : "live"} | {EMOTE_CATALOG.length} emotes
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(320px, 1fr) minmax(320px, 1fr)",
          gap: 16,
        }}
      >
        <section
          aria-label="Companion state"
          style={{
            border: "1px solid rgba(125,211,252,0.3)",
            borderRadius: 6,
            padding: 16,
            minHeight: 360,
          }}
        >
          <strong style={{ color: "#e2e8f0" }}>state</strong>
          <div style={{ color: "#64748b", margin: "6px 0 14px" }}>
            language {uiLanguage ?? "unknown"} | theme {uiTheme ?? "system"}
          </div>
          <div>user messages {userCount}</div>
          <div>assistant messages {assistantCount}</div>
          <div>interrupted assistant turns {interruptedAssistantCount}</div>
          <div>last model {chatLastUsage?.model ?? "none"}</div>
          <div>cloud connected {elizaCloudConnected ? "yes" : "no"}</div>
          <div>cloud enabled {elizaCloudEnabled ? "yes" : "no"}</div>
          <div>notice {inferenceNotice?.tooltip ?? "none"}</div>
        </section>

        <section
          aria-label="Companion controls"
          style={{
            border: "1px solid rgba(125,211,252,0.3)",
            borderRadius: 6,
            padding: 16,
            minHeight: 360,
          }}
        >
          <strong style={{ color: "#e2e8f0" }}>controls</strong>
          <div style={{ color: "#64748b", margin: "6px 0 14px" }}>
            commands: state | emotes | play-emote | stop-emote | toggle-voice
          </div>
          <CompanionTuiButton
            agentId="tui-toggle-voice"
            label="Toggle voice"
            onActivate={toggleVoiceMute}
          >
            toggle voice
          </CompanionTuiButton>
          <CompanionTuiButton
            agentId="tui-new-chat"
            label="New chat"
            onActivate={() => void handleNewConversation()}
          >
            new chat
          </CompanionTuiButton>
          <CompanionTuiButton
            agentId="tui-toggle-emotes"
            label={emotePickerOpen ? "Close emotes" : "Open emotes"}
            status={emotePickerOpen ? "active" : "inactive"}
            onActivate={toggleEmotePicker}
          >
            {emotePickerOpen ? "close emotes" : "open emotes"}
          </CompanionTuiButton>
          <CompanionTuiButton
            agentId="tui-settings"
            label="Settings"
            onActivate={openSettings}
          >
            settings
          </CompanionTuiButton>
          <div style={{ marginTop: 14 }}>
            {Object.entries(viewState.emotesByCategory).map(
              ([category, count]) => (
                <div key={category}>
                  <span style={{ color: "#64748b" }}>{category}</span> {count}
                </div>
              ),
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

const buttonStyle = {
  display: "block",
  width: "100%",
  margin: "8px 0",
  background: "transparent",
  color: "#a7f3d0",
  border: "1px solid rgba(167,243,208,0.45)",
  borderRadius: 4,
  padding: "6px 8px",
  cursor: "pointer",
  fontFamily: "inherit",
} satisfies CSSProperties;

function CompanionTuiButton({
  agentId,
  label,
  status,
  onActivate,
  children,
}: {
  agentId: string;
  label: string;
  status?: string;
  onActivate: () => void;
  children: ReactNode;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label,
    group: "companion-tui-controls",
    status,
    description: label,
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onActivate}
      style={buttonStyle}
      {...agentProps}
    >
      {children}
    </button>
  );
}

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-companion-state") {
    return {
      viewType: "tui",
      emoteCount: EMOTE_CATALOG.length,
      agentEmoteCount: AGENT_EMOTE_CATALOG.length,
      emotesByCategory: countByCategory(),
      capabilities: [
        "terminal-companion-state",
        "terminal-companion-emotes",
        "terminal-companion-play-emote",
        "terminal-companion-stop-emote",
      ],
    };
  }

  if (capability === "terminal-companion-emotes") {
    const category =
      typeof params?.category === "string"
        ? (params.category.trim() as EmoteCategory)
        : null;
    const source =
      typeof params?.source === "string" ? params.source.trim() : "all";
    const catalog = source === "agent" ? AGENT_EMOTE_CATALOG : EMOTE_CATALOG;
    return {
      viewType: "tui",
      emotes: catalog
        .filter((emote) => !category || emote.category === category)
        .map((emote) => ({
          id: emote.id,
          name: emote.name,
          category: emote.category,
          duration: emote.duration,
          loop: emote.loop,
          path: emote.path,
        })),
    };
  }

  if (capability === "terminal-companion-play-emote") {
    const emoteId =
      typeof params?.emote === "string" ? params.emote.trim() : "";
    if (!emoteId) throw new Error("emote is required");
    const emote = getEmote(emoteId);
    if (!emote) throw new Error(`Unknown emote: ${emoteId}`);
    dispatchAppEmoteEvent({
      emoteId: emote.id,
      path: emote.path,
      duration: emote.duration,
      loop: emote.loop,
      showOverlay: true,
    });
    return { viewType: "tui", played: emote.id };
  }

  if (capability === "terminal-companion-stop-emote") {
    dispatchAppEvent(STOP_EMOTE_EVENT);
    return { viewType: "tui", stopped: true };
  }

  throw new Error(`Unsupported companion TUI capability: ${capability}`);
}
