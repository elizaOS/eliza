import type http from "node:http";
import type { ReadJsonBodyOptions } from "@elizaos/core";
import { PutUpdateChannelRequestSchema } from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpdateRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  state: { config: ElizaConfig };
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  saveElizaConfig: (config: ElizaConfig) => void;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleUpdateRoutes(
  ctx: UpdateRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, state, json, error, readJsonBody } = ctx;

  // ── GET /api/update/status ───────────────────────────────────────────
  if (method === "GET" && pathname === "/api/update/status") {
    const { VERSION } = await import("../runtime/version.ts");
    const {
      resolveChannel,
      checkForUpdate,
      fetchAllChannelVersions,
      CHANNEL_DIST_TAGS,
    } = await import("../services/update-checker.ts");
    const { detectInstallMethod } = await import("../services/self-updater.ts");
    const channel = resolveChannel(state.config.update);

    const [check, versions] = await Promise.all([
      checkForUpdate({ force: req.url?.includes("force=true") }),
      fetchAllChannelVersions(),
    ]);

    json(res, {
      currentVersion: VERSION,
      channel,
      installMethod: detectInstallMethod(),
      updateAvailable: check.updateAvailable,
      latestVersion: check.latestVersion,
      channels: {
        stable: versions.stable,
        beta: versions.beta,
        nightly: versions.nightly,
      },
      distTags: CHANNEL_DIST_TAGS,
      lastCheckAt: state.config.update?.lastCheckAt ?? null,
      error: check.error,
    });
    return true;
  }

  // ── PUT /api/update/channel ────────────────────────────────────────────
  if (method === "PUT" && pathname === "/api/update/channel") {
    const rawCh = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawCh === null) return true;
    const parsedCh = PutUpdateChannelRequestSchema.safeParse(rawCh);
    if (!parsedCh.success) {
      error(
        res,
        parsedCh.error.issues[0]?.message ??
          `Invalid channel. Must be stable, beta, or nightly.`,
      );
      return true;
    }
    const ch = parsedCh.data.channel;
    state.config.update = {
      ...state.config.update,
      channel: ch,
      lastCheckAt: undefined,
      lastCheckVersion: undefined,
    };
    ctx.saveElizaConfig(state.config);
    json(res, { channel: ch });
    return true;
  }

  return false;
}
