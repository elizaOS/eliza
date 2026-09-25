/**
 * Mounts POST `/api/plugins/load-from-directory`, which hot-loads a plugin from
 * an absolute local path into the live runtime and broadcasts a plugin_reloaded
 * view event so the dashboard refreshes the plugin's views. Gated behind the
 * local-code-execution policy (blocked in locked-down store variants) and an
 * available runtime; the directory must be an absolute path.
 */
import type http from "node:http";
import path from "node:path";
import {
  buildStoreVariantBlockedMessage,
  isLocalCodeExecutionAllowed,
} from "@elizaos/core";
import { buildPluginReloadedViewEvent } from "./plugin-reloaded-event.ts";
import type { ServerState } from "./server-types.ts";

type JsonHelper = (
  res: http.ServerResponse,
  data: unknown,
  status?: number,
) => void;

type ErrorHelper = (
  res: http.ServerResponse,
  message: string,
  status?: number,
) => void;

type ReadJsonBody = <T = Record<string, unknown>>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<T | null>;

type LoadPluginFromDirectory =
  typeof import("../runtime/load-plugin-from-directory.ts").loadPluginFromDirectory;

export interface PluginDirectoryRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  state: Pick<ServerState, "runtime" | "broadcastWs">;
  readJsonBody: ReadJsonBody;
  json: JsonHelper;
  error: ErrorHelper;
  isLocalCodeExecutionAllowed?: () => boolean;
  buildStoreVariantBlockedMessage?: (feature: string) => string;
  loadPluginFromDirectory?: LoadPluginFromDirectory;
}

export async function handlePluginDirectoryRoutes(
  ctx: PluginDirectoryRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, state, readJsonBody, json, error } = ctx;
  if (method !== "POST" || pathname !== "/api/plugins/load-from-directory") {
    return false;
  }

  const canLoad =
    ctx.isLocalCodeExecutionAllowed ?? isLocalCodeExecutionAllowed;
  if (!canLoad()) {
    const blockedMessage =
      ctx.buildStoreVariantBlockedMessage ?? buildStoreVariantBlockedMessage;
    error(res, blockedMessage("Local plugin loading"), 403);
    return true;
  }

  if (!state.runtime) {
    error(res, "Agent runtime is not available", 503);
    return true;
  }

  const body = await readJsonBody<{ directory?: unknown; entry?: unknown }>(
    req,
    res,
  );
  if (body === null) return true;

  const directory =
    typeof body.directory === "string" ? body.directory.trim() : "";
  if (!directory || !path.isAbsolute(directory)) {
    error(res, "'directory' must be an absolute path", 400);
    return true;
  }

  const entry = typeof body.entry === "string" ? body.entry : undefined;
  try {
    const loadPluginFromDirectory =
      ctx.loadPluginFromDirectory ??
      (await import("../runtime/load-plugin-from-directory.ts"))
        .loadPluginFromDirectory;
    const result = await loadPluginFromDirectory({
      runtime: state.runtime,
      directory,
      ...(entry ? { entry } : {}),
    });
    state.broadcastWs?.(
      buildPluginReloadedViewEvent({
        pluginName: result.pluginName,
        directory,
        source: "plugins.load-from-directory",
      }),
    );
    json(res, { ok: true, ...result });
  } catch (err) {
    json(
      res,
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      422,
    );
  }

  return true;
}
