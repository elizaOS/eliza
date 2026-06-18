/**
 * CompanionSpatialView — the companion surface authored once with the spatial
 * vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR — mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      — rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * The primary companion view is a Three.js WebGL canvas hosting a 3D VRM avatar
 * (`VrmStage`/`VrmViewer`/`VrmEngine`), which cannot render in XR-scaled DOM or
 * in a terminal. This is the `canvasOnly` operator panel: a concise, purely
 * presentational status + controls surface (a snapshot + an action callback in,
 * primitives out). It imports only the cross-modality primitives, so it is safe
 * to render in the Node agent process where the terminal lives (no Three.js /
 * Capacitor runtime import).
 */

import {
  Button,
  Card,
  Divider,
  HStack,
  List,
  type SpatialTone,
  Text,
} from "@elizaos/ui/spatial";

/** Cloud-inference notice severity, derived in a use-case before this view. */
export type CompanionInferenceNoticeKind =
  | "connected"
  | "disconnected"
  | "auth"
  | "credits"
  | "disabled"
  | null;

export interface CompanionSnapshot {
  /** 3D VRM avatar / scene. */
  avatarReady: boolean;
  selectedVrmIndex: number;
  customVrmUrl: string | null;
  uiTheme: string;
  companionZoom: number;
  dragOrbit: { yaw: number; pitch: number };

  /** Conversation state. */
  messageCount: number;
  assistantCount: number;
  userCount: number;
  interruptedAssistantCount: number;
  lastMessage: string | null;
  lastUsageModel: string | null;
  chatAgentVoiceMuted: boolean;

  /** Emote system. */
  emoteCount: number;
  agentEmoteCount: number;
  emotesByCategory: Record<string, number>;
  emotePickerOpen: boolean;
  playingEmoteId: string | null;

  /** Cloud inference status. */
  elizaCloudConnected: boolean;
  elizaCloudEnabled: boolean;
  elizaCloudAuthRejected: boolean;
  elizaCloudCreditsError: boolean;
  inferenceNoticeKind: CompanionInferenceNoticeKind;

  /** UI state. */
  uiLanguage: string;
  tab: string | null;
  activeOverlayApp: string | null;
}

function noticeTone(kind: CompanionInferenceNoticeKind): SpatialTone {
  switch (kind) {
    case "auth":
    case "disconnected":
      return "danger";
    case "credits":
      return "warning";
    case "disabled":
      return "muted";
    case "connected":
      return "success";
    default:
      return "muted";
  }
}

function noticeLabel(kind: CompanionInferenceNoticeKind): string {
  switch (kind) {
    case "auth":
      return "cloud auth rejected";
    case "credits":
      return "cloud credits error";
    case "disconnected":
      return "cloud disconnected";
    case "disabled":
      return "cloud disabled";
    case "connected":
      return "cloud connected";
    default:
      return "no notice";
  }
}

function avatarLabel(snapshot: CompanionSnapshot): string {
  if (snapshot.customVrmUrl) return "custom VRM";
  return `VRM #${snapshot.selectedVrmIndex}`;
}

export interface CompanionSpatialViewProps {
  snapshot: CompanionSnapshot;
  /** Dispatch by agent id: `toggle-voice`, `new-chat`, `toggle-emotes`, `stop-emote`, `settings`. */
  onAction?: (action: string) => void;
}

