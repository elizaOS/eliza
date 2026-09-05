/**
 * Unit and integration tests for `/api/subscription/*` route contracts:
 * status enrichment against the host account pool, Anthropic and OpenAI OAuth
 * flow initiation, Anthropic setup-token persistence for task agents, legacy
 * OpenAI exchange bridges, and subscription provider revocation with config
 * teardown.
 */
import type http from "node:http";
import { emptyAccountPoolBrokerSnapshot } from "@elizaos/core";
import type { AccountCredentialRecord } from "@elizaos/auth/account-storage";
import type { AnthropicFlow } from "@elizaos/auth/anthropic";
import type { OAuthFlowHandle } from "@elizaos/auth/oauth-flow";
import type { CodexFlow } from "@elizaos/auth/openai-codex";
import type { LinkedAccountConfig } from "@elizaos/shared";
import type { Vault } from "@elizaos/vault";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/types.eliza.ts";
import {
  _resetAgentHostBridge,
  type AgentHostBridge,
  setAgentHostBridge,
} from "../runtime/host-bridge.ts";
import {
  handleSubscriptionRoutes,
  type SubscriptionAuthApi,
  type SubscriptionRouteContext,
  type SubscriptionRouteState,
} from "./subscription-routes.ts";

const CALLBACK =
  "http://localhost:1455/auth/callback?code=codex-code&state=flow-state";

