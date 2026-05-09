import { RouteRequestContext } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type {
  LinkedAccountConfig, LinkedAccountHealth, LinkedAccountUsage } from "@elizaos/shared";
import type { AnthropicFlow } from "../auth/anthropic.js";
import type { CodexFlow } from "../auth/openai-codex.js";
import type { OAuthCredentials } from "../auth/types.js";
import type { ElizaConfig } from "../config/types.eliza.js";

type AuthModule = typeof import("../auth/index.js");

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
      const baseRows = getSubscriptionStatus();
      // Join each per-account row with its rich LinkedAccountConfig
      // entry from `eliza.json` (priority, enabled, health, usage).
      // CLI / setup-token / Claude Code rows have synthetic accountIds
      // and no config-level row — they pass through unchanged so the
      // UI's existing `find(s => s.provider === ...)` keeps working.
      const linkedAccounts = await readRichLinkedAccountsFromPool();
      const rows = baseRows.map((row) => {
        const linked =
          linkedAccounts[`${row.provider}:${row.accountId}`] ??
          linkedAccounts[row.accountId];
        if (!linked || linked.providerId !== row.provider) return row;
        const enriched: typeof row & {
          priority: number;
          enabled: boolean;
          health: LinkedAccountHealth;
          usage?: LinkedAccountUsage;
        } = {
          ...row,
          priority: linked.priority,
          enabled: linked.enabled,
          health: linked.health,
          ...(linked.usage ? { usage: linked.usage } : {}),
        };
        return enriched;
      });
      json(res, { providers: rows });
    } catch (err) {
      logger.error(`[api] Failed to get subscription status: ${String(err)}`);
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
      logger.error(`[api] Failed to start Anthropic login: ${String(err)}`);
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
      logger.error(`[api] Anthropic exchange failed: ${String(err)}`);
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
    const trimmedToken = body.token?.trim();
    if (!trimmedToken?.startsWith("sk-ant-")) {
      error(res, "Invalid token format — expected sk-ant-oat01-...", 400);
      return true;
    }
    try {
      // Store the setup token in config for task-agent discovery but do
      // NOT inject it into process.env.ANTHROPIC_API_KEY.  Anthropic's
      // TOS only permits subscription tokens through the Claude Code CLI.
      // The task-agent orchestrator spawns `claude` CLI subprocesses
      // which use the token legitimately.
      if (!state.config.env) state.config.env = {};
      (
        state.config.env as Record<string, unknown>
      ).__anthropicSubscriptionToken = trimmedToken;
      ctx.saveConfig(state.config);
      logger.info(
        "[api] Saved Anthropic setup token for task agents (not applied to runtime — TOS restriction)",
      );
      json(res, { success: true });
    } catch (err) {
      logger.error(`[api] Failed to save setup token: ${String(err)}`);
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
      logger.error(`[api] Failed to start OpenAI login: ${String(err)}`);
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
        logger.error(`[api] OpenAI exchange failed: ${String(err)}`);
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
      logger.error(`[api] OpenAI exchange failed: ${String(err)}`);
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

        if (provider === "anthropic-subscription" && state.config.env) {
          delete (state.config.env as Record<string, unknown>)
            .__anthropicSubscriptionToken;
        }
        if (state.config.agents?.defaults?.subscriptionProvider === provider) {
          delete state.config.agents.defaults.subscriptionProvider;
        }
        const llmBackend = state.config.serviceRouting?.llmText?.backend;
        const deletedProviderId =
          provider === "openai-codex" ? "openai-subscription" : provider;
        if (llmBackend === deletedProviderId && state.config.serviceRouting) {
          delete state.config.serviceRouting.llmText;
          if (Object.keys(state.config.serviceRouting).length === 0) {
            delete state.config.serviceRouting;
          }
        }
        ctx.saveConfig(state.config);
        json(res, { success: true });
      } catch (err) {
        logger.error(`[api] Failed to delete credentials: ${String(err)}`);
        error(res, "Failed to delete credentials", 500);
      }
    } else {
      error(res, `Unknown provider: ${provider}`, 400);
    }
    return true;
  }

  return false;
}

/**
 * Read rich `LinkedAccountConfig` rows from the AccountPool singleton.
 * The pool is the single source of truth — it joins on-disk credential
 * records with the metadata overlay file. Loaded via dynamic import
 * because `@elizaos/app-core` depends on `@elizaos/agent`, not the
 * other way around.
 */
async function readRichLinkedAccountsFromPool(): Promise<
  Record<string, LinkedAccountConfig>
> {
  try {
    const moduleId = "@elizaos/app-core/account-pool";
    const mod = (await import(/* @vite-ignore */ moduleId)) as {
      getDefaultAccountPool: () => {
        list(): LinkedAccountConfig[];
      };
    };
    const pool = mod.getDefaultAccountPool();
    const out: Record<string, LinkedAccountConfig> = {};
    for (const account of pool.list()) {
      out[`${account.providerId}:${account.id}`] = account;
      if (!(account.id in out)) {
        out[account.id] = account;
      }
    }
    return out;
  } catch (err) {
    logger.debug(`[subscription] account pool unavailable: ${String(err)}`);
    return {};
  }
}
