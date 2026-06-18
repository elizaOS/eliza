/**
 * Transport types for the universal slash-command catalog served by
 * `GET /api/commands` (mirrors the connector-neutral catalog in
 * @elizaos/plugin-commands). Kept in the api layer so both the client method
 * and the chat menu share one contract without the api depending on UI code.
 */

export type CommandSurface = "gui" | "tui" | "discord" | "telegram";

export type CommandArgSource =
  | "models"
  | "views"
  | "settings-sections"
  | "skills"
  | "providers";

export type ClientCommandAction =
  | "clear-chat"
  | "new-conversation"
  | "toggle-fullscreen"
  | "open-command-palette"
  | "show-commands";

export interface SlashCommandArg {
  name: string;
  description: string;
  required?: boolean;
  choices?: string[];
  dynamicChoices?: CommandArgSource;
  captureRemaining?: boolean;
}

export type SlashCommandTarget =
  | { kind: "agent"; action?: string }
  | {
      kind: "navigate";
      tab?: string;
      viewId?: string;
      path?: string;
      section?: string;
    }
  | { kind: "client"; clientAction: ClientCommandAction };

/** Where a catalog item came from — drives grouping + labels in the menu. */
export type SlashCommandSource = "builtin" | "custom-action" | "saved";

export interface SlashCommandCatalogItem {
  key: string;
  nativeName: string;
  description: string;
  textAliases: string[];
  scope: "text" | "native" | "both";
  category?: string;
  acceptsArgs: boolean;
  args: SlashCommandArg[];
  requiresAuth: boolean;
  requiresElevated: boolean;
  surfaces?: CommandSurface[];
  target: SlashCommandTarget;
  icon?: string;
  source?: SlashCommandSource;
}

export interface CommandsCatalogResponse {
  commands: SlashCommandCatalogItem[];
  surface: string | null;
  agentId: string | null;
  generatedAt: string;
}
