/**
 * Canonical wire contract for the universal slash-command catalog served by
 * `GET /api/commands` and consumed by the web composer (`@elizaos/ui`), the TUI
 * autocomplete (`@elizaos/agent`), and the connector bridges + serializer
 * (`@elizaos/plugin-commands`). These types describe the HTTP contract and must
 * not contain Node.js-only imports or React-specific code so they remain
 * importable in both environments.
 *
 * Previously each of those three packages held its own hand-synced copy (the
 * plugin's richest definition, the UI's `SlashCommand*` aliases, and a TUI copy
 * that had drifted — it was missing `source` and `toggle-transcription`). The
 * authoritative definitions live here; all three now import from
 * @elizaos/shared, so a fourth divergence cannot happen.
 */

/**
 * The surfaces a command is offered on. Omitted/undefined on a catalog item
 * means "all surfaces" (the default). The catalog serializer filters on this.
 */
export type CommandSurface = "gui" | "tui" | "discord" | "telegram";

/**
 * A live source a client resolves an argument's choices from at render time
 * (the registry can't enumerate models/views/skills/providers statically). The
 * serialized arg tags the source; the client fetches the concrete values.
 */
export type CommandArgSource =
  | "models"
  | "views"
  | "settings-sections"
  | "skills"
  | "providers";

/**
 * Client-only behaviors the in-app surfaces (GUI/TUI) run directly, with no
 * agent round-trip and no remote surface. Connectors filter `client` targets
 * out (a Discord/Telegram user has nothing to clear or full-screen).
 */
export type ClientCommandAction =
  | "clear-chat"
  | "new-conversation"
  | "toggle-fullscreen"
  | "open-command-palette"
  | "show-commands"
  | "toggle-transcription";

/**
 * Wire-safe argument shape produced by the catalog serializer. Function-valued
 * choices in the definition collapse to `dynamicChoices` (a live source the
 * client resolves) or a static `choices` array — never a fabricated list.
 */
export interface SerializedCommandArg {
  name: string;
  description: string;
  required?: boolean;
  choices?: string[];
  dynamicChoices?: CommandArgSource;
  captureRemaining?: boolean;
}

/**
 * Where a serialized command executes — the single discriminant every surface
 * routes on:
 *   - `agent`    → the command runs through the agent (a deterministic command
 *                  action handles it; `action` names that handler when known).
 *   - `navigate` → opens a destination in the Eliza app; `path` is the in-app
 *                  deep link, `tab`/`viewId`/`section` are routing hints. `path`
 *                  is optional on the wire (both clients guard it with `?? ""`).
 *   - `client`   → a GUI/TUI-only behavior with no remote surface.
 */
export type SerializedCommandTarget =
  | { kind: "agent"; action?: string }
  | {
      kind: "navigate";
      path?: string;
      tab?: string;
      viewId?: string;
      section?: string;
    }
  | { kind: "client"; clientAction: ClientCommandAction };

/** Where a serialized catalog item came from — drives menu grouping/labels. */
export type SerializedCommandSource = "builtin" | "custom-action" | "saved";

/**
 * The canonical wire shape served by `GET /api/commands` and consumed by the
 * web composer, the TUI autocomplete, and the connector bridges. This is the
 * single contract the route projects — no field is fabricated at the HTTP
 * boundary.
 */
export interface SerializedCommand {
  key: string;
  nativeName: string;
  description: string;
  textAliases: string[];
  scope: "text" | "native" | "both";
  category?: string;
  acceptsArgs: boolean;
  args: SerializedCommandArg[];
  requiresAuth: boolean;
  requiresElevated: boolean;
  surfaces?: CommandSurface[];
  target: SerializedCommandTarget;
  icon?: string;
  source: SerializedCommandSource;
  /** View ids this command is scoped to (#8798); omitted when global. */
  views?: string[];
}

/** The full `GET /api/commands` response envelope. */
export interface CommandsCatalogResponse {
  commands: SerializedCommand[];
  surface: string | null;
  agentId: string | null;
  generatedAt: string;
}
