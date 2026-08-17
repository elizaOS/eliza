/**
 * GET /api/commands — the universal slash-command catalog.
 *
 * Serves the connector-neutral command catalog in wire-safe form so client
 * surfaces (the web chat composer, the TUI) discover and render one source of
 * truth. Scoped to a surface with `?surface=gui|tui|discord|telegram` — the
 * surface actually filters the result (commands declare the `surfaces` they
 * belong to) and is echoed in the response.
 *
 * This route is a *runtime-scoped projection*: it calls
 * `getCatalogCommands(surface, { agentId })` from `@elizaos/plugin-commands`,
 * which runs every enabled `CommandDefinition` through `serializeCommand`. The
 * route fabricates nothing — `surfaces`, `requiresAuth`, `requiresElevated`,
 * `category`, `dynamicChoices`, `icon`, and the full `textAliases` all come
 * straight from the definitions (#8790).
 *
 * Response: `{ commands: SerializedCommand[], surface, activeViewId, agentId, generatedAt }`.
 */

import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import { getCatalogCommands } from "@elizaos/plugin-commands";
import { getCurrentViewState } from "./views-routes.js";

const VALID_SURFACES: ReadonlySet<string> = new Set([
  "gui",
  "tui",
  "discord",
  "telegram",
]);

type CommandSurface = "gui" | "tui" | "discord" | "telegram";

const SURFACE_ERROR = "surface must be one of: gui, tui, discord, telegram";

/**
 * Parse the slash-command catalog `surface` query. Omitted/empty keeps the
 * historical GUI default (response `surface` stays null). A known surface
 * filters the catalog. Any other token used to fall through to that same GUI
 * catalog, so `surface=DISCORD` or `surface=web` silently served GUI-only
 * commands.
 */
export function parseCommandSurface(
  raw: string | null,
):
  | { ok: true; surface: CommandSurface | null }
  | { ok: false; message: string } {
  if (raw === null || raw === "") return { ok: true, surface: null };
  if (VALID_SURFACES.has(raw)) {
    return { ok: true, surface: raw as CommandSurface };
  }
  return { ok: false, message: SURFACE_ERROR };
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

export async function handleCommandsRoutes(
  ctx: CommandsRouteContext,
): Promise<boolean> {
  const { res, method, pathname, url, json, error, runtime } = ctx;
  if (pathname !== "/api/commands") return false;
  if (method !== "GET") {
    error(res, "Method not allowed", 405);
    return true;
  }

  const parsedSurface = parseCommandSurface(url.searchParams.get("surface"));
  if (!parsedSurface.ok) {
    error(res, parsedSurface.message, 400);
    return true;
  }
  const surface = parsedSurface.surface;

  // View-scoped commands (#8798) appear only when their view is foreground.
  // Prefer an explicit ?view= (the client knows what it is rendering), else fall
  // back to the agent's server-side current view.
  const activeViewId =
    url.searchParams.get("view") ?? getCurrentViewState()?.viewId ?? null;

  // Absent `?surface=` defaults to the web composer's surface (its historical
  // consumer); an explicit surface filters to exactly that surface's commands.
  const commands = getCatalogCommands(surface ?? "gui", {
    activeViewId,
    agentId: runtime?.agentId ?? null,
  });
  json(res, {
    commands,
    surface,
    activeViewId,
    agentId: runtime?.agentId ?? null,
    generatedAt: new Date().toISOString(),
  });
  return true;
}
