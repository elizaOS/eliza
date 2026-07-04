/**
 * Transport types for the universal slash-command catalog served by
 * `GET /api/commands`. The wire contract is declared once in `@elizaos/shared`
 * (`SerializedCommand*`); the `SlashCommand*` names below are the UI-local
 * aliases the chat menu and client method use. Aliasing (not re-declaring) is
 * what keeps this surface from drifting off the shared contract (#12411).
 */

import type {
  SerializedCommand,
  SerializedCommandArg,
  SerializedCommandSource,
} from "@elizaos/shared";

export type {
  ClientCommandAction,
  CommandArgSource,
  CommandSurface,
  CommandsCatalogResponse,
  CommandTarget as SlashCommandTarget,
  SerializedCommand,
  SerializedCommandArg,
  SerializedCommandSource,
} from "@elizaos/shared";

/** UI-local alias for the wire argument shape. */
export type SlashCommandArg = SerializedCommandArg;

/** UI-local alias for a catalog item's provenance. */
export type SlashCommandSource = SerializedCommandSource;

/** UI-local alias for a wire catalog item. */
export type SlashCommandCatalogItem = SerializedCommand;
