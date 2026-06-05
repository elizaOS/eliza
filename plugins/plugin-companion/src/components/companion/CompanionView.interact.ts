// View-bundle `interact` capability handler, split out of CompanionView.tsx so
// that file exports only React components and stays Fast-Refresh-compatible
// (Vite would full-reload a component file that also exports a plain function).
// The view bundle re-exports `interact` via ./companion-view-bundle.ts.

import {
  dispatchAppEmoteEvent,
  dispatchAppEvent,
  STOP_EMOTE_EVENT,
} from "@elizaos/ui/events";
import {
  AGENT_EMOTE_CATALOG,
  EMOTE_CATALOG,
  type EmoteCategory,
  getEmote,
} from "../../emotes/catalog";
import { countByCategory } from "./CompanionView.helpers";

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