export function CompanionSpatialView({
  snapshot,
  onAction,
}: CompanionSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  const categories = Object.entries(snapshot.emotesByCategory).slice(0, 6);
  return (
    <Card title="Companion" gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Text
          style="caption"
          tone={snapshot.avatarReady ? "success" : "warning"}
          grow={1}
        >
          {snapshot.avatarReady ? "avatar-ready" : "avatar-loading"}
        </Text>
        <Text style="caption" tone="muted">
          {snapshot.messageCount} msgs
        </Text>
      </HStack>

      <Divider label="scene" />
      <List gap={0}>
        <HStack gap={1} agent="scene-avatar">
          <Text tone="muted" grow={1}>
            avatar
          </Text>
          <Text bold>{avatarLabel(snapshot)}</Text>
        </HStack>
        <HStack gap={1} agent="scene-theme">
          <Text tone="muted" grow={1}>
            theme
          </Text>
          <Text>{snapshot.uiTheme}</Text>
        </HStack>
        <HStack gap={1} agent="scene-zoom">
          <Text tone="muted" grow={1}>
            zoom / orbit
          </Text>
          <Text>
            {snapshot.companionZoom.toFixed(2)}x y{" "}
            {snapshot.dragOrbit.yaw.toFixed(0)} p{" "}
            {snapshot.dragOrbit.pitch.toFixed(0)}
          </Text>
        </HStack>
      </List>

      <Divider label="conversation" />
      <List gap={0}>
        <HStack gap={1} agent="conversation-turns">
          <Text tone="muted" grow={1}>
            user / assistant
          </Text>
          <Text>
            {snapshot.userCount} / {snapshot.assistantCount}
          </Text>
        </HStack>
        {snapshot.interruptedAssistantCount > 0 ? (
          <HStack gap={1} agent="conversation-interrupted">
            <Text tone="muted" grow={1}>
              interrupted
            </Text>
            <Text tone="warning">{snapshot.interruptedAssistantCount}</Text>
          </HStack>
        ) : null}
        <HStack gap={1} agent="conversation-model">
          <Text tone="muted" grow={1}>
            last model
          </Text>
          <Text>{snapshot.lastUsageModel ?? "none"}</Text>
        </HStack>
        <HStack gap={1} agent="conversation-voice">
          <Text tone="muted" grow={1}>
            voice
          </Text>
          <Text tone={snapshot.chatAgentVoiceMuted ? "danger" : "success"}>
            {snapshot.chatAgentVoiceMuted ? "muted" : "live"}
          </Text>
        </HStack>
      </List>

      <Divider label="cloud" />
      <Text style="caption" tone={noticeTone(snapshot.inferenceNoticeKind)}>
        {noticeLabel(snapshot.inferenceNoticeKind)}
      </Text>

      <Divider label="emotes" />
      <HStack gap={1} align="center">
        <Text style="caption" tone="muted" grow={1}>
          {snapshot.emoteCount} total / {snapshot.agentEmoteCount} agent
        </Text>
        {snapshot.playingEmoteId ? (
          <Text style="caption" tone="primary">
            playing {snapshot.playingEmoteId}
          </Text>
        ) : null}
      </HStack>
      {categories.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No emote categories
        </Text>
      ) : (
        <List gap={0}>
          {categories.map(([category, count]) => (
            <HStack key={category} gap={1} agent={`emote-cat-${category}`}>
              <Text tone="muted" grow={1}>
                {category}
              </Text>
              <Text>{count}</Text>
            </HStack>
          ))}
        </List>
      )}

      <Divider label="controls" />
      <HStack gap={1} wrap>
        <Button
          grow={1}
          variant="outline"
          tone="default"
          agent="toggle-voice"
          onPress={dispatch("toggle-voice")}
        >
          {snapshot.chatAgentVoiceMuted ? "Unmute" : "Mute"}
        </Button>
        <Button grow={1} agent="new-chat" onPress={dispatch("new-chat")}>
          New chat
        </Button>
      </HStack>
      <HStack gap={1} wrap>
        <Button
          grow={1}
          variant="outline"
          tone="default"
          agent="toggle-emotes"
          onPress={dispatch("toggle-emotes")}
        >
          {snapshot.emotePickerOpen ? "Close emotes" : "Open emotes"}
        </Button>
        {snapshot.playingEmoteId ? (
          <Button
            variant="ghost"
            tone="danger"
            agent="stop-emote"
            onPress={dispatch("stop-emote")}
          >
            Stop
          </Button>
        ) : null}
        <Button
          variant="ghost"
          tone="default"
          agent="settings"
          onPress={dispatch("settings")}
        >
          Settings
        </Button>
      </HStack>
    </Card>
  );
}
