/**
 * Mounts the `/api/subscription/*` routes that manage LLM-provider subscription
 * logins (Anthropic OAuth plus setup-token, OpenAI/Codex OAuth): a status
 * endpoint that joins live auth rows with each account's `LinkedAccountConfig`,
 * the OAuth start/exchange endpoints, and a DELETE that revokes a provider and
 * unwires it from config defaults and service routing. Credentials persist
 * through the lazily-loaded `@elizaos/auth` module and mutate `ElizaConfig`; the
 * Anthropic setup token is stored for task-agent CLI use only, never applied to
 * `process.env` (TOS restriction).
 */
import crypto from "node:crypto";
import { loadAccount, saveAccount } from "@elizaos/auth/account-storage";
import type { AnthropicFlow } from "@elizaos/auth/anthropic";
import type { CodexFlow } from "@elizaos/auth/openai-codex";
import {
  isSubscriptionProvider,
  type OAuthCredentials,
  type SubscriptionProvider,
} from "@elizaos/auth/types";
import { logger, type RouteRequestContext } from "@elizaos/core";
import type {
  LinkedAccountConfig,
  LinkedAccountHealth,
  LinkedAccountUsage,
} from "@elizaos/shared";
import {
  PostSubscriptionAnthropicExchangeRequestSchema,
  PostSubscriptionAnthropicSetupTokenRequestSchema,
  PostSubscriptionOpenAIExchangeRequestSchema,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/types.eliza.ts";
import { getAgentHostBridge } from "../runtime/host-bridge.ts";

type AuthModule = typeof import("@elizaos/auth");

export type SubscriptionAuthApi = Pick<
  AuthModule,
  | "getSubscriptionStatus"
  | "exchangeAnthropicAuthorizationCode"
  | "fetchAnthropicOAuthProfile"
  | "startAnthropicLogin"
  | "startCodexLogin"
  | "submitProviderFlowCode"
  | "saveCredentials"
  | "applySubscriptionCredentials"
  | "deleteCredentials"
  | "deleteProviderCredentials"
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

// Runtime reloads replace the request state while an OAuth browser is open.
// Codex's PKCE verifier cannot be reconstructed from its localhost callback,
// so retain the live flow in this process-level module across runtime swaps.
let activeCodexFlow: CodexFlow | undefined;
let activeCodexFlowTimer: ReturnType<typeof setTimeout> | undefined;

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
    const rawAxe = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawAxe === null) return true;
    const parsedAxe =
      PostSubscriptionAnthropicExchangeRequestSchema.safeParse(rawAxe);
    if (!parsedAxe.success) {
      error(
        res,
        parsedAxe.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedAxe.data;
    try {
      const {
        saveCredentials,
        applySubscriptionCredentials,
        exchangeAnthropicAuthorizationCode,
        fetchAnthropicOAuthProfile,
      } = await loadSubscriptionAuth();
      const flow = state._anthropicFlow;
      const credentials = flow
        ? (flow.submitCode(body.code), await flow.credentials)
        : await exchangeAnthropicAuthorizationCode(body.code);
      const profile = await fetchAnthropicOAuthProfile(credentials.access);
      const accountId = profile.accountId ?? crypto.randomUUID();
      saveCredentials("anthropic-subscription", credentials, accountId);
      const stored = loadAccount("anthropic-subscription", accountId);
      if (stored && profile.email) {
        saveAccount({
          ...stored,
          label: profile.email,
          email: profile.email,
          ...(profile.organizationId
            ? { organizationId: profile.organizationId }
            : {}),
        });
      }
      const pool = getAgentHostBridge().getDefaultAccountPool() as {
        list(providerId?: string): LinkedAccountConfig[];
        upsert(account: LinkedAccountConfig): Promise<void>;
      };
      const existing = pool.list("anthropic-subscription");
      const prior = existing.find((account) => account.id === accountId);
      const priority =
        prior?.priority ??
        (existing.length === 0
          ? 0
          : Math.max(...existing.map((account) => account.priority)) + 1);
      await pool.upsert({
        id: accountId,
        providerId: "anthropic-subscription",
        label:
          profile.email ??
          prior?.label ??
          `Claude account ${existing.length + 1}`,
        source: "oauth",
        enabled: prior?.enabled ?? true,
        priority,
        createdAt: prior?.createdAt ?? Date.now(),
        health: "ok",
        ...(profile.email ? { email: profile.email } : {}),
        ...(profile.organizationId
          ? { organizationId: profile.organizationId }
          : {}),
      });
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
    const rawTok = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawTok === null) return true;
    const parsedTok =
      PostSubscriptionAnthropicSetupTokenRequestSchema.safeParse(rawTok);
    if (!parsedTok.success) {
      error(
        res,
        parsedTok.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const trimmedToken = parsedTok.data.token;
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
      const previousFlow = state._codexFlow ?? activeCodexFlow;
      if (previousFlow) {
        try {
          previousFlow.close();
        } catch (err) {
          logger.debug(
            `[api] OAuth flow cleanup failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      clearTimeout(state._codexFlowTimer);
      clearTimeout(activeCodexFlowTimer);

      const flow = await startCodexLogin();
      state._codexFlow = flow;
      activeCodexFlow = flow;
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
          if (activeCodexFlow === flow) activeCodexFlow = undefined;
          activeCodexFlowTimer = undefined;
        },
        10 * 60 * 1000,
      );
      activeCodexFlowTimer = state._codexFlowTimer;
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
    const rawOaeb = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawOaeb === null) return true;
    const parsedOaeb =
      PostSubscriptionOpenAIExchangeRequestSchema.safeParse(rawOaeb);
    if (!parsedOaeb.success) {
      error(
        res,
        parsedOaeb.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedOaeb.data;
    try {
      const {
        saveCredentials,
        applySubscriptionCredentials,
        submitProviderFlowCode,
      } = await loadSubscriptionAuth();
      const flow = state._codexFlow ?? activeCodexFlow;

      if (!flow) {
        if (!body.code) {
          error(res, "No active flow — call /start first", 400);
          return true;
        }
        const accountFlow = submitProviderFlowCode("openai-codex", body.code);
        if (!accountFlow) {
          error(res, "No matching active flow — start login again", 400);
          return true;
        }
        try {
          const { account } = await accountFlow.completion;
          json(res, {
            success: true,
            expiresAt: account.credentials.expires,
          });
        } catch (err) {
          logger.error(
            `[api] OpenAI account-flow exchange failed: ${String(err)}`,
          );
          error(res, "OpenAI exchange failed", 500);
        }
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
        activeCodexFlow = undefined;
        clearTimeout(activeCodexFlowTimer);
        activeCodexFlowTimer = undefined;
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
      activeCodexFlow = undefined;
      clearTimeout(activeCodexFlowTimer);
      activeCodexFlowTimer = undefined;
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
    if (isSubscriptionProvider(provider)) {
      try {
        const { deleteProviderCredentials } = await loadSubscriptionAuth();
        deleteProviderCredentials(provider);

        if (provider === "anthropic-subscription" && state.config.env) {
          delete (state.config.env as Record<string, unknown>)
            .__anthropicSubscriptionToken;
        }
        const deletedProviderId =
          subscriptionSelectionIdForStoredProvider(provider);
        const defaults = state.config.agents?.defaults;
        const defaultSubscription = defaults?.subscriptionProvider;
        if (
          defaults &&
          (defaultSubscription === provider ||
            defaultSubscription === deletedProviderId)
        ) {
          delete defaults.subscriptionProvider;
        }
        const llmBackend = state.config.serviceRouting?.llmText?.backend;
        if (
          (llmBackend === deletedProviderId || llmBackend === provider) &&
          state.config.serviceRouting
        ) {
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

function subscriptionSelectionIdForStoredProvider(
  provider: SubscriptionProvider,
): string {
  switch (provider) {
    case "openai-codex":
      return "openai-subscription";
    case "gemini-cli":
      return "gemini-subscription";
    case "zai-coding":
      return "zai-coding-subscription";
    case "kimi-coding":
      return "kimi-coding-subscription";
    case "deepseek-coding":
      return "deepseek-coding-subscription";
    case "anthropic-subscription":
      return "anthropic-subscription";
  }
}

/**
 * Read rich `LinkedAccountConfig` rows from the AccountPool singleton.
 * The pool is the single source of truth — it joins on-disk credential
 * records with the metadata overlay file. Read from the host account pool
 * injected via the agent host bridge — no `@elizaos/app-core` import.
 */
async function readRichLinkedAccountsFromPool(): Promise<
  Record<string, LinkedAccountConfig>
> {
  try {
    // Host account pool injected downward via the agent host bridge (see
    // ../runtime/host-bridge.ts) — agent never imports `@elizaos/app-core`.
    const pool = getAgentHostBridge().getDefaultAccountPool() as {
      list(): LinkedAccountConfig[];
    };
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
