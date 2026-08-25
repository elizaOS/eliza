/** Chat-sidebar widget-registry definition for the music player (id, order, component). */
import { MusicPlayerSidebarWidget } from "./music-player";
import type { ChatSidebarWidgetDefinition } from "./types";

export const MUSIC_PLAYER_WIDGET: ChatSidebarWidgetDefinition = {
  id: "music-player.stream",
  pluginId: "music-player",
  order: 125,
  defaultEnabled: true,
  Component: MusicPlayerSidebarWidget,
};
