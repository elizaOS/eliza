/**
 * Covers the first-run HTTP route dispatcher across status refresh and cloud
 * bootstrap, wallet-key disclosure gating and masking, option aggregation,
 * request validation, canonical deployment-routing normalization, full
 * onboarding persistence, runtime synchronization, and persistence failures.
 * The real route handler mutates in-memory config; only its filesystem and
 * provider credential persistence boundaries are replaced with deterministic
 * spies.
 */
import type http from "node:http";
import { type AgentRuntime, ElizaError } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/config.ts", () => ({
  configFileExists: vi.fn(),
  loadElizaConfig: vi.fn(),
}));

vi.mock("./provider-switch-config.ts", () => ({
  applyCanonicalFirstRunConfig: vi.fn(),
  applyFirstRunCredentialPersistence: vi.fn(async () => undefined),
}));

import {
  configFileExists,
  type ElizaConfig,
  loadElizaConfig,
} from "../config/config";
import {
  type FirstRunRouteContext,
  type FirstRunServerState,
  handleFirstRunRoutes,
} from "./first-run-routes";
import {
  applyCanonicalFirstRunConfig,
  applyFirstRunCredentialPersistence,
} from "./provider-switch-config";

const ENV_KEYS = [
  "BLOOIO_API_KEY",
  "BLOOIO_PHONE_NUMBER",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
  "EVM_PRIVATE_KEY",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_TOKEN",
  "SOLANA_PRIVATE_KEY",
  "TEST_FIRST_RUN_RPC_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
] as const;

const originalEnv = new Map(
  ENV_KEYS.map((key) => [key, process.env[key]] as const),
);

function makeState(
  config: ElizaConfig = {} as ElizaConfig,
): FirstRunServerState {
  return {
    config,
    runtime: null,
    agentName: "Before",
    adminEntityId: null,
    chatUserId: null,
    chatConnectionReady: { stale: true },
    chatConnectionPromise: Promise.resolve(),
  };
}

