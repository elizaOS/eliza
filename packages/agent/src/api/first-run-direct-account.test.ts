/**
 * Verifies first-run paid-provider adoption against real encrypted account
 * storage and a deterministic host pool; provider HTTP calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listAccounts } from "@elizaos/auth/account-storage";
import type { LinkedAccountConfig } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  accounts: [] as LinkedAccountConfig[],
  upsert: vi.fn(),
  deleteMetadata: vi.fn(),
  applyAccountPoolApiCredentials: vi.fn(),
}));

vi.mock("../runtime/host-bridge.ts", () => ({
  getAgentHostBridge: () => ({
    getDefaultAccountPool: () => ({
      list: () => state.accounts,
      upsert: state.upsert,
      deleteMetadata: state.deleteMetadata,
    }),
    applyAccountPoolApiCredentials: state.applyAccountPoolApiCredentials,
  }),
}));

import {
  configFileExists,
  loadElizaConfig,
  saveElizaConfig,
} from "../config/config.ts";
import { adoptFirstRunDirectAccount } from "./first-run-direct-account.ts";
import {
  type FirstRunRouteContext,
  handleFirstRunRoutes,
} from "./first-run-routes.ts";

let stateRoot = "";
let previousStateDir: string | undefined;
let previousOpenRouterKey: string | undefined;
let previousOpenAiKey: string | undefined;
let previousOpenAiBase: string | undefined;

beforeEach(() => {
  stateRoot = mkdtempSync(path.join(tmpdir(), "first-run-direct-account-"));
  previousStateDir = process.env.ELIZA_STATE_DIR;
  previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
  previousOpenAiKey = process.env.OPENAI_API_KEY;
  previousOpenAiBase = process.env.OPENAI_BASE_URL;
  process.env.ELIZA_STATE_DIR = stateRoot;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  state.accounts = [];
  state.upsert.mockReset().mockImplementation(async (account) => {
    state.accounts.push(account);
  });
  state.deleteMetadata.mockReset().mockImplementation(async (_provider, id) => {
    state.accounts = state.accounts.filter((account) => account.id !== id);
  });
  state.applyAccountPoolApiCredentials
    .mockReset()
    .mockImplementation(async ({ activeBackend }) => {
      const active = state.accounts.find(
        (account) =>
          account.providerId === "openrouter-api" &&
          account.enabled &&
          account.health === "ok",
      );
      const credential = active
        ? (await listAccounts("openrouter-api")).find(
            (record) => record.id === active.id,
          )
        : undefined;
      if (activeBackend === "openrouter" && credential) {
        process.env.OPENROUTER_API_KEY = credential.credentials.access;
        process.env.OPENAI_API_KEY = credential.credentials.access;
        process.env.OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
        return;
      }
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
    });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = previousStateDir;
  if (previousOpenRouterKey === undefined)
    delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
  if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAiKey;
  if (previousOpenAiBase === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = previousOpenAiBase;
  rmSync(stateRoot, { recursive: true, force: true });
});

function openRouterFirstRunBody(apiKey: string): Record<string, unknown> {
  return {
    name: "Fresh Eliza",
    deploymentTarget: { runtime: "local" },
    serviceRouting: {
      llmText: { backend: "openrouter", transport: "direct" },
    },
    credentialInputs: { llmApiKey: apiKey },
  };
}

function firstRunRouteContext(args: {
  apiKey: string;
  saveConfig?: typeof saveElizaConfig;
  runtime?: FirstRunRouteContext["state"]["runtime"];
  ensureWalletKeysInEnvAndConfig?: FirstRunRouteContext["ensureWalletKeysInEnvAndConfig"];
}): {
  context: FirstRunRouteContext;
  responses: Array<{ status: number; data: unknown }>;
} {
  const responses: Array<{ status: number; data: unknown }> = [];
  const config = {
    agents: { defaults: {}, list: [] },
    ui: {},
  };
  const context = {
    req: { headers: {}, socket: { remoteAddress: "127.0.0.1" } },
    res: {},
    method: "POST",
    pathname: "/api/first-run",
    url: new URL("http://127.0.0.1/api/first-run"),
    state: {
      config,
      runtime: args.runtime ?? null,
      agentName: "Eliza",
      adminEntityId: "existing-admin",
      chatUserId: "existing-chat-user",
      chatConnectionReady: "ready",
      chatConnectionPromise: Promise.resolve(),
    },
    json: (_res: unknown, data: unknown, status = 200) => {
      responses.push({ status, data });
    },
    error: (_res: unknown, message: string, status = 500) => {
      responses.push({ status, data: { error: message } });
    },
    readJsonBody: async () => openRouterFirstRunBody(args.apiKey),
    isCloudProvisionedContainer: () => false,
    hasPersistedFirstRunState: (candidate: {
      meta?: { firstRunComplete?: boolean };
    }) => candidate.meta?.firstRunComplete === true,
    ensureWalletKeysInEnvAndConfig:
      args.ensureWalletKeysInEnvAndConfig ?? (() => false),
    getWalletAddresses: () => ({}),
    pickRandomNames: () => [],
    getStylePresets: () => [],
    getProviderOptions: () => [],
    getCloudProviderOptions: () => [],
    getModelOptions: () => ({}),
    getInventoryProviderOptions: () => [],
    resolveConfiguredCharacterLanguage: () => "en",
    normalizeCharacterLanguage: () => "en",
    readUiLanguageHeader: () => null,
    applyFirstRunVoicePreset: () => {},
    saveElizaConfig: args.saveConfig ?? saveElizaConfig,
  } as unknown as FirstRunRouteContext;
  return { context, responses };
}

describe("first-run direct account adoption", () => {
  it("rejects an invalid OpenRouter key without account persistence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );

    await expect(
      adoptFirstRunDirectAccount({
        providerId: "openrouter-api",
        apiKey: "invalid-key",
      }),
    ).rejects.toMatchObject({ code: "FIRST_RUN_DIRECT_CREDENTIAL_INVALID" });

    expect(state.upsert).not.toHaveBeenCalled();
    expect(await listAccounts("openrouter-api")).toEqual([]);
  });

  it("stores a proven OpenRouter key only in the canonical account record", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { label: "primary" } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "openai/gpt-5" }] }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const adopted = await adoptFirstRunDirectAccount({
      providerId: "openrouter-api",
      apiKey: "sk-or-valid",
    });

    expect(state.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "openrouter-api",
        health: "ok",
      }),
    );
    const records = await listAccounts("openrouter-api");
    expect(records).toHaveLength(1);
    expect(records[0]?.credentials.access).toBe("sk-or-valid");
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    await adopted.rollback();
    expect(await listAccounts("openrouter-api")).toEqual([]);
    expect(state.accounts).toEqual([]);
  });

  it("adopts a proven xAI key through the same account authority", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ id: "grok-code-fast-1" }] }), {
            status: 200,
          }),
      ),
    );

    await adoptFirstRunDirectAccount({
      providerId: "xai-api",
      apiKey: "xai-valid",
    });

    expect(state.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "xai-api", health: "ok" }),
    );
    expect((await listAccounts("xai-api"))[0]?.credentials.access).toBe(
      "xai-valid",
    );
    expect(process.env.XAI_API_KEY).toBeUndefined();
  });
});

describe("POST /api/first-run direct account authority", () => {
  it("rejects an invalid key without durable config, account, or live env", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    const { context, responses } = firstRunRouteContext({
      apiKey: "invalid-key",
    });

    await expect(handleFirstRunRoutes(context)).resolves.toBe(true);

    expect(responses).toEqual([
      {
        status: 400,
        data: {
          error: "openrouter-api credential probe failed (HTTP 401)",
        },
      },
    ]);
    expect(configFileExists()).toBe(false);
    expect(await listAccounts("openrouter-api")).toEqual([]);
    expect(state.accounts).toEqual([]);
    expect(JSON.stringify(context.state.config)).not.toContain("invalid-key");
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("restores all live first-run authority when config commit fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: { label: "primary" } }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: [{ id: "openai/gpt-5" }] }), {
            status: 200,
          }),
        ),
    );
    const runtime = {
      agentId: "agent-id",
      character: { name: "Original", bio: ["Original bio"] },
      getAgent: vi.fn(async () => ({ metadata: { existing: true } })),
      updateAgent: vi.fn(async () => {}),
      setSetting: vi.fn(),
    } as unknown as FirstRunRouteContext["state"]["runtime"];
    const { context, responses } = firstRunRouteContext({
      apiKey: "sk-or-config-failure",
      runtime,
      ensureWalletKeysInEnvAndConfig: (config) => {
        config.env = {
          ...(config.env ?? {}),
          EVM_PRIVATE_KEY: "generated-evm",
          SOLANA_PRIVATE_KEY: "generated-solana",
        };
        process.env.EVM_PRIVATE_KEY = "generated-evm";
        process.env.SOLANA_PRIVATE_KEY = "generated-solana";
        return true;
      },
      saveConfig: () => {
        throw new Error("disk unavailable");
      },
    });
    const originalConfig = structuredClone(context.state.config);
    const originalChatPromise = context.state.chatConnectionPromise;

    await expect(handleFirstRunRoutes(context)).resolves.toBe(true);

    expect(responses.at(-1)).toEqual({
      status: 500,
      data: { error: "Failed to save configuration" },
    });
    expect(configFileExists()).toBe(false);
    expect(await listAccounts("openrouter-api")).toEqual([]);
    expect(state.accounts).toEqual([]);
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
    expect(process.env.EVM_PRIVATE_KEY).toBeUndefined();
    expect(process.env.SOLANA_PRIVATE_KEY).toBeUndefined();
    expect(context.state.config).toEqual(originalConfig);
    expect(context.state.agentName).toBe("Eliza");
    expect(context.state.adminEntityId).toBe("existing-admin");
    expect(context.state.chatUserId).toBe("existing-chat-user");
    expect(context.state.chatConnectionReady).toBe("ready");
    expect(context.state.chatConnectionPromise).toBe(originalChatPromise);
    expect(runtime?.character).toEqual({
      name: "Original",
      bio: ["Original bio"],
    });
    expect(runtime?.updateAgent).not.toHaveBeenCalled();
    expect(runtime?.setSetting).not.toHaveBeenCalled();
    expect(state.applyAccountPoolApiCredentials).toHaveBeenCalledTimes(2);

    context.method = "GET";
    context.pathname = "/api/first-run/status";
    await expect(handleFirstRunRoutes(context)).resolves.toBe(true);
    expect(responses.at(-1)).toEqual({
      status: 200,
      data: { complete: false },
    });

    context.pathname = "/api/wallet/keys";
    await expect(handleFirstRunRoutes(context)).resolves.toBe(true);
    expect(responses.at(-1)?.status).toBe(200);
    delete process.env.EVM_PRIVATE_KEY;
    delete process.env.SOLANA_PRIVATE_KEY;
  });

  it("preserves an external env edit made while a failing config commit is in flight", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: { label: "primary" } }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: [{ id: "openai/gpt-5" }] }), {
            status: 200,
          }),
        ),
    );
    const { context, responses } = firstRunRouteContext({
      apiKey: "sk-or-external-edit",
      saveConfig: () => {
        process.env.EXTERNAL_OPERATOR_EDIT = "preserve-me";
        throw new Error("disk unavailable");
      },
    });

    await expect(handleFirstRunRoutes(context)).resolves.toBe(true);

    expect(responses.at(-1)).toEqual({
      status: 500,
      data: { error: "Failed to save configuration" },
    });
    expect(await listAccounts("openrouter-api")).toEqual([]);
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
    expect(process.env.EXTERNAL_OPERATOR_EDIT).toBe("preserve-me");
    delete process.env.EXTERNAL_OPERATOR_EDIT;
  });

  it("retries cleanly after a failed config commit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) =>
        String(url).includes("/auth/key")
          ? new Response(JSON.stringify({ data: { label: "primary" } }), {
              status: 200,
            })
          : new Response(JSON.stringify({ data: [{ id: "openai/gpt-5" }] }), {
              status: 200,
            }),
      ),
    );
    let attempts = 0;
    const { context, responses } = firstRunRouteContext({
      apiKey: "sk-or-retry-authority",
      saveConfig: (config) => {
        attempts += 1;
        if (attempts === 1) throw new Error("first commit failed");
        saveElizaConfig(config);
      },
    });

    await handleFirstRunRoutes(context);
    expect(responses.at(-1)?.status).toBe(500);
    expect(context.state.agentName).toBe("Eliza");
    expect(context.state.config.meta?.firstRunComplete).not.toBe(true);
    expect(await listAccounts("openrouter-api")).toEqual([]);

    await handleFirstRunRoutes(context);
    expect(responses.at(-1)).toEqual({ status: 200, data: { ok: true } });
    expect(context.state.agentName).toBe("Fresh Eliza");
    expect(context.state.config.meta?.firstRunComplete).toBe(true);
    expect(await listAccounts("openrouter-api")).toHaveLength(1);
  });

  it("rejects an incomplete connector before probing or adopting a paid provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { context, responses } = firstRunRouteContext({
      apiKey: "synthetic-provider",
    });
    const originalConfig = structuredClone(context.state.config);
    const originalEnvironment = { ...process.env };
    context.readJsonBody = async () => ({
      ...openRouterFirstRunBody("synthetic-provider"),
      connectors: { blooio: { apiKey: "synthetic-connector" } },
    });

    await handleFirstRunRoutes(context);

    expect(responses.at(-1)).toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await listAccounts("openrouter-api")).toEqual([]);
    expect(configFileExists()).toBe(false);
    expect(context.state.config).toEqual(originalConfig);
    expect(
      Object.keys(process.env).length ===
        Object.keys(originalEnvironment).length &&
        Object.entries(originalEnvironment).every(
          ([key, value]) => process.env[key] === value,
        ),
    ).toBe(true);
  });

  it.each([false, true])(
    "commits connector and paid-provider authority together (save failure: %s)",
    async (failSave) => {
      const connector = {
        apiKey: "synthetic-connector",
        webhookSecret: "synthetic-webhook",
        fromNumber: "+15551234567",
        channelId: "synthetic-channel",
      };
      const connectorEnvironment = {
        IMESSAGE_TRANSPORT: "blooio",
        IMESSAGE_BLOOIO_API_KEY: connector.apiKey,
        IMESSAGE_BLOOIO_WEBHOOK_SECRET: connector.webhookSecret,
        IMESSAGE_BLOOIO_FROM_NUMBER: connector.fromNumber,
        IMESSAGE_BLOOIO_CHANNEL_ID: connector.channelId,
        BLOOIO_API_KEY: connector.apiKey,
        BLOOIO_WEBHOOK_SECRET: connector.webhookSecret,
        BLOOIO_FROM_NUMBER: connector.fromNumber,
        BLOOIO_PHONE_NUMBER: connector.fromNumber,
      };
      const priorEnvironment = Object.fromEntries(
        Object.keys(connectorEnvironment).map((key) => [key, process.env[key]]),
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async (url: string | URL | Request) =>
            new Response(
              JSON.stringify(
                String(url).includes("/auth/key")
                  ? { data: { label: "primary" } }
                  : { data: [{ id: "openai/gpt-5" }] },
              ),
              { status: 200 },
            ),
        ),
      );
      const { context, responses } = firstRunRouteContext({
        apiKey: "synthetic-provider",
        saveConfig: (config) => {
          if (failSave) throw new Error("disk unavailable");
          saveElizaConfig(config);
        },
      });
      const originalConfig = structuredClone(context.state.config);
      context.readJsonBody = async () => ({
        ...openRouterFirstRunBody("synthetic-provider"),
        connectors: { blooio: connector },
      });
      try {
        await handleFirstRunRoutes(context);
        const accounts = await listAccounts("openrouter-api");
        if (failSave) {
          expect(responses.at(-1)?.status).toBe(500);
          expect(configFileExists()).toBe(false);
          expect(accounts).toEqual([]);
          expect(state.accounts).toEqual([]);
          expect(context.state.config).toEqual(originalConfig);
          expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
          for (const [key, value] of Object.entries(priorEnvironment))
            expect(process.env[key]).toBe(value);
        } else {
          expect(responses.at(-1)).toEqual({ status: 200, data: { ok: true } });
          expect(accounts[0]?.credentials.access).toBe("synthetic-provider");
          expect(loadElizaConfig().connectors?.blooio).toMatchObject(connector);
          expect(context.state.config.meta?.firstRunComplete).toBe(true);
          expect(process.env.OPENROUTER_API_KEY).toBe("synthetic-provider");
          for (const [key, value] of Object.entries(connectorEnvironment))
            expect(process.env[key]).toBe(value);
        }
      } finally {
        for (const [key, value] of Object.entries(priorEnvironment)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
  );

  it("reconstructs live exports from persisted authority in the same process", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: { label: "primary" } }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: [{ id: "openai/gpt-5" }] }), {
            status: 200,
          }),
        ),
    );
    const { context, responses } = firstRunRouteContext({
      apiKey: "sk-or-restart-authority",
    });

    await expect(handleFirstRunRoutes(context)).resolves.toBe(true);

    expect(responses.at(-1)).toEqual({ status: 200, data: { ok: true } });
    expect(configFileExists()).toBe(true);
    expect(JSON.stringify(loadElizaConfig())).not.toContain(
      "sk-or-restart-authority",
    );
    const persistedAccounts = await listAccounts("openrouter-api");
    expect(persistedAccounts).toHaveLength(1);
    expect(persistedAccounts[0]?.credentials.access).toBe(
      "sk-or-restart-authority",
    );

    // Reconstruct the boot-time export inputs in-process: raw env is empty and
    // the deterministic host reads persisted metadata plus the encrypted record.
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    state.accounts = state.accounts.map((account) => ({ ...account }));
    await state.applyAccountPoolApiCredentials({ activeBackend: "openrouter" });

    expect(process.env.OPENROUTER_API_KEY).toBe("sk-or-restart-authority");
    expect(process.env.OPENAI_API_KEY).toBe("sk-or-restart-authority");
    expect(process.env.OPENAI_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });
});
