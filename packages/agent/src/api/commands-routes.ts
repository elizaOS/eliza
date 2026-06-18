/**
 * GET /api/commands — the universal slash-command catalog.
 *
 * Serves the connector-neutral command catalog in wire-safe form so client
 * surfaces (the web chat composer, the TUI) discover and render one source of
 * truth. Optionally scoped to a surface with `?surface=gui|tui|discord|telegram`
 * (the surface is echoed in the response; the develop catalog is uniform across
 * connectors, so the parameter does not filter).
 *
 * The data source is `getConnectorCommands` from `@elizaos/plugin-commands`,
 * which re-projects the agent's enabled text-command registry plus the app's
 * navigation surface into a `ConnectorCommand` shape. Each `ConnectorCommand`
 * is mapped here onto the `SlashCommandCatalogItem` shape the clients consume.
 *
 * Response: `{ commands: SlashCommandCatalogItem[], surface, agentId, generatedAt }`.
 */

import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import {
  type ClientCommandAction,
  type ConnectorCommand,
  type ConnectorCommandOption,
  getConnectorCommands,
} from "@elizaos/plugin-commands";

const VALID_SURFACES: ReadonlySet<string> = new Set([
  "gui",
  "tui",
  "discord",
  "telegram",
]);

type CommandSurface = "gui" | "tui" | "discord" | "telegram";

type SlashCommandArgSource =
  | "models"
  | "views"
  | "settings-sections"
  | "skills"
  | "providers";

interface SlashCommandArg {
  name: string;
  description: string;
  required?: boolean;
  choices?: string[];
  dynamicChoices?: SlashCommandArgSource;
}

type SlashCommandTarget =
  | { kind: "agent" }
  | {
      kind: "navigate";
      tab?: string;
      viewId?: string;
      path?: string;
      section?: string;
    }
  | { kind: "client"; clientAction: ClientCommandAction };

interface SlashCommandCatalogItem {
  key: string;
  nativeName: string;
  description: string;
  textAliases: string[];
  scope: "text" | "native" | "both";
  acceptsArgs: boolean;
  args: SlashCommandArg[];
  requiresAuth: boolean;
  requiresElevated: boolean;
  target: SlashCommandTarget;
  source: "builtin";
}

export interface CommandsRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  runtime: AgentRuntime | null | undefined;
}

/** Map a catalog option onto a client arg, tagging known dynamic sources. */
function mapOption(option: ConnectorCommandOption): SlashCommandArg {
  const dynamicChoices: SlashCommandArgSource | undefined =
    option.name === "section" ? "settings-sections" : undefined;
  return {
    name: option.name,
    description: option.description,
    required: option.required,
    choices: option.choices,
    ...(dynamicChoices ? { dynamicChoices } : {}),
  };
}

/** Map the connector-neutral target onto the client target shape. */
function mapTarget(target: ConnectorCommand["target"]): SlashCommandTarget {
  if (target.kind === "navigate") {
    // Pass the catalog's routing hints through verbatim: the GUI opens `tab`
    // (or `viewId`) directly; `path` is the connector deep link; `section`
    // focuses a settings sub-section.
    return {
      kind: "navigate",
      path: target.path,
      ...(target.tab ? { tab: target.tab } : {}),
      ...(target.viewId ? { viewId: target.viewId } : {}),
      ...(target.section ? { section: target.section } : {}),
    };
  }
  if (target.kind === "client") {
    return { kind: "client", clientAction: target.clientAction };
  }
  return { kind: "agent" };
}

/** Project a `ConnectorCommand` onto the wire-safe `SlashCommandCatalogItem`. */
function toCatalogItem(command: ConnectorCommand): SlashCommandCatalogItem {
  return {
    key: command.name,
    nativeName: command.name,
    description: command.description,
    textAliases: [`/${command.name}`],
    scope: "both",
    acceptsArgs: command.options.length > 0,
    args: command.options.map(mapOption),
    requiresAuth: false,
    requiresElevated: false,
    target: mapTarget(command.target),
    source: "builtin",
  };
}

export async function handleCommandsRoutes(
  ctx: CommandsRouteContext,
): Promise<boolean> {
  const { res, method, pathname, url, json, error, runtime } = ctx;
  if (pathname !== "/api/commands") return false;
  if (method !== "GET") {
    error(res, "Method not allowed", 405);
    return true;
  }

  const surfaceParam = url.searchParams.get("surface");
  const surface: CommandSurface | null =
    surfaceParam && VALID_SURFACES.has(surfaceParam)
      ? (surfaceParam as CommandSurface)
      : null;

  const commands = getConnectorCommands(surface ?? "gui").map(toCatalogItem);
  json(res, {
    commands,
    surface,
    agentId: runtime?.agentId ?? null,
    generatedAt: new Date().toISOString(),
  });
  return true;
}
