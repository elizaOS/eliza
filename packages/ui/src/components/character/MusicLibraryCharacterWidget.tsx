/**
 * Chat-sidebar widget for the music-library plugin (registered in
 * widgets/registry as `music-library.playlists`): a compact panel of quick
 * commands that seed the chat composer with prompts like "show my playlists".
 * It only issues prompts — it holds no music state of its own.
 */
import { ListMusic, Music, Plus, Search } from "lucide-react";
import type { WidgetProps } from "../../widgets/types";

const MUSIC_LIBRARY_COMMANDS = [
  {
    icon: <ListMusic className="h-3.5 w-3.5" aria-hidden />,
    label: "Show saved playlists",
    prompt: "show my playlists",
  },
  {
    icon: <Plus className="h-3.5 w-3.5" aria-hidden />,
    label: "Save the current queue",
    prompt: "save this as a playlist",
  },
  {
    icon: <Search className="h-3.5 w-3.5" aria-hidden />,
    label: "Find music",
    prompt: "search YouTube for music",
  },
];

export function MusicLibraryCharacterWidget({ pluginState }: WidgetProps) {
  if (pluginState?.enabled === false) return null;

  const pluginReady = pluginState?.isActive === true;

  return (
    /* Flat — no card/border. Widgets render chromeless; the shell owns padding. */
    <section data-testid="character-widget-music-library">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Music className="h-4 w-4 shrink-0 text-accent" aria-hidden />
          <h2 className="truncate text-sm font-semibold text-txt">
            Music Library
          </h2>
        </div>
        <span
          className={`shrink-0 text-3xs font-semibold uppercase tracking-[0.12em] ${
            pluginReady ? "text-ok" : "text-muted"
          }`}
        >
          {pluginReady ? "Active" : "Plugin"}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {MUSIC_LIBRARY_COMMANDS.map((command) => (
          <div key={command.label} className="min-w-0">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-txt">
              <span className="text-muted">{command.icon}</span>
              <span className="truncate">{command.label}</span>
            </div>
            <div className="truncate font-mono text-3xs text-muted">
              {command.prompt}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
