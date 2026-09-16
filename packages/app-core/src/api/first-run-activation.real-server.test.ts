/**
 * Exercises first-run admission, persistence, activation and retry over the real
 * HTTP host and PGlite runtime. The real OpenAI plugin uses a local provider
 * transport; the host restart callback is controlled to expose lifecycle races.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadElizaConfig } from "@elizaos/agent/config/config";
import { listAccounts } from "@elizaos/auth/account-storage";
import { ModelType } from "@elizaos/core";
import {
  FirstRunActivationSchema,
  PostFirstRunResponseSchema,
  resetDevCloudEnvAuthorityForTests,
} from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openaiPlugin } from "../../../../plugins/plugin-openai/index.ts";
import { createRealTestRuntime } from "../../test/helpers/real-runtime";
import { installAgentHostBridge } from "../runtime/install-agent-host-bridge";
import { startApiServer } from "./server";

const savedEnv = { ...process.env };
let directory: string;
let configPath: string;
let fixture: Awaited<ReturnType<typeof createRealTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;
const runtimes: Awaited<ReturnType<typeof createRealTestRuntime>>[] = [];
let provider: http.Server;
let base: string;
let providerBase: string;
let restartMode: "success" | "failure" = "success";
let restartGate: Promise<void> = Promise.resolve();
let restartRequests = 0;
let rejectConfigSync = false;
const modelRequests: string[] = [];
const modelAuthorizations: (string | undefined)[] = [];
const token = "synthetic-first-run-owner";
const body = {
  name: "Activated provider",
  deploymentTarget: { runtime: "local" },
  serviceRouting: {
    llmText: {
      backend: "openai",
      transport: "direct",
      smallModel: "gpt-4.1-mini",
      largeModel: "gpt-4.1-mini",
    },
  },
  credentialInputs: { llmApiKey: "synthetic-local-transport-only" },
};
async function submit(
  value: Record<string, unknown> = body,
  key = crypto.randomUUID(),
): Promise<Response> {
  return fetch(`${base}/api/first-run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "idempotency-key": key,
    },
    body: JSON.stringify(value),
  });
}
async function settle(operationId: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await fetch(
      `${base}/api/first-run/activation/${operationId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    const receipt = FirstRunActivationSchema.parse(await response.json());
    if (receipt.status !== "pending" && receipt.status !== "running")
      return receipt;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("First-run operation did not settle");
}

function installLocalOpenRouterTransport(): void {
  const originalFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.startsWith("https://openrouter.ai/api/v1/")) {
        return originalFetch(
          new Request(
            request.url.replace("https://openrouter.ai/api/v1", providerBase),
            request,
          ),
        );
      }
      if (new URL(request.url).hostname !== "127.0.0.1")
        throw new Error("Unexpected external transport in first-run test");
      return originalFetch(request);
    },
  );
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "first-run-activation-"));
  configPath = path.join(directory, "eliza.json");
  process.env.ELIZA_STATE_DIR = directory;
  process.env.ELIZA_CONFIG_PATH = configPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
  process.env.ELIZA_WALLET_OS_STORE = "0";
  process.env.ELIZA_API_TOKEN = token;
  process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
  for (const key of [
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "CEREBRAS_API_KEY",
    "ELIZAOS_CLOUD_API_KEY",
    "ELIZAOS_CLOUD_ENABLED",
    "ELIZA_CLOUD_PROVISIONED",
    "ELIZA_API_AUTH_TOKEN",
    "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  ])
    delete process.env[key];
  process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "offline";
  process.env.ELIZA_DEV_CLOUD_TARGET = "offline";
  resetDevCloudEnvAuthorityForTests();
  provider = http.createServer((req, res) => {
    modelRequests.push(req.url ?? "");
    if (req.url === "/v1/chat/completions")
      modelAuthorizations.push(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/key") {
      res.statusCode =
        req.headers.authorization === "Bearer invalid-local-key" ? 401 : 200;
      res.end(JSON.stringify({ data: { label: "fixture account" } }));
      return;
    }
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: [{ id: "openai/gpt-4.1-mini" }] }));
      return;
    }
    res.end(
      JSON.stringify({
        id: "local-activation",
        object: "chat.completion",
        created: 1,
        model: "gpt-4.1-mini",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ready" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  if (!address || typeof address === "string")
    throw new Error("Provider port unavailable");
  providerBase = `http://127.0.0.1:${address.port}/v1`;
  process.env.OPENAI_BASE_URL = providerBase;
  fixture = await createRealTestRuntime({ characterName: "Before setup" });
  runtimes.push(fixture);
  server = await startApiServer({
    port: 0,
    runtime: fixture.runtime,
    skipDeferredStartupWork: true,
    requestMiddleware: async (req, res, next) => {
      if (
        rejectConfigSync &&
        req.method === "PUT" &&
        req.url === "/api/config"
      ) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Controlled config synchronization failure",
          }),
        );
        return;
      }
      await next();
    },
    onRestart: async () => {
      restartRequests++;
      await restartGate;
      if (restartMode === "failure")
        throw new Error("Controlled host restart failure");
      const previous = fixture;
      await previous.runtime.stop({ fast: true });
      fixture = await createRealTestRuntime({
        characterName: "Activated provider",
        pgliteDir: previous.pgliteDir,
        removePgliteDirOnCleanup: false,
      });
      runtimes.push(fixture);
      await fixture.runtime.registerPlugin(openaiPlugin);
      return fixture.runtime;
    },
  });
  base = `http://127.0.0.1:${server.port}`;
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await server?.close();
  for (const runtime of [...runtimes].reverse()) await runtime.cleanup();
  provider?.close();
  for (const key of Object.keys(process.env))
    if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe.sequential("local first-run activation", () => {
  it("registers the real selected provider and waits for its transport health", async () => {
    expect(fixture.runtime.models.get(ModelType.TEXT_SMALL)).toBeUndefined();
    const response = await submit();
    expect(response.status).toBe(202);
    const receipt = PostFirstRunResponseSchema.parse(
      await response.json(),
    ).activation;
    expect(receipt).toBeDefined();
    if (!receipt) throw new Error("No activation receipt");
    expect((await settle(receipt.operationId)).status).toBe("succeeded");
    expect(restartRequests).toBe(1);
    expect(loadElizaConfig().serviceRouting?.llmText?.backend).toBe("openai");
    const status = await (
      await fetch(`${base}/api/status`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    expect(status.agentName).toBe("Activated provider");
    expect(
      fixture.runtime.models
        .get(ModelType.TEXT_SMALL)
        ?.map((handler) => handler.provider),
    ).toContain("openai");
    expect(modelRequests).toContain("/v1/chat/completions");
  });

  it("rejects another setup before config mutation and deduplicates the admitted retry", async () => {
    let release = () => {};
    restartGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const key = crypto.randomUUID();
    const first = PostFirstRunResponseSchema.parse(
      await (await submit(body, key)).json(),
    ).activation;
    if (!first) throw new Error("No activation receipt");
    try {
      const before = await readFile(configPath, "utf8");
      const rejected = await submit({ ...body, name: "Must not persist" });
      expect(rejected.status).toBe(409);
      expect(await readFile(configPath, "utf8")).toBe(before);
      const retried = PostFirstRunResponseSchema.parse(
        await (await submit(body, key)).json(),
      ).activation;
      expect(retried?.operationId).toBe(first.operationId);
    } finally {
      release();
      restartGate = Promise.resolve();
    }
    expect((await settle(first.operationId)).status).toBe("succeeded");
  });

  it("returns an explicit failed receipt and allows a new retry", async () => {
    restartMode = "failure";
    const failed = PostFirstRunResponseSchema.parse(
      await (await submit()).json(),
    ).activation;
    if (!failed) throw new Error("No activation receipt");
    const result = await settle(failed.operationId);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Retry setup");
    restartMode = "success";
    const retried = PostFirstRunResponseSchema.parse(
      await (await submit()).json(),
    ).activation;
    if (!retried) throw new Error("No retry receipt");
    expect(retried.operationId).not.toBe(failed.operationId);
    expect((await settle(retried.operationId)).status).toBe("succeeded");
  });

  it("releases admission after persistence fails", async () => {
    const blockedParent = path.join(directory, "not-a-directory");
    await writeFile(blockedParent, "occupied");
    process.env.ELIZA_CONFIG_PATH = path.join(blockedParent, "eliza.json");
    process.env.ELIZA_PERSIST_CONFIG_PATH = process.env.ELIZA_CONFIG_PATH;
    try {
      expect((await submit()).status).toBe(500);
    } finally {
      process.env.ELIZA_CONFIG_PATH = configPath;
      process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
    }
    const retry = PostFirstRunResponseSchema.parse(
      await (await submit()).json(),
    ).activation;
    if (!retry) throw new Error("No retry receipt");
    expect((await settle(retry.operationId)).status).toBe("succeeded");
  });

  it("keeps activation reads authenticated", async () => {
    const response = await fetch(
      `${base}/api/first-run/activation/${crypto.randomUUID()}`,
    );
    expect(response.status).toBe(401);
  });
  it("adopts OpenRouter into the canonical encrypted account pool before activation", async () => {
    installAgentHostBridge();
    installLocalOpenRouterTransport();
    const openRouterBody = {
      ...body,
      serviceRouting: {
        llmText: {
          backend: "openrouter",
          transport: "direct",
          smallModel: "openai/gpt-4.1-mini",
          largeModel: "openai/gpt-4.1-mini",
        },
      },
      credentialInputs: { llmApiKey: "invalid-local-key" },
    };
    const before = await readFile(configPath, "utf8");
    expect((await submit(openRouterBody)).status).toBe(400);
    expect(await readFile(configPath, "utf8")).toBe(before);
    expect(await listAccounts("openrouter-api")).toHaveLength(0);
    openRouterBody.credentialInputs.llmApiKey =
      "synthetic-openrouter-private-only";
    rejectConfigSync = true;
    try {
      expect((await submit(openRouterBody)).status).toBe(500);
      expect(await listAccounts("openrouter-api")).toHaveLength(0);
    } finally {
      rejectConfigSync = false;
    }
    const key = crypto.randomUUID();
    const response = await submit(openRouterBody, key);
    expect(response.status).toBe(202);
    const receipt = PostFirstRunResponseSchema.parse(
      await response.json(),
    ).activation;
    if (!receipt) throw new Error("No OpenRouter activation receipt");
    expect((await settle(receipt.operationId)).status).toBe("succeeded");
    const retried = PostFirstRunResponseSchema.parse(
      await (await submit(openRouterBody, key)).json(),
    ).activation;
    expect(retried?.operationId).toBe(receipt.operationId);
    const accounts = await listAccounts("openrouter-api");
    expect(accounts).toHaveLength(1);
    expect(accounts[0].credentials.access).toBe(
      "synthetic-openrouter-private-only",
    );
    expect(await readFile(configPath, "utf8")).not.toContain(
      "synthetic-openrouter-private-only",
    );
    expect(process.env.OPENAI_API_KEY).toBe(
      "synthetic-openrouter-private-only",
    );
    expect(process.env.OPENAI_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(modelRequests).toContain("/v1/key");
    expect(modelRequests).toContain("/v1/models");
    vi.unstubAllGlobals();
  });
  it("activates the replacement credential after an earlier account activation failed", async () => {
    installLocalOpenRouterTransport();
    const replacement = {
      ...body,
      serviceRouting: {
        llmText: {
          backend: "openrouter",
          transport: "direct",
          smallModel: "openai/gpt-4.1-mini",
          largeModel: "openai/gpt-4.1-mini",
        },
      },
      credentialInputs: { llmApiKey: "synthetic-failed-activation-key" },
    };
    const config = loadElizaConfig();
    const unrelatedRoute = {
      backend: "openai",
      transport: "direct" as const,
      accountIds: ["unrelated-tts-pin"],
    };
    config.serviceRouting = { ...config.serviceRouting, tts: unrelatedRoute };
    const configured = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        serviceRouting: config.serviceRouting,
      }),
    });
    expect(configured.status).toBe(200);
    restartMode = "failure";
    try {
      const failed = PostFirstRunResponseSchema.parse(
        await (await submit(replacement)).json(),
      ).activation;
      if (!failed) throw new Error("No failed activation receipt");
      expect((await settle(failed.operationId)).status).toBe("failed");
      restartMode = "success";
      replacement.credentialInputs.llmApiKey = "synthetic-replacement-key";
      const retry = PostFirstRunResponseSchema.parse(
        await (await submit(replacement)).json(),
      ).activation;
      if (!retry) throw new Error("No replacement activation receipt");
      expect((await settle(retry.operationId)).status).toBe("succeeded");
      expect(process.env.OPENAI_API_KEY).toBe("synthetic-replacement-key");
      expect(modelAuthorizations.at(-1)).toBe(
        "Bearer synthetic-replacement-key",
      );
      const saved = loadElizaConfig();
      expect(saved.serviceRouting?.tts).toEqual(unrelatedRoute);
      const accounts = await listAccounts("openrouter-api");
      const selected = accounts.find(
        (account) => account.credentials.access === "synthetic-replacement-key",
      );
      expect(selected).toBeDefined();
      expect(saved.serviceRouting?.llmText?.accountIds).toEqual([selected?.id]);
      const before = await readFile(configPath, "utf8");
      const conflicting = await submit({
        ...replacement,
        serviceRouting: {
          llmText: {
            ...replacement.serviceRouting.llmText,
            accountIds: [accounts[0].id],
          },
        },
      });
      expect(conflicting.status).toBe(400);
      expect(await readFile(configPath, "utf8")).toBe(before);
      expect(await listAccounts("openrouter-api")).toHaveLength(
        accounts.length,
      );
    } finally {
      restartMode = "success";
      vi.unstubAllGlobals();
    }
  });
  it("retains the selected direct route through offline launcher synchronization", async () => {
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "offline";
    process.env.ELIZA_DEV_CLOUD_TARGET = "offline";
    process.env.OPENAI_BASE_URL = providerBase;
    resetDevCloudEnvAuthorityForTests();
    try {
      const response = await submit(body);
      expect(response.status).toBe(202);
      const receipt = PostFirstRunResponseSchema.parse(
        await response.json(),
      ).activation;
      if (!receipt) throw new Error("No offline activation receipt");
      expect((await settle(receipt.operationId)).status).toBe("succeeded");
      expect(loadElizaConfig().serviceRouting?.llmText?.backend).toBe("openai");
    } finally {
      delete process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY;
      delete process.env.ELIZA_DEV_CLOUD_TARGET;
      resetDevCloudEnvAuthorityForTests();
    }
  });
});
