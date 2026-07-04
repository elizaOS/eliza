/**
 * Transport types for the universal slash-command catalog served by
 * `GET /api/commands`. The wire contract is defined once in @elizaos/core
 * (`types/commands`) and consumed by every surface; this module just re-exports
 * it under the UI's historical `SlashCommand*` names so the consumers
 * (slash-menu, useSlashCommandController, client-skills, tests, stories) keep
 * resolving without churn.
 */

export type {
  ClientCommandAction,
  CommandArgSource,
  CommandsCatalogResponse,
  CommandSurface,
  SerializedCommandArg as SlashCommandArg,
  SerializedCommand as SlashCommandCatalogItem,
  SerializedCommandSource as SlashCommandSource,
  CommandTarget as SlashCommandTarget,
} from "@elizaos/core";
