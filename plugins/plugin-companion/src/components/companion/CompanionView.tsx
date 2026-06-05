import { useAgentElement } from "@elizaos/ui/agent-surface";
import { useRenderGuard } from "@elizaos/ui/hooks";
import { useApp } from "@elizaos/ui/state";
import { type CSSProperties, memo, type ReactNode } from "react";
import { AGENT_EMOTE_CATALOG, EMOTE_CATALOG } from "../../emotes/catalog";
import { CompanionSceneHost } from "./CompanionSceneHost";
import { countByCategory } from "./CompanionView.helpers";
import { EmotePicker } from "./EmotePicker";
import { resolveCompanionInferenceNotice } from "./resolve-companion-inference-notice";

/**
 * Inner overlay rendered on top of the avatar scene. The companion now shows
 * just the avatar — no header / nav bar — so this only hosts the emote picker
 * overlay. Chat/voice happen in the global floating pill that floats over every
 * view; character + settings live in the main app's own tabs.
 */
const CompanionViewOverlay = memo(function CompanionViewOverlay() {
  useRenderGuard("CompanionView");
  const emoteCategories = countByCategory();
  const categoryCount = Object.keys(emoteCategories).length;

  return (
    <div className="absolute inset-0 z-10 flex flex-col pointer-events-none">
      <EmotePicker />

      <div
        className="absolute left-4 top-4 z-20 w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-white/15 bg-black/55 p-3 text-white shadow-2xl backdrop-blur-md"
        title="Companion avatar surface"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_0_4px_rgba(52,211,153,0.18)]" />
            <span className="truncate text-xs font-semibold uppercase tracking-normal text-white/80">
              Companion
            </span>
          </div>
          <span className="rounded-full border border-emerald-300/25 bg-emerald-400/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-normal text-emerald-100">
            Ready
          </span>
        </div>

        <div className="grid grid-cols-1 gap-2">
          <CompanionMetric icon="◉" label="Avatar" value="Scene live" />
          <CompanionMetric
            icon="☻"
            label="Agent"
            value={`${AGENT_EMOTE_CATALOG.length} emotes`}
          />
          <CompanionMetric
            icon="◆"
            label="Catalog"
            value={`${EMOTE_CATALOG.length} / ${categoryCount}`}
          />
          <CompanionMetric icon="⌁" label="Chat" value="Overlay relay" />
        </div>
      </div>

      <div className="min-h-0 flex-1" />
    </div>
  );
});

function CompanionMetric({
  icon,
  label,
  value,
}: {
  icon: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-h-10 items-center gap-2 rounded-xl border border-white/10 bg-white/8 px-3 py-2">
      <span
        aria-hidden
        className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white/10 text-sm text-white"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-normal text-white/45">
          {label}
        </div>
        <div className="truncate text-xs font-semibold text-white/90">
          {value}
        </div>
      </div>
    </div>
  );
}

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
          gridTemplateColumns: "1fr",
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
            {AGENT_EMOTE_CATALOG.length} agent emotes / voice{" "}
            {chatAgentVoiceMuted ? "muted" : "live"}
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
            {Object.entries(viewState.emotesByCategory)
              .slice(0, 6)
              .map(([category, count]) => (
                <div key={category}>
                  <span style={{ color: "#64748b" }}>{category}</span> {count}
                </div>
              ))}
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
