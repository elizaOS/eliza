import type http from "node:http";
import { logger } from "@elizaos/core";
import {
  authenticateEmbedLaunch,
  type EmbedPlatform,
} from "../embed/embed-auth.ts";
import {
  type CompatRuntimeState,
  readCompatJsonBody,
} from "./compat-route-shared";
import { sendJson } from "./response";

export interface EmbedAuthRouteDeps {
  telegramBotToken?: string;
  sessionSecret?: string;
  roleAccess?: Parameters<typeof authenticateEmbedLaunch>[0]["roleAccess"];
}

function readString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readPlatform(value: string | null): EmbedPlatform | null {
  return value === "telegram" || value === "discord" ? value : null;
}

function resolveTelegramBotToken(deps: EmbedAuthRouteDeps): string | undefined {
  return (
    deps.telegramBotToken ??
    process.env.TELEGRAM_BOT_TOKEN ??
    process.env.ELIZA_TELEGRAM_BOT_TOKEN
  );
}

function resolveSessionSecret(deps: EmbedAuthRouteDeps): string | undefined {
  return (
    deps.sessionSecret ??
    process.env.ELIZA_EMBED_SESSION_SECRET ??
    process.env.ELIZA_API_TOKEN ??
    process.env.ELIZA_API_AUTH_TOKEN
  );
}

export async function handleEmbedAuthRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
  deps: EmbedAuthRouteDeps = {},
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  if (method !== "POST" || url.pathname !== "/api/embed/auth") {
    return false;
  }

  if (!state.current) {
    sendJson(res, 503, { error: "runtime_unavailable" });
    return true;
  }

  const body = await readCompatJsonBody(req, res);
  if (!body) return true;

  const platform = readPlatform(readString(body, "platform"));
  const signedLaunchPayload = readString(body, "signedLaunchPayload");
  if (!platform || !signedLaunchPayload) {
    sendJson(res, 400, { error: "invalid_embed_auth_request" });
    return true;
  }

  const sessionSecret = resolveSessionSecret(deps);
  if (!sessionSecret) {
    logger.warn(
      { src: "app-core:embed-auth", platform },
      "[EmbedAuthRoute] missing session secret",
    );
    sendJson(res, 503, { error: "embed_session_secret_unavailable" });
    return true;
  }

  const result = await authenticateEmbedLaunch({
    runtime: state.current,
    platform,
    signedLaunchPayload,
    telegramBotToken: resolveTelegramBotToken(deps),
    accountId: readString(body, "accountId") ?? undefined,
    sessionSecret,
    roleAccess: deps.roleAccess,
  });

  if (!result.ok) {
    logger.warn(
      {
        src: "app-core:embed-auth",
        platform,
        status: result.status,
        error: result.error,
      },
      "[EmbedAuthRoute] embed launch verification rejected",
    );
    sendJson(res, result.status, {
      error: result.error ?? "embed_auth_failed",
    });
    return true;
  }

  logger.info(
    {
      src: "app-core:embed-auth",
      platform,
      role: result.sender?.role,
      entityId: result.sender?.entityId,
    },
    "[EmbedAuthRoute] embed launch verified",
  );
  sendJson(res, 200, {
    token: result.token,
    platform: result.sender?.platform,
    role: result.sender?.role,
    adminMode: true,
  });
  return true;
}