function makeContext(
  method: string,
  pathname: string,
  options: {
    state?: FirstRunServerState;
    body?: Record<string, unknown> | null;
    overrides?: Partial<FirstRunRouteContext>;
  } = {},
) {
  const json = vi.fn();
  const error = vi.fn();
  const saveElizaConfig = vi.fn();
  const provisionWalletKeysInEnvAndConfig = vi.fn(
    (config: ElizaConfig, environment: NodeJS.ProcessEnv = process.env) => {
      const evmPrivateKey = environment.EVM_PRIVATE_KEY ?? "evm-secret-1234";
      const solanaPrivateKey =
        environment.SOLANA_PRIVATE_KEY ?? "solana-secret-5678";
      environment.EVM_PRIVATE_KEY = evmPrivateKey;
      environment.SOLANA_PRIVATE_KEY = solanaPrivateKey;
      config.env = {
        ...(config.env ?? {}),
        EVM_PRIVATE_KEY: evmPrivateKey,
        SOLANA_PRIVATE_KEY: solanaPrivateKey,
      };
      return {
        ok: true as const,
        generated: true,
        evmPrivateKey,
        evmAddress: "0x1234",
        solanaPrivateKey,
        solanaAddress: "So111",
      };
    },
  );
  const applyFirstRunVoicePreset = vi.fn();
  const req = {
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const state = options.state ?? makeState();
  const context: FirstRunRouteContext = {
    req,
    res,
    method,
    pathname,
    url: new URL(`http://127.0.0.1${pathname}`),
    state,
    authorization: { ok: true, role: "OWNER", principal: "test-owner" },
    json,
    error,
    readJsonBody: vi.fn(
      async () => options.body ?? null,
    ) as unknown as FirstRunRouteContext["readJsonBody"],
    isCloudProvisionedContainer: () => false,
    hasPersistedFirstRunState: (config) =>
      config.meta?.firstRunComplete === true,
    provisionWalletKeysInEnvAndConfig,
    walletVault: null,
    pickRandomNames: () => ["Ada", "Grace"],
    getStylePresets: () => [{ id: "concise" }],
    getProviderOptions: () => [{ id: "openai" }],
    getCloudProviderOptions: () => [{ id: "elizacloud" }],
    getModelOptions: () => ({ openai: ["gpt"] }),
    getInventoryProviderOptions: () => [
      {
        id: "ethereum",
        rpcProviders: [{ id: "test-rpc", envKey: "TEST_FIRST_RUN_RPC_KEY" }],
      },
    ],
    resolveConfiguredCharacterLanguage: () => "en",
    normalizeCharacterLanguage: (language) => language ?? "en",
    readUiLanguageHeader: () => null,
    applyFirstRunVoicePreset,
    saveElizaConfig,
    commitElizaConfig: vi.fn((config) => {
      try {
        (options.overrides?.saveElizaConfig ?? saveElizaConfig)(config);
        return { status: "published" as const };
      } catch (cause) {
        return { status: "not-published" as const, cause };
      }
    }),
    ...options.overrides,
  };

  return {
    context,
    state,
    json,
    error,
    saveElizaConfig,
    provisionWalletKeysInEnvAndConfig,
    applyFirstRunVoicePreset,
  };
}

beforeEach(() => {
  vi.mocked(configFileExists).mockReset().mockReturnValue(false);
  vi.mocked(loadElizaConfig)
    .mockReset()
    .mockImplementation(() => {
      throw new Error("no persisted config");
    });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("handleFirstRunRoutes — dispatch and status", () => {
  it("declines unrelated paths and method mismatches", async () => {
    const unrelated = makeContext("GET", "/api/health");
    const wrongMethod = makeContext("POST", "/api/first-run/options");

    await expect(handleFirstRunRoutes(unrelated.context)).resolves.toBe(false);
    await expect(handleFirstRunRoutes(wrongMethod.context)).resolves.toBe(
      false,
    );
    expect(unrelated.json).not.toHaveBeenCalled();
    expect(wrongMethod.json).not.toHaveBeenCalled();
  });

  it("reports incomplete without a config file", async () => {
    const { context, json } = makeContext("GET", "/api/first-run/status");

    await expect(handleFirstRunRoutes(context)).resolves.toBe(true);

    expect(json).toHaveBeenCalledWith(context.res, { complete: false });
    expect(loadElizaConfig).not.toHaveBeenCalled();
  });

  it("refreshes stale in-memory state from a completed persisted config", async () => {
    const persisted = {
      meta: { firstRunComplete: true },
    } as ElizaConfig;
    vi.mocked(configFileExists).mockReturnValue(true);
    vi.mocked(loadElizaConfig).mockReturnValue(persisted);
    const state = makeState({ meta: {} } as ElizaConfig);
    const { context, json } = makeContext("GET", "/api/first-run/status", {
      state,
    });

    await expect(handleFirstRunRoutes(context)).resolves.toBe(true);

    expect(state.config).toBe(persisted);
    expect(json).toHaveBeenCalledWith(context.res, { complete: true });
  });

  it("bootstraps the first cloud character preset before reporting complete", async () => {
    const cloudConfig = {} as ElizaConfig;
    vi.mocked(loadElizaConfig).mockReturnValue(cloudConfig);
    const { context, json, saveElizaConfig, applyFirstRunVoicePreset } =
      makeContext("GET", "/api/first-run/status", {
        overrides: {
          isCloudProvisionedContainer: () => true,
          getStylePresets: () => [
            {
              id: "default",
              name: "Eliza",
              avatarIndex: 4,
              bio: ["Helpful"],
              system: "Be concise",
            },
          ],
        },
      });

    await expect(handleFirstRunRoutes(context)).resolves.toBe(true);

    expect(cloudConfig.ui).toEqual(
      expect.objectContaining({
        presetId: "default",
        avatarIndex: 4,
        assistant: { name: "Eliza" },
      }),
    );
    expect(cloudConfig.serviceRouting).toEqual({
      llmText: { backend: "elizacloud", transport: "cloud-proxy" },
      tts: { backend: "elizacloud", transport: "cloud-proxy" },
    });
    expect(cloudConfig.agents?.list?.[0]).toEqual(
      expect.objectContaining({
        id: "main",
        name: "Eliza",
        bio: ["Helpful"],
        system: "Be concise",
      }),
    );
    expect(applyFirstRunVoicePreset).toHaveBeenCalledWith(
      cloudConfig,
      { presetId: "default", avatarIndex: 4 },
      "en",
    );
    expect(saveElizaConfig).toHaveBeenCalledWith(cloudConfig);
    expect(json).toHaveBeenCalledWith(context.res, {
      complete: true,
      cloudProvisioned: true,
    });
  });
});

describe("handleFirstRunRoutes — wallet keys and options", () => {
  it("refuses wallet-key disclosure after first-run completes", async () => {
    const state = makeState({
      meta: { firstRunComplete: true },
    } as ElizaConfig);
    const { context, error, provisionWalletKeysInEnvAndConfig } = makeContext(
      "GET",
      "/api/wallet/keys",
      { state },
    );

    await expect(handleFirstRunRoutes(context)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      context.res,
      "First-run setup is already complete",
      409,
    );
    expect(provisionWalletKeysInEnvAndConfig).not.toHaveBeenCalled();
  });

  it("fails closed and leaves state/env unchanged when wallet persistence fails", async () => {
    process.env.EVM_PRIVATE_KEY = "evm-secret-1234";
    process.env.SOLANA_PRIVATE_KEY = "solana-secret-5678";
    const failingSave = vi.fn(() => {
      throw new Error("disk unavailable");
    });
    const state = makeState({ meta: {}, retained: true } as ElizaConfig);
    const beforeState = structuredClone(state.config);
    const { context, json, error, provisionWalletKeysInEnvAndConfig } =
      makeContext("GET", "/api/wallet/keys", {
        state,
        overrides: {
          saveElizaConfig: failingSave,
        },
      });

    await expect(handleFirstRunRoutes(context)).resolves.toBe(true);

    expect(provisionWalletKeysInEnvAndConfig).toHaveBeenCalledWith(
      expect.not.objectContaining({ retained: undefined }),
      expect.any(Object),
    );
    expect(failingSave).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      context.res,
      "Wallet key persistence is unavailable",
      503,
    );
    expect(json).not.toHaveBeenCalled();
    expect(state.config).toEqual(beforeState);
    expect(process.env.EVM_PRIVATE_KEY).toBe("evm-secret-1234");
    expect(process.env.SOLANA_PRIVATE_KEY).toBe("solana-secret-5678");
  });

  it("returns complete masked keys and nonblank derived addresses", async () => {
    const { context, json } = makeContext("GET", "/api/wallet/keys");

    await expect(handleFirstRunRoutes(context)).resolves.toBe(true);

    expect(json).toHaveBeenCalledWith(context.res, {
      evmPrivateKey: "****1234",
      evmAddress: "0x1234",
      solanaPrivateKey: "****5678",
      solanaAddress: "So111",
    });
  });

  it("rejects typed wallet generation failures instead of fabricating empty fields", async () => {
    const { context, error, json } = makeContext("GET", "/api/wallet/keys", {
      overrides: {
        provisionWalletKeysInEnvAndConfig: () => ({
          ok: false,
          code: "wallet_key_generation_failed",
        }),
      },
    });

    await expect(handleFirstRunRoutes(context)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      context.res,
      "Wallet key generation is unavailable",
      503,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("aggregates first-run options and trims the OAuth availability signal", async () => {
    process.env.GITHUB_OAUTH_CLIENT_ID = "  client-id  ";
    const { context, json } = makeContext("GET", "/api/first-run/options");

    await expect(handleFirstRunRoutes(context)).resolves.toBe(true);

    expect(json).toHaveBeenCalledWith(context.res, {
      names: ["Ada", "Grace"],
      styles: [{ id: "concise" }],
      providers: [{ id: "openai" }],
      cloudProviders: [{ id: "elizacloud" }],
      models: { openai: ["gpt"] },
      inventoryProviders: [
        {
          id: "ethereum",
          rpcProviders: [{ id: "test-rpc", envKey: "TEST_FIRST_RUN_RPC_KEY" }],
        },
      ],
      sharedStyleRules: "Keep responses brief. Be helpful and concise.",
      githubOAuthAvailable: true,
    });
  });

  it("reports GitHub OAuth as unavailable without a nonblank client id", async () => {
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    const absent = makeContext("GET", "/api/first-run/options");
    await expect(handleFirstRunRoutes(absent.context)).resolves.toBe(true);
    expect(absent.json).toHaveBeenCalledWith(
      absent.context.res,
      expect.objectContaining({ githubOAuthAvailable: false }),
    );

    process.env.GITHUB_OAUTH_CLIENT_ID = "   ";
    const whitespace = makeContext("GET", "/api/first-run/options");
    await expect(handleFirstRunRoutes(whitespace.context)).resolves.toBe(true);
    expect(whitespace.json).toHaveBeenCalledWith(
      whitespace.context.res,
      expect.objectContaining({ githubOAuthAvailable: false }),
    );
  });
});

describe("handleFirstRunRoutes — POST /api/first-run", () => {
  it("denies NONE and USER principals before reading the request body", async () => {
    for (const [authorization, status] of [
      [{ ok: false, role: "NONE" as const }, 401],
      [{ ok: true, role: "USER" as const, principal: "service" }, 403],
    ] as const) {
      const denied = makeContext("POST", "/api/first-run", {
        body: { name: "Ada" },
        overrides: { authorization },
      });

      await expect(handleFirstRunRoutes(denied.context)).resolves.toBe(true);

      expect(denied.error).toHaveBeenCalledWith(
        denied.context.res,
        authorization.ok ? "Owner role required" : "Unauthorized",
        status,
      );
      expect(denied.context.readJsonBody).not.toHaveBeenCalled();
      expect(denied.context.commitElizaConfig).not.toHaveBeenCalled();
    }
  });

  it("rejects completed and concurrent submissions before reading their bodies", async () => {
    const completed = makeContext("POST", "/api/first-run", {
      state: makeState({
        meta: { firstRunComplete: true },
      } as ElizaConfig),
      body: { name: "Grace" },
    });
    await expect(handleFirstRunRoutes(completed.context)).resolves.toBe(true);
    expect(completed.error).toHaveBeenCalledWith(
      completed.context.res,
      "First-run setup is already complete",
      409,
    );
    expect(completed.context.readJsonBody).not.toHaveBeenCalled();

    let releaseBody: (() => void) | undefined;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const state = makeState();
    const first = makeContext("POST", "/api/first-run", {
      state,
      body: { name: "Ada" },
      overrides: {
        readJsonBody: vi.fn(async () => {
          await bodyGate;
          return { name: "Ada" };
        }) as FirstRunRouteContext["readJsonBody"],
      },
    });
    const second = makeContext("POST", "/api/first-run", {
      state,
      body: { name: "Grace" },
    });

    const firstRun = handleFirstRunRoutes(first.context);
    await Promise.resolve();
    await expect(handleFirstRunRoutes(second.context)).resolves.toBe(true);
    expect(second.error).toHaveBeenCalledWith(
      second.context.res,
      "First-run setup is already in progress",
      409,
    );
    expect(second.context.readJsonBody).not.toHaveBeenCalled();
    releaseBody?.();
    await expect(firstRun).resolves.toBe(true);
  });

  it("compensates DB and vault changes and preserves live state on an unpublished commit", async () => {
    const config = {
      env: { ELIZA_WALLET_OS_STORE: "true" },
      agents: { list: [{ id: "main", default: true }] },
    } as ElizaConfig;
    const character = { name: "Before", bio: ["old"] };
    const persistedAgent = {
      name: "Before",
      metadata: { retained: true },
      createdAt: 1,
      updatedAt: 1,
    };
    const updateAgent = vi.fn(async () => true);
    const runtime = {
      agentId: "agent-id",
      character,
      getAgent: vi.fn(async () => persistedAgent),
      updateAgent,
      deleteAgent: vi.fn(async () => true),
      reportError: vi.fn(),
    } as unknown as AgentRuntime;
    const state = makeState(config);
    state.runtime = runtime;
    const beforeState = structuredClone({
      config: state.config,
      agentName: state.agentName,
      adminEntityId: state.adminEntityId,
      chatUserId: state.chatUserId,
      character,
    });
    const secrets = new Map<string, string>();
    const vault = {
      has: async (key: string) => secrets.has(key),
      reveal: async (key: string) => secrets.get(key) ?? "",
      set: async (key: string, value: string) => {
        secrets.set(key, value);
      },
      remove: async (key: string) => {
        secrets.delete(key);
      },
    };
    const beforeEvm = process.env.EVM_PRIVATE_KEY;
    const beforeSolana = process.env.SOLANA_PRIVATE_KEY;
    const failed = makeContext("POST", "/api/first-run", {
      state,
      body: { name: "Ada", bio: ["new"] },
      overrides: {
        walletVault: vault as FirstRunRouteContext["walletVault"],
        commitElizaConfig: () => ({
          status: "not-published",
          cause: new Error("disk unavailable"),
        }),
      },
    });

    await expect(handleFirstRunRoutes(failed.context)).resolves.toBe(true);

    expect(failed.error).toHaveBeenCalledWith(
      failed.context.res,
      "First-run setup is unavailable",
      503,
    );
    expect(failed.json).not.toHaveBeenCalled();
    expect(state.config).toEqual(beforeState.config);
    expect(state.agentName).toBe(beforeState.agentName);
    expect(state.adminEntityId).toBe(beforeState.adminEntityId);
    expect(state.chatUserId).toBe(beforeState.chatUserId);
    expect(character).toEqual(beforeState.character);
    expect(process.env.EVM_PRIVATE_KEY).toBe(beforeEvm);
    expect(process.env.SOLANA_PRIVATE_KEY).toBe(beforeSolana);
    expect(secrets.size).toBe(0);
    expect(updateAgent).toHaveBeenCalledTimes(2);
    expect(updateAgent).toHaveBeenLastCalledWith(
      "agent-id",
      expect.objectContaining({
        name: "Before",
        metadata: { retained: true },
      }),
    );
  });

  it("retries fail-once vault compensation and reports both transaction errors", async () => {
    const config = {
      env: { ELIZA_WALLET_OS_STORE: "true" },
      agents: { list: [{ id: "main", default: true }] },
    } as ElizaConfig;
    const primaryFailure = new Error("disk unavailable");
    const rollbackFailure = new Error("vault remove temporarily unavailable");
    const reportError = vi.fn();
    const runtime = {
      agentId: "agent-id",
      character: { name: "Before" },
      getAgent: vi.fn(async () => null),
      updateAgent: vi.fn(async () => true),
      deleteAgent: vi.fn(async () => true),
      reportError,
    } as unknown as AgentRuntime;
    const state = makeState(config);
    state.runtime = runtime;
    const secrets = new Map<string, string>();
    const removeOrder: string[] = [];
    const vault = {
      has: async (key: string) => secrets.has(key),
      reveal: async (key: string) => secrets.get(key) ?? "",
      set: async (key: string, value: string) => {
        secrets.set(key, value);
      },
      remove: async (key: string) => {
        removeOrder.push(key);
        secrets.delete(key);
        if (removeOrder.length === 1) throw rollbackFailure;
      },
    };
    const failed = makeContext("POST", "/api/first-run", {
      state,
      body: { name: "Ada" },
      overrides: {
        walletVault: vault as FirstRunRouteContext["walletVault"],
        commitElizaConfig: () => ({
          status: "not-published",
          cause: primaryFailure,
        }),
      },
    });

    await expect(handleFirstRunRoutes(failed.context)).resolves.toBe(true);

    expect(removeOrder).toEqual([
      "SOLANA_PRIVATE_KEY",
      "SOLANA_PRIVATE_KEY",
      "EVM_PRIVATE_KEY",
    ]);
    expect(secrets.size).toBe(0);
    expect(failed.error).toHaveBeenCalledWith(
      failed.context.res,
      "First-run setup is unavailable",
      503,
    );
    const transactionReport = reportError.mock.calls.find(
      ([scope]) => scope === "first-run.submit.transaction",
    );
    expect(transactionReport).toBeDefined();
    const reportedError = transactionReport?.[1];
    expect(reportedError).toBeInstanceOf(ElizaError);
    expect((reportedError as ElizaError).code).toBe(
      "WALLET_KEY_COMMIT_COMPENSATION_FAILED",
    );
    const combinedCause = (reportedError as ElizaError).cause;
    expect(combinedCause).toBeInstanceOf(AggregateError);
    expect((combinedCause as AggregateError).errors[0]).toBe(primaryFailure);
    const reportedRollback = (combinedCause as AggregateError).errors[1];
    expect(reportedRollback).toBeInstanceOf(ElizaError);
    expect((reportedRollback as ElizaError).cause).toBe(rollbackFailure);
  });

  it("rejects invalid canonical sections before any persistence", async () => {
    const badTarget = makeContext("POST", "/api/first-run", {
      body: { name: "Ada", deploymentTarget: { runtime: "bogus" } },
    });
    const badCredentials = makeContext("POST", "/api/first-run", {
      body: { name: "Ada", credentialInputs: { llmApiKey: "   " } },
    });

    await expect(handleFirstRunRoutes(badTarget.context)).resolves.toBe(true);
    await expect(handleFirstRunRoutes(badCredentials.context)).resolves.toBe(
      true,
    );

    expect(badTarget.error).toHaveBeenCalledWith(
      badTarget.context.res,
      "Invalid deploymentTarget",
      400,
    );
    expect(badCredentials.error).toHaveBeenCalledWith(
      badCredentials.context.res,
      "Invalid credentialInputs",
      400,
    );
    expect(badTarget.saveElizaConfig).not.toHaveBeenCalled();
    expect(badCredentials.saveElizaConfig).not.toHaveBeenCalled();
    expect(badTarget.json).not.toHaveBeenCalled();
    expect(badCredentials.json).not.toHaveBeenCalled();
  });

  it("rewrites remote runtime routing for the local server and clears cloud env", async () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "cloud-key";
    process.env.ELIZAOS_CLOUD_ENABLED = "1";
    vi.mocked(configFileExists).mockReturnValue(true);
    const config = {
      agents: {
        defaults: { model: { primary: "legacy-primary", fallback: "keep" } },
        list: [{ id: "main", default: true }],
      },
      models: { nano: "n", small: "s", embedder: "e" },
    } as unknown as ElizaConfig;
    const state = makeState(config);
    vi.mocked(loadElizaConfig).mockReturnValue(config);
    const body = {
      name: "Ada",
      deploymentTarget: { runtime: "remote", provider: "remote" },
      serviceRouting: {
        llmText: {
          backend: "relay-backend",
          transport: "remote",
          primaryModel: "model-x",
        },
      },
      credentialInputs: { llmApiKey: "sk-live-1234" },
    };
    const { context, json, error } = makeContext("POST", "/api/first-run", {
      state,
      body,
    });
    const rewrittenRouting = {
      llmText: {
        backend: "relay-backend",
        transport: "direct",
        primaryModel: "model-x",
      },
    };

    await expect(handleFirstRunRoutes(context)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    const committedConfig = state.config;
    expect(applyCanonicalFirstRunConfig).toHaveBeenCalledWith(committedConfig, {
      deploymentTarget: { runtime: "local" },
      linkedAccounts: null,
      serviceRouting: rewrittenRouting,
      clearRoutes: [],
    });
    expect(applyFirstRunCredentialPersistence).toHaveBeenCalledWith(
      committedConfig,
      expect.objectContaining({
        credentialInputs: { llmApiKey: "sk-live-1234" },
        deploymentTarget: { runtime: "local" },
        serviceRouting: rewrittenRouting,
        environment: expect.any(Object),
      }),
    );
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBeUndefined();
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBeUndefined();
    expect((committedConfig as Record<string, unknown>).models).toEqual({
      embedder: "e",
    });
    expect(committedConfig.agents?.defaults?.model).toEqual({
      fallback: "keep",
    });
    expect(json).toHaveBeenCalledWith(context.res, { ok: true });
  });

  it("keeps minimal bodies lean, honors avatar zero, and passes through normalized message examples", async () => {
    vi.mocked(configFileExists).mockReturnValue(true);
    const messageExamples = [
      { examples: [{ name: "a", content: { text: "hi" } }] },
    ];
    const config = {} as ElizaConfig;
    const state = makeState(config);
    vi.mocked(loadElizaConfig).mockReturnValue(config);
    const { context, json, error } = makeContext("POST", "/api/first-run", {
      state,
      body: {
        name: "Ada",
        avatarIndex: 0,
        presetId: "   ",
        messageExamples,
      },
    });

    await expect(handleFirstRunRoutes(context)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(state.config.ui?.avatarIndex).toBe(0);
    expect(state.config.ui?.presetId).toBeUndefined();
    expect(state.config.ui?.theme).toBeUndefined();
    expect(state.config.agents?.defaults?.sandbox).toBeUndefined();
    expect(state.config.agents?.list?.[0]?.messageExamples).toEqual(
      messageExamples,
    );
    expect(json).toHaveBeenCalledWith(context.res, { ok: true });
  });

  it("resolves language from body first, then UI header, then configured language", async () => {
    vi.mocked(configFileExists).mockReturnValue(true);
    const headerConfig = { ui: { language: "es" } } as unknown as ElizaConfig;
    vi.mocked(loadElizaConfig).mockReturnValue(headerConfig);
    const headerWins = makeContext("POST", "/api/first-run", {
      state: makeState(headerConfig),
      body: { name: "Ada" },
      overrides: { readUiLanguageHeader: () => "de" },
    });
    await expect(handleFirstRunRoutes(headerWins.context)).resolves.toBe(true);
    expect(headerWins.context.state.config.ui?.language).toBe("de");

    const fallbackConfig = {
      ui: { language: "es" },
    } as unknown as ElizaConfig;
    vi.mocked(loadElizaConfig).mockReturnValue(fallbackConfig);
    const headerFallback = makeContext("POST", "/api/first-run", {
      state: makeState(fallbackConfig),
      body: { name: "Ada" },
    });
    await expect(handleFirstRunRoutes(headerFallback.context)).resolves.toBe(
      true,
    );
    expect(headerFallback.context.state.config.ui?.language).toBe("es");
  });

  it("ignores inventory entries with unknown chains or providers", async () => {
    vi.mocked(configFileExists).mockReturnValue(true);
    const config = {} as ElizaConfig;
    const state = makeState(config);
    vi.mocked(loadElizaConfig).mockReturnValue(config);
    const { context, json } = makeContext("POST", "/api/first-run", {
      state,
      body: {
        name: "Ada",
        inventoryProviders: [
          { chain: "unknown-chain", rpcProvider: "test-rpc", rpcApiKey: "k" },
          {
            chain: "ethereum",
            rpcProvider: "missing-provider",
            rpcApiKey: "k",
          },
          { chain: "ethereum", rpcProvider: "test-rpc" },
        ],
      },
    });

    await expect(handleFirstRunRoutes(context)).resolves.toBe(true);

    expect(
      (config.env as Record<string, string> | undefined)
        ?.TEST_FIRST_RUN_RPC_KEY,
    ).toBeUndefined();
    expect(process.env.TEST_FIRST_RUN_RPC_KEY).toBeUndefined();
    expect(json).toHaveBeenCalledWith(context.res, { ok: true });
  });

  it("stops after a body reader response and rejects invalid schema input", async () => {
    const unreadable = makeContext("POST", "/api/first-run", { body: null });
    const invalid = makeContext("POST", "/api/first-run", { body: {} });

    await expect(handleFirstRunRoutes(unreadable.context)).resolves.toBe(true);
    await expect(handleFirstRunRoutes(invalid.context)).resolves.toBe(true);

    expect(unreadable.json).not.toHaveBeenCalled();
    expect(unreadable.error).not.toHaveBeenCalled();
    expect(invalid.error).toHaveBeenCalledWith(
      invalid.context.res,
      "Invalid input: expected string, received undefined",
      400,
    );
    expect(invalid.saveElizaConfig).not.toHaveBeenCalled();
  });

  it("persists a complete onboarding payload and synchronizes the live character", async () => {
    vi.mocked(configFileExists).mockReturnValue(true);
    const config = {
      agents: { list: [{ id: "main", default: true }] },
      connectors: { telegram: { existing: "kept" } },
      features: { existingFeature: true },
      ui: { assistant: { existing: "kept" } },
    } as unknown as ElizaConfig;
    vi.mocked(loadElizaConfig).mockReturnValue(config);
    const character: Record<string, unknown> = { name: "Before" };
    const updateAgent = vi.fn(async () => true);
    const runtime = {
      agentId: "agent-id",
      character,
      getAgent: vi.fn(async () => ({ metadata: { retained: true } })),
      updateAgent,
    } as unknown as AgentRuntime;
    const state = makeState(config);
    state.runtime = runtime;
    const body = {
      name: "  Ada  ",
      bio: ["Builder"],
      systemPrompt: "Be precise",
      style: { all: ["brief"] },
      adjectives: ["curious"],
      topics: ["agents"],
      postExamples: ["hello"],
      messageExamples: [[{ user: "person", content: { text: "Hi" } }]],
      avatarIndex: 7,
      presetId: "  operator  ",
      language: "fr",
      theme: "haxor",
      sandboxMode: "standard",
      githubToken: "  github-secret  ",
      telegramToken: " telegram-secret ",
      discordToken: " discord-secret ",
      whatsappSessionPath: " /tmp/whatsapp ",
      twilioAccountSid: " sid ",
      twilioAuthToken: " auth ",
      twilioPhoneNumber: " +15550000 ",
      blooioApiKey: " blooio-secret ",
      blooioPhoneNumber: " +15551111 ",
      connectors: { telegram: { chatId: "123" }, custom: { enabled: true } },
      features: { shellEnabled: true },
      inventoryProviders: [
        {
          chain: "ethereum",
          rpcProvider: "test-rpc",
          rpcApiKey: "rpc-secret",
        },
      ],
    };
    const {
      context,
      json,
      error,
      saveElizaConfig,
      applyFirstRunVoicePreset,
      provisionWalletKeysInEnvAndConfig,
    } = makeContext("POST", "/api/first-run", { state, body });

    await expect(handleFirstRunRoutes(context)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    const committedConfig = state.config;
    expect(config.meta?.firstRunComplete).not.toBe(true);
    expect(committedConfig.meta?.firstRunComplete).toBe(true);
    expect(committedConfig.agents?.defaults?.adminEntityId).toBe(
      state.adminEntityId,
    );
    expect(state.chatUserId).toBe(state.adminEntityId);
    expect(state.chatConnectionReady).toBeNull();
    expect(state.chatConnectionPromise).toBeNull();
    expect(state.agentName).toBe("Ada");
    expect(committedConfig.agents?.list?.[0]).toEqual(
      expect.objectContaining({
        name: "Ada",
        bio: ["Builder"],
        system: "Be precise",
        style: { all: ["brief"] },
        adjectives: ["curious"],
        topics: ["agents"],
        postExamples: ["hello"],
        messageExamples: [
          {
            examples: [{ name: "person", content: { text: "Hi" } }],
          },
        ],
      }),
    );
    expect(committedConfig.ui).toEqual(
      expect.objectContaining({
        assistant: expect.objectContaining({ name: "Ada" }),
        avatarIndex: 7,
        language: "fr",
        presetId: "operator",
        theme: "haxor",
      }),
    );
    expect(committedConfig.agents?.defaults?.sandbox).toEqual({
      mode: "standard",
    });
    expect(committedConfig.connectors).toEqual(
      expect.objectContaining({
        telegram: { botToken: "telegram-secret" },
        discord: { token: "discord-secret" },
        whatsapp: { sessionPath: "/tmp/whatsapp" },
        custom: { enabled: true },
        blooio: { apiKey: "blooio-secret", fromNumber: "+15551111" },
      }),
    );
    expect(committedConfig.features).toEqual({
      existingFeature: true,
      shellEnabled: true,
    });
    expect(committedConfig.env).toEqual(
      expect.objectContaining({
        GITHUB_TOKEN: "github-secret",
        TWILIO_ACCOUNT_SID: "sid",
        TWILIO_AUTH_TOKEN: "auth",
        TWILIO_PHONE_NUMBER: "+15550000",
        BLOOIO_API_KEY: "blooio-secret",
        BLOOIO_PHONE_NUMBER: "+15551111",
        TEST_FIRST_RUN_RPC_KEY: "rpc-secret",
      }),
    );
    expect(character).toEqual(
      expect.objectContaining({
        name: "Ada",
        bio: ["Builder"],
        system: "Be precise",
        style: { all: ["brief"] },
        messageExamples: [
          {
            examples: [{ name: "person", content: { text: "Hi" } }],
          },
        ],
      }),
    );
    expect(updateAgent).toHaveBeenCalledWith(
      "agent-id",
      expect.objectContaining({
        name: "Ada",
        metadata: expect.objectContaining({
          retained: true,
          character: expect.objectContaining({ name: "Ada" }),
        }),
      }),
    );
    expect(applyFirstRunVoicePreset).toHaveBeenCalledWith(
      committedConfig,
      expect.objectContaining({ name: "Ada", presetId: "  operator  " }),
      "fr",
    );
    expect(provisionWalletKeysInEnvAndConfig).toHaveBeenCalledWith(
      committedConfig,
      expect.any(Object),
    );
    expect(saveElizaConfig).toHaveBeenCalledWith(committedConfig);
    expect(json).toHaveBeenCalledWith(context.res, { ok: true });
  });

  it("reports unpublished and uncertain commits without success", async () => {
    const saveFailure = makeContext("POST", "/api/first-run", {
      body: { name: "Ada" },
      overrides: {
        commitElizaConfig: () => ({
          status: "not-published",
          cause: new Error("read-only filesystem"),
        }),
      },
    });

    await expect(handleFirstRunRoutes(saveFailure.context)).resolves.toBe(true);
    expect(saveFailure.error).toHaveBeenCalledWith(
      saveFailure.context.res,
      "First-run setup is unavailable",
      503,
    );
    expect(saveFailure.json).not.toHaveBeenCalled();

    const uncertainCommit = makeContext("POST", "/api/first-run", {
      body: { name: "Grace" },
      overrides: {
        commitElizaConfig: () => ({
          status: "uncertain",
          cause: new Error("rename state unknown"),
        }),
      },
    });
    await expect(handleFirstRunRoutes(uncertainCommit.context)).resolves.toBe(
      true,
    );
    expect(uncertainCommit.error).toHaveBeenCalledWith(
      uncertainCommit.context.res,
      "First-run persistence state is uncertain",
      503,
    );
    expect(uncertainCommit.json).not.toHaveBeenCalled();
  });
});
