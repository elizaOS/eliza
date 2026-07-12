/**
 * Unit coverage for the models-config client verbs: the catalog/config reads
 * and the POST /api/models/config outcome normalization (applied / deduped /
 * typed 400 / 409-busy / throw). Transport stubbed, no live agent.
 */
import { describe, expect, it, vi } from "vitest";
import "./client-agent";
import { ElizaClient } from "./client-base";
import { ApiError } from "./client-types-core";

function clientWithBody(body: unknown): {
  client: ElizaClient;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const client = new ElizaClient("http://agent.example:31337", "token");
  const fetchMock = vi.fn(async () => body);
  client.fetch = fetchMock as unknown as typeof client.fetch;
  return { client, fetchMock };
}

describe("ElizaClient.getModelsCatalog", () => {
  it("reads the catalog-only fast path (no provider fan-out)", async () => {
    const { client, fetchMock } = clientWithBody({
      providers: {},
      catalog: { providers: {} },
    });
    const result = await client.getModelsCatalog();
    // catalogOnly skips the server's all-providers model-list fan-out, which
    // exceeds the client's 10s fetch budget on a cold cache.
    expect(fetchMock).toHaveBeenCalledWith("/api/models?catalogOnly=1");
    expect(result.catalog).toEqual({ providers: {} });
  });
});

describe("ElizaClient.getModelsConfig", () => {
  it("reads /api/models/config", async () => {
    const { client, fetchMock } = clientWithBody({
      targets: { small: {}, large: {}, coding: {} },
    });
    const result = await client.getModelsConfig();
    expect(fetchMock).toHaveBeenCalledWith("/api/models/config");
    expect(result.targets).toBeDefined();
  });
});

describe("ElizaClient.updateModelsConfig", () => {
  it("posts with allowNonOk so designed 400/409 bodies survive", async () => {
    const { client, fetchMock } = clientWithBody({
      applied: true,
      restart: false,
      keys: ["ELIZA_CODEX_MODEL_POWERFUL"],
    });
    await client.updateModelsConfig({
      target: "coding",
      backend: "codex",
      model: "gpt-5.6-terra",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/models/config",
      {
        method: "POST",
        body: JSON.stringify({
          target: "coding",
          backend: "codex",
          model: "gpt-5.6-terra",
        }),
      },
      { allowNonOk: true },
    );
  });

  it("normalizes an applied restart write", async () => {
    const { client } = clientWithBody({
      applied: true,
      restart: true,
      operationId: "op-1",
      keys: ["OPENAI_SMALL_MODEL"],
      conflictingServiceEnvKeys: ["OPENAI_SMALL_MODEL"],
    });
    const result = await client.updateModelsConfig({
      target: "small",
      provider: "cerebras",
      model: "gemma-4-31b",
    });
    expect(result).toEqual({
      kind: "applied",
      restart: true,
      operationId: "op-1",
      keys: ["OPENAI_SMALL_MODEL"],
      conflictingServiceEnvKeys: ["OPENAI_SMALL_MODEL"],
    });
  });

  it("treats a deduped restart (applied:false) as an applied outcome", async () => {
    const { client } = clientWithBody({
      applied: false,
      restart: true,
      operationId: "op-2",
      keys: ["ANTHROPIC_LARGE_MODEL"],
      deduped: true,
    });
    const result = await client.updateModelsConfig({
      target: "large",
      provider: "claude-chat",
      model: "claude-opus-4-8",
    });
    expect(result).toEqual({
      kind: "applied",
      restart: true,
      operationId: "op-2",
      keys: ["ANTHROPIC_LARGE_MODEL"],
      deduped: true,
    });
  });

  it("normalizes the typed 400 body into an invalid outcome with context", async () => {
    const { client } = clientWithBody({
      error: 'Effort "ultra" is valid for gpt-5.6-terra but not parseable',
      code: "MODEL_CONFIG_INVALID",
      context: {
        model: "gpt-5.6-terra",
        effort: "ultra",
        supported: ["low", "medium", "high", "xhigh"],
      },
    });
    const result = await client.updateModelsConfig({
      target: "coding",
      backend: "codex",
      model: "gpt-5.6-terra",
      effort: "ultra",
    });
    expect(result).toEqual({
      kind: "invalid",
      error: 'Effort "ultra" is valid for gpt-5.6-terra but not parseable',
      supported: ["low", "medium", "high", "xhigh"],
    });
  });

  it("normalizes the 409 body into a busy outcome", async () => {
    const { client } = clientWithBody({
      error: "A runtime operation is already in progress",
      activeOperationId: "op-9",
    });
    const result = await client.updateModelsConfig({
      target: "small",
      provider: "cerebras",
      model: "gemma-4-31b",
    });
    expect(result).toEqual({
      kind: "busy",
      error: "A runtime operation is already in progress",
      activeOperationId: "op-9",
    });
  });

  it("throws a typed ApiError on an unrecognized failure body", async () => {
    const { client } = clientWithBody({ error: "Model config update failed" });
    await expect(
      client.updateModelsConfig({
        target: "small",
        provider: "cerebras",
        model: "gemma-4-31b",
      }),
    ).rejects.toThrowError(ApiError);
  });
});
