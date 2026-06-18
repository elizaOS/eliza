/**
 * Register the companion view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the companion's `viewType: "tui"` declaration render for
 * real in the terminal (the unified {@link CompanionSpatialView}) rather than
 * only navigating a GUI shell. The primary companion surface is a Three.js VRM
 * canvas; the terminal gets the `canvasOnly` operator panel instead. A
 * module-level snapshot lets a host push live companion state; absent a host it
 * defaults to an idle, avatar-loading panel.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type CompanionSnapshot,
  CompanionSpatialView,
} from "./components/companion/CompanionSpatialView.tsx";

const EMPTY: CompanionSnapshot = {
  avatarReady: false,
  selectedVrmIndex: 0,
  customVrmUrl: null,
  uiTheme: "system",
  companionZoom: 1,
  dragOrbit: { yaw: 0, pitch: 0 },
  messageCount: 0,
  assistantCount: 0,
  userCount: 0,
  interruptedAssistantCount: 0,
  lastMessage: null,
  lastUsageModel: null,
  chatAgentVoiceMuted: false,
  emoteCount: 0,
  agentEmoteCount: 0,
  emotesByCategory: {},
  emotePickerOpen: false,
  playingEmoteId: null,
  elizaCloudConnected: false,
  elizaCloudEnabled: false,
  elizaCloudAuthRejected: false,
  elizaCloudCreditsError: false,
  inferenceNoticeKind: null,
  uiLanguage: "en",
  tab: null,
  activeOverlayApp: null,
};

let current: CompanionSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setCompanionTerminalSnapshot(next: CompanionSnapshot): void {
  current = next;
}

/** Register the companion terminal view; returns an unregister function. */
export function registerCompanionTerminalView(): () => void {
  return registerSpatialTerminalView("companion", () =>
    createElement(CompanionSpatialView, { snapshot: current }),
  );
}
