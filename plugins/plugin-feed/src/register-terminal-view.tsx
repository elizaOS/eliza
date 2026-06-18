/**
 * Register the Feed view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the Feed `viewType: "tui"` declaration render for real in
 * the terminal (the unified {@link FeedSpatialView}) rather than only routing a
 * GUI shell. A module-level snapshot lets a host push live operator data; before
 * any data arrives it defaults to an empty operator surface.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  type FeedSnapshot,
  FeedSpatialView,
} from "./components/FeedSpatialView.tsx";

const EMPTY: FeedSnapshot = {
  agentStatus: null,
  portfolio: null,
  goal: null,
  recentTrades: [],
  predictionMarkets: [],
  team: { agentCount: 0, totals: null },
  conversations: [],
  chatMessages: [],
  wallet: null,
  tradingBalance: 0,
  controlAction: "resume",
  suggestedPrompts: [],
};

let current: FeedSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setFeedTerminalSnapshot(next: FeedSnapshot): void {
  current = next;
}

/** Register the Feed terminal view; returns an unregister function. */
export function registerFeedTerminalView(): () => void {
  return registerSpatialTerminalView("feed", () =>
    createElement(FeedSpatialView, { snapshot: current }),
  );
}
