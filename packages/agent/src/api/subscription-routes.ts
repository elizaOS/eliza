import { logger } from "@elizaos/core";
import type { AnthropicFlow } from "../auth/anthropic";
import type { CodexFlow } from "../auth/openai-codex";
import type { OAuthCredentials } from "../auth/types";
import type { ElizaConfig } from "../config/types.eliza";
import type { RouteRequestContext } from "./route-helpers";

type AuthModule = typeof import("../auth/index");

export type SubscriptionAuthApi = Pick<
  AuthModule,
  | "getSubscriptionStatus"
  | "startAnthropicLogin"
  | "startCodexLogin"
  | "saveCredentials"
  | "applySubscriptionCredentials"
  | "deleteCredentials"
>;

export interface SubscriptionRouteState {
  config: ElizaConfig;
  _anthropicFlow?: AnthropicFlow;
  _codexFlow?: CodexFlow;
  _codexFlowTimer?: ReturnType<typeof setTimeout>;
}

export interface SubscriptionRouteContext extends RouteRequestContext {
  state: SubscriptionRouteState;
  saveConfig: (config: ElizaConfig) => void;
  loadSubscriptionAuth: () => Promise<SubscriptionAuthApi>;
}

export async function handleSubscriptionRoutes(
  ctx: SubscriptionRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    state,
    readJsonBody,
    json,
    error,
    loadSubscriptionAuth,
  } = ctx;
  if (!pathname.startsWith("/api/subscription/")) return false;

  if (method === "GET" && pathname === "/api/subscription/status") {
    try {
      const { getSubscriptionStatus } = await loadSubscriptionAuth();
      json(res, { providers: getSubscriptionStatus() });
    } catch (err) {
      logger.error(
        `[api] Failed to get subscription status: ${err instanceof Error ? err.stack : err}`,
      );
      error(res, "Failed to get subscription status", 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/subscription/anthropic/start") {
    try {
      const { startAnthropicLogin } = await loadSubscriptionAuth();
      const flow = await startAnthropicLogin();
      state._anthropicFlow = flow;
      json(res, { authUrl: flow.authUrl });
    } catch (err) {
      logger.error(
        `[api] Failed to start Anthropic login: ${err instanceof Error ? err.stack : err}`,
      );
      error(res, "Failed to start Anthropic login", 500);
    }
    return true;
  }

  if (
    method === "POST" &&
    pathname === "/api/subscription/anthropic/exchange"
  ) {
    const body = await readJsonBody<{ code: string }>(req, res);
    if (!body) return true;
    if (!body.code) {
      error(res, "Missing code", 400);
      return true;
    }
    try {
      const { saveCredentials, applySubscriptionCredentials } =
        await loadSubscriptionAuth();
      const flow = state._anthropicFlow;
      if (!flow) {
        error(res, "No active flow — call /start first", 400);
        return true;
      }
      flow.submitCode(body.code);
      const credentials = await flow.credentials;
      saveCredentials("anthropic-subscription", credentials);
      await applySubscriptionCredentials(state.config);
      delete state._anthropicFlow;
      json(res, { success: true, expiresAt: credentials.expires });
    } catch (err) {
      delete state._anthropicFlow;
      logger.error(
        `[api] Anthropic exchange failed: ${err instanceof Error ? err.stack : err}`,
      );
      error(res, "Anthropic exchange failed", 500);
    }
    return true;
  }

  if (
    method === "POST" &&
    pathname === "/api/subscription/anthropic/setup-token"
  ) {
    const body = await readJsonBody<{ token: string }>(req, res);
    if (!body) return true;
    if (!body.token || !body.token.startsWith("sk-ant-")) {
      error(res, "Invalid token format — expected sk-ant-oat01-...", 400);
      return true;
    }
    try {
      process.env.ANTHROPIC_API_KEY = body.token.trim();
      if (!state.config.env) state.config.env = {};
      state.config.env.ANTHROPIC_API_KEY = body.token.trim();
      ctx.saveConfig(state.config);
      json(res, { success: true });
    } catch (err) {
      logger.error(
        `[api] Failed to save setup token: ${err instanceof Error ? err.stack : err}`,
      );
      error(res, "Failed to save setup token", 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/subscription/openai/start") {
    try {
      const { startCodexLogin } = await loadSubscriptionAuth();
      if (state._codexFlow) {
        try {
          state._codexFlow.close();
        } catch (err) {
          logger.debug(
            `[api] OAuth flow cleanup failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      clearTimeout(state._codexFlowTimer);

      const flow = await startCodexLogin();
      state._codexFlow = flow;
      state._codexFlowTimer = setTimeout(
        () => {
          try {
            flow.close();
          } catch (err) {
            logger.debug(
              `[api] OAuth flow cleanup failed: ${err instanceof Error ? err.message : err}`,
            );
          }
          delete state._codexFlow;
          delete state._codexFlowTimer;
        },
        10 * 60 * 1000,
      );
      json(res, {
        authUrl: flow.authUrl,
        state: flow.state,
        instructions:
          "Open the URL in your browser. After login, if auto-redirect doesn't work, paste the full redirect URL.",
      });
    } catch (err) {
      logger.error(
        `[api] Failed to start OpenAI login: ${err instanceof Error ? err.stack : err}`,
      );
      error(res, "Failed to start OpenAI login", 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/subscription/openai/exchange") {
    const body = await readJsonBody<{
      code?: string;
      waitForCallback?: boolean;
    }>(req, res);
    if (!body) return true;
    try {
      const { saveCredentials, applySubscriptionCredentials } =
        await loadSubscriptionAuth();
      const flow = state._codexFlow;

      if (!flow) {
        error(res, "No active flow — call /start first", 400);
        return true;
      }

      if (body.code) {
        flow.submitCode(body.code);
      } else if (!body.waitForCallback) {
        error(res, "Provide either code or set waitForCallback: true", 400);
        return true;
      }

      let credentials: OAuthCredentials;
      try {
        credentials = await flow.credentials;
      } catch (err) {
        try {
          flow.close();
        } catch (closeErr) {
          logger.debug(
            `[api] OAuth flow cleanup failed: ${closeErr instanceof Error ? closeErr.message : closeErr}`,
          );
        }
        delete state._codexFlow;
        clearTimeout(state._codexFlowTimer);
        delete state._codexFlowTimer;
        logger.error(
          `[api] OpenAI exchange failed: ${err instanceof Error ? err.stack : err}`,
        );
        error(res, "OpenAI exchange failed", 500);
        return true;
      }
      saveCredentials("openai-codex", credentials);
      await applySubscriptionCredentials(state.config);
      flow.close();
      delete state._codexFlow;
      clearTimeout(state._codexFlowTimer);
      delete state._codexFlowTimer;
      json(res, {
        success: true,
        expiresAt: credentials.expires,
      });
    } catch (err) {
      logger.error(
        `[api] OpenAI exchange failed: ${err instanceof Error ? err.stack : err}`,
      );
      error(res, "OpenAI exchange failed", 500);
    }
    return true;
  }

  if (method === "DELETE" && pathname.startsWith("/api/subscription/")) {
    const provider = pathname.split("/").pop();
    if (provider === "anthropic-subscription" || provider === "openai-codex") {
      try {
        const { deleteCredentials } = await loadSubscriptionAuth();
        deleteCredentials(provider);
        json(res, { success: true });
      } catch (err) {
        logger.error(
          `[api] Failed to delete credentials: ${err instanceof Error ? err.stack : err}`,
        );
        error(res, "Failed to delete credentials", 500);
      }
    } else {
      error(res, `Unknown provider: ${provider}`, 400);
    }
    return true;
  }

  return false;
}