function account(expires = 123_456): AccountCredentialRecord {
  return {
    id: "account-1",
    providerId: "openai-codex",
    label: "Personal",
    source: "oauth",
    credentials: {
      access: "access-token",
      refresh: "refresh-token",
      expires,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function accountFlow(
  completion: OAuthFlowHandle["completion"],
): OAuthFlowHandle {
  return {
    sessionId: "session-1",
    authUrl: "https://auth.openai.com/authorize?state=flow-state",
    needsCodeSubmission: true,
    completion,
    submitCode: vi.fn(),
    cancel: vi.fn(),
  };
}

function createContext(args: {
  method: string;
  pathname: string;
  body?: unknown;
  state?: Partial<SubscriptionRouteState>;
  authApi?: Partial<SubscriptionAuthApi>;
  saveConfig?: ReturnType<typeof vi.fn>;
  json?: ReturnType<typeof vi.fn>;
  error?: ReturnType<typeof vi.fn>;
}): {
  ctx: SubscriptionRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  saveConfig: ReturnType<typeof vi.fn>;
} {
  const json = args.json ?? vi.fn();
  const error = args.error ?? vi.fn();
  const saveConfig = args.saveConfig ?? vi.fn();
  const state: SubscriptionRouteState = {
    config: {} as ElizaConfig,
    ...args.state,
  };

  const authApi = {
    getSubscriptionStatus: vi.fn().mockResolvedValue([]),
    exchangeAnthropicAuthorizationCode: vi.fn(),
    fetchAnthropicOAuthProfile: vi.fn(),
    startAnthropicLogin: vi.fn(),
    startCodexLogin: vi.fn(),
    submitProviderFlowCode: vi.fn(),
    saveCredentials: vi.fn(),
    applySubscriptionCredentials: vi.fn().mockResolvedValue(undefined),
    deleteCredentials: vi.fn(),
    deleteProviderCredentials: vi.fn(),
    ...args.authApi,
  } as unknown as SubscriptionAuthApi;

  const ctx: SubscriptionRouteContext = {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: args.method,
    pathname: args.pathname,
    url: new URL(`http://localhost${args.pathname}`),
    state,
    saveConfig,
    readJsonBody: vi.fn().mockResolvedValue(args.body ?? {}),
    json,
    error,
    loadSubscriptionAuth: vi.fn().mockResolvedValue(authApi),
  } as unknown as SubscriptionRouteContext;

  return { ctx, json, error, saveConfig };
}

afterEach(() => {
  _resetAgentHostBridge();
  vi.restoreAllMocks();
});

describe("handleSubscriptionRoutes route matching", () => {
  it("ignores non-subscription paths and returns false", async () => {
    const { ctx } = createContext({
      method: "GET",
      pathname: "/api/other/endpoint",
    });
    const handled = await handleSubscriptionRoutes(ctx);
    expect(handled).toBe(false);
  });
});

describe("GET /api/subscription/status", () => {
  it("enriches subscription provider rows with host account pool details", async () => {
    const baseRows = [
      {
        provider: "anthropic-subscription",
        accountId: "acct-1",
        name: "Claude Pro",
        authenticated: true,
        expires: 100_000,
      },
      {
        provider: "openai-codex",
        accountId: "cli-token",
        name: "Codex CLI",
        authenticated: true,
      },
    ];

    const linkedPoolAccounts: LinkedAccountConfig[] = [
      {
        id: "acct-1",
        providerId: "anthropic-subscription",
        label: "My Claude",
        source: "oauth",
        enabled: true,
        priority: 1,
        health: "ok",
        createdAt: 1000,
        usage: { refreshedAt: 1000, sessionPct: 50 },
      },
    ];

    const hostBridge: AgentHostBridge = {
      captureWalletEnvBootBaseline: () => undefined,
      hydrateWalletKeysFromNodePlatformSecureStore: () => undefined,
      runVaultBootstrap: () => Promise.resolve({ migrated: 0, failed: [] }),
      sharedVault: () => ({}) as unknown as Vault,
      getDefaultAccountPool: () => ({
        list: () => linkedPoolAccounts,
      }),
      getAccountPoolBrokerSnapshot: emptyAccountPoolBrokerSnapshot,
      applyAccountPoolApiCredentials: () => undefined,
      startAccountPoolKeepAlive: () => undefined,
      getBuildVariant: () => "direct",
      isStoreBuild: () => false,
    };
    setAgentHostBridge(hostBridge);

    const { ctx, json, error } = createContext({
      method: "GET",
      pathname: "/api/subscription/status",
      authApi: {
        getSubscriptionStatus: vi.fn().mockResolvedValue(baseRows),
      },
    });

    const handled = await handleSubscriptionRoutes(ctx);
    expect(handled).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.anything(), {
      providers: [
        {
          provider: "anthropic-subscription",
          accountId: "acct-1",
          name: "Claude Pro",
          authenticated: true,
          expires: 100_000,
          priority: 1,
          enabled: true,
          health: "ok",
          usage: { refreshedAt: 1000, sessionPct: 50 },
        },
        {
          provider: "openai-codex",
          accountId: "cli-token",
          name: "Codex CLI",
          authenticated: true,
        },
      ],
    });
  });

  it("translates getSubscriptionStatus failure into an HTTP 500 error", async () => {
    const { ctx, json, error } = createContext({
      method: "GET",
      pathname: "/api/subscription/status",
      authApi: {
        getSubscriptionStatus: vi
          .fn()
          .mockRejectedValue(new Error("auth DB unavailable")),
      },
    });

    const handled = await handleSubscriptionRoutes(ctx);
    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      "Failed to get subscription status",
      500,
    );
    expect(json).not.toHaveBeenCalled();
  });
});

describe("POST /api/subscription/anthropic/start", () => {
  it("starts the Anthropic login flow and sets the active flow state", async () => {
    const fakeFlow: AnthropicFlow = {
      authUrl: "https://anthropic.test/oauth",
      submitCode: vi.fn(),
      credentials: Promise.resolve({
        access: "token",
        refresh: "refresh-token",
        expires: 100_000,
      }),
    };
    const { ctx, json, error } = createContext({
      method: "POST",
      pathname: "/api/subscription/anthropic/start",
      authApi: {
        startAnthropicLogin: vi.fn().mockResolvedValue(fakeFlow),
      },
    });

    const handled = await handleSubscriptionRoutes(ctx);
    expect(handled).toBe(true);
    expect(ctx.state._anthropicFlow).toBe(fakeFlow);
    expect(json).toHaveBeenCalledWith(expect.anything(), {
      authUrl: "https://anthropic.test/oauth",
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("translates Anthropic login start failure into HTTP 500", async () => {
    const { ctx, json, error } = createContext({
      method: "POST",
      pathname: "/api/subscription/anthropic/start",
      authApi: {
        startAnthropicLogin: vi
          .fn()
          .mockRejectedValue(new Error("network error")),
      },
    });

    const handled = await handleSubscriptionRoutes(ctx);
    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      "Failed to start Anthropic login",
      500,
    );
    expect(json).not.toHaveBeenCalled();
  });
});

describe("POST /api/subscription/anthropic/setup-token", () => {
  it("stores the setup token in config.env for task-agent discovery and saves config", async () => {
    const { ctx, json, error, saveConfig } = createContext({
      method: "POST",
      pathname: "/api/subscription/anthropic/setup-token",
      body: { token: "sk-ant-setup-token-value" },
      state: { config: { env: {} } as ElizaConfig },
    });

    const handled = await handleSubscriptionRoutes(ctx);
    expect(handled).toBe(true);
    expect(
      (ctx.state.config.env as Record<string, unknown>)
        ?.__anthropicSubscriptionToken,
    ).toBe("sk-ant-setup-token-value");
    expect(saveConfig).toHaveBeenCalledWith(ctx.state.config);
    expect(json).toHaveBeenCalledWith(expect.anything(), { success: true });
    expect(error).not.toHaveBeenCalled();
  });

  it("rejects an invalid setup token payload with HTTP 400", async () => {
    const { ctx, json, error } = createContext({
      method: "POST",
      pathname: "/api/subscription/anthropic/setup-token",
      body: { token: "" },
    });

    const handled = await handleSubscriptionRoutes(ctx);
    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/subscription/:provider", () => {
  it("deletes provider credentials and removes defaults from config", async () => {
    const deleteProviderCredentials = vi.fn();
    const { ctx, json, error, saveConfig } = createContext({
      method: "DELETE",
      pathname: "/api/subscription/anthropic-subscription",
      state: {
        config: {
          env: { __anthropicSubscriptionToken: "stale-tok" },
          agents: {
            defaults: { subscriptionProvider: "anthropic-subscription" },
          },
          serviceRouting: {
            llmText: {
              backend: "anthropic-subscription",
            } as unknown as NonNullable<
              ElizaConfig["serviceRouting"]
            >["llmText"],
          },
        } as ElizaConfig,
      },
      authApi: { deleteProviderCredentials },
    });

    const handled = await handleSubscriptionRoutes(ctx);
    expect(handled).toBe(true);
    expect(deleteProviderCredentials).toHaveBeenCalledWith(
      "anthropic-subscription",
      expect.anything(),
    );
    expect(
      (ctx.state.config.env as Record<string, unknown>)
        .__anthropicSubscriptionToken,
    ).toBeUndefined();
    expect(
      ctx.state.config.agents?.defaults?.subscriptionProvider,
    ).toBeUndefined();
    expect(ctx.state.config.serviceRouting).toBeUndefined();
    expect(saveConfig).toHaveBeenCalledWith(ctx.state.config);
    expect(json).toHaveBeenCalledWith(expect.anything(), { success: true });
    expect(error).not.toHaveBeenCalled();
  });

  it("rejects unknown subscription providers with HTTP 400", async () => {
    const { ctx, json, error } = createContext({
      method: "DELETE",
      pathname: "/api/subscription/non-existent-provider",
    });

    const handled = await handleSubscriptionRoutes(ctx);
    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      "Unknown provider: non-existent-provider",
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("translates credential deletion errors into HTTP 500", async () => {
    const { ctx, json, error } = createContext({
      method: "DELETE",
      pathname: "/api/subscription/openai-codex",
      authApi: {
        deleteProviderCredentials: vi.fn().mockImplementation(() => {
          throw new Error("I/O failure");
        }),
      },
    });

    const handled = await handleSubscriptionRoutes(ctx);
    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      "Failed to delete credentials",
      500,
    );
    expect(json).not.toHaveBeenCalled();
  });
});

describe("subscription OpenAI account-flow bridge", () => {
  it("submits the callback to the matching account flow and awaits persistence", async () => {
    const json = vi.fn();
    const error = vi.fn();
    const flow = accountFlow(Promise.resolve({ account: account() }));
    const submit = vi.fn().mockReturnValue(flow);

    const handled = await handleSubscriptionRoutes(
      createContext({
        method: "POST",
        pathname: "/api/subscription/openai/exchange",
        body: { code: CALLBACK },
        authApi: { submitProviderFlowCode: submit },
        json,
        error,
      }).ctx,
    );

    expect(handled).toBe(true);
    expect(submit).toHaveBeenCalledWith("openai-codex", CALLBACK);
    expect(json).toHaveBeenCalledWith(expect.anything(), {
      success: true,
      expiresAt: 123_456,
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("rejects a callback that cannot be matched to one pending flow", async () => {
    const json = vi.fn();
    const error = vi.fn();

    await handleSubscriptionRoutes(
      createContext({
        method: "POST",
        pathname: "/api/subscription/openai/exchange",
        body: { code: CALLBACK },
        authApi: { submitProviderFlowCode: vi.fn().mockReturnValue(null) },
        json,
        error,
      }).ctx,
    );

    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      "No matching active flow — start login again",
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("translates account-flow exchange failure at the HTTP boundary", async () => {
    const json = vi.fn();
    const error = vi.fn();
    const flow = accountFlow(Promise.reject(new Error("provider rejected")));
    // Catch rejection to avoid unhandled rejection in test runner
    flow.completion.catch(() => {});

    await handleSubscriptionRoutes(
      createContext({
        method: "POST",
        pathname: "/api/subscription/openai/exchange",
        body: { code: CALLBACK },
        authApi: { submitProviderFlowCode: vi.fn().mockReturnValue(flow) },
        json,
        error,
      }).ctx,
    );

    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      "OpenAI exchange failed",
      500,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("exchanges code when an active flow instance is attached to state", async () => {
    const json = vi.fn();
    const error = vi.fn();
    const submitCodeMock = vi.fn();
    const closeMock = vi.fn();
    const saveCredentialsMock = vi.fn();
    const applyCredentialsMock = vi.fn();

    const activeFlow: CodexFlow = {
      authUrl: "https://auth.openai.com/oauth",
      state: "state-xyz",
      submitCode: submitCodeMock,
      close: closeMock,
      credentials: Promise.resolve({
        access: "access-token-123",
        refresh: "refresh-token-123",
        expires: 200_000,
      }),
    };

    const { ctx } = createContext({
      method: "POST",
      pathname: "/api/subscription/openai/exchange",
      body: { code: "http://localhost/cb?code=direct-code" },
      state: { _codexFlow: activeFlow },
      authApi: {
        saveCredentials: saveCredentialsMock,
        applySubscriptionCredentials: applyCredentialsMock,
      },
      json,
      error,
    });

    const handled = await handleSubscriptionRoutes(ctx);
    expect(handled).toBe(true);
    expect(submitCodeMock).toHaveBeenCalledWith(
      "http://localhost/cb?code=direct-code",
    );
    expect(saveCredentialsMock).toHaveBeenCalledWith(
      "openai-codex",
      {
        access: "access-token-123",
        refresh: "refresh-token-123",
        expires: 200_000,
      },
      "default",
      expect.anything(),
    );
    expect(applyCredentialsMock).toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.anything(), {
      success: true,
      expiresAt: 200_000,
    });
    expect(error).not.toHaveBeenCalled();
  });
});
