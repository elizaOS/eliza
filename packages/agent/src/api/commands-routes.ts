/**
 * GET /api/commands — the universal slash-command catalog.
 *
 * Serves the runtime's enabled commands in wire-safe form so every client
 * surface (the web chat composer, the TUI, and the Discord/Telegram
 * connectors) discovers and renders one source of truth. Optionally scoped to
 * a surface with `?surface=gui|tui|discord|telegram`.
 *
 * Response: `{ commands: SerializedCommand[], surface, agentId, generatedAt }`.
 */

import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import {
  type CommandSurface,
  serializeCommands,
  useRuntime,
} from "@elizaos/plugin-commands";

const VALID_SURFACES: ReadonlySet<string> = new Set([
  "gui",
  "tui",
  "discord",
  "telegram",
]);

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

  const surfaceParam = url.searchParams.get("surface");
  const surface =
    surfaceParam && VALID_SURFACES.has(surfaceParam)
      ? (surfaceParam as CommandSurface)
      : undefined;

  // Scope the module-level command store to this agent (no-op when the agent
  // has no isolated store yet — the shared default catalog is then served).
  if (runtime) useRuntime(runtime.agentId);

  const commands = serializeCommands(surface);
  json(res, {
    commands,
    surface: surface ?? null,
    agentId: runtime?.agentId ?? null,
    generatedAt: new Date().toISOString(),
  });
  return true;
}
