/**
 * Canonical wire contract for the universal slash-command catalog served by
 * `GET /api/commands`. This is the single declaration of the command transport
 * shape — the projection `serializeCommand` produces, the TUI autocomplete
 * consumes, the web composer renders, and the connector bridges forward.
 *
 * The domain vocabulary (`CommandScope`, `CommandCategory`, `CommandSurface`,
 * `CommandArgSource`, `ClientCommandAction`, `CommandTarget`) lives in
 * `@elizaos/core` alongside `CommandDefinition`; those types are re-exported
 * here so every wire consumer references one enum/union and cannot drift (the
 * TUI previously carried a hand-synced copy that lost `toggle-transcription`,
 * the `source` field, `views`, and the strong `category` union — #12411).
 *
 * Kept in the shared api layer next to `agent-api-types` so agent, UI, TUI, and
 * `@elizaos/plugin-commands` import one contract without a runtime dependency
 * on the plugin.
 */

import type {
  CommandArgSource,
  CommandCategory,
  CommandScope,
  CommandSurface,
  CommandTarget,
} from "@elizaos/core";

export type {
  ClientCommandAction,
  CommandArgSource,
  CommandCategory,
  CommandScope,
  CommandSurface,
  CommandTarget,
} from "@elizaos/core";

/**
 * Wire-safe argument shape produced by `serializeCommand`. Static `choices` are
 * inlined; `dynamicChoices` names a live source the client resolves at render
 * time (function-valued definition choices drop to their tagged source).
 */
export interface SerializedCommandArg {
  name: string;
  description: string;
  required?: boolean;
  choices?: string[];
  dynamicChoices?: CommandArgSource;
  captureRemaining?: boolean;
}

/** Where a serialized catalog item came from — drives menu grouping/labels. */
export type SerializedCommandSource = "builtin" | "custom-action" | "saved";

/**
 * The wire shape `GET /api/commands` serves and every client renders. Produced
 * by `serializeCommand` (`@elizaos/plugin-commands`) with no field fabricated at
 * the HTTP boundary. `target` is the `@elizaos/core` `CommandTarget` discriminant
 * every surface routes on.
 */
export interface SerializedCommand {
  key: string;
  nativeName: string;
  description: string;
  textAliases: string[];
  scope: CommandScope;
  category?: CommandCategory;
  acceptsArgs: boolean;
  args: SerializedCommandArg[];
  requiresAuth: boolean;
  requiresElevated: boolean;
  surfaces?: CommandSurface[];
  target: CommandTarget;
  icon?: string;
  source: SerializedCommandSource;
  /** View ids this command is scoped to (#8798); omitted when global. */
  views?: string[];
}

/** Response body of `GET /api/commands`. */
export interface CommandsCatalogResponse {
  commands: SerializedCommand[];
  surface: string | null;
  activeViewId?: string | null;
  agentId: string | null;
  generatedAt: string;
}
