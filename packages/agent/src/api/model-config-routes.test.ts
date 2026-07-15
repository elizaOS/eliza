/**
 * Unit tests for GET/POST /api/models/config: catalog-backed validation
 * rejections, the dual-seam config write (config.env + config.env.vars +
 * process.env), restart semantics per target (chat restarts via the operation
 * manager, coding does not), external-env conflict reporting, and the GET
 * resolution order. Deterministic — catalog, process env, save, and the
 * operation manager are injected; no live runtime or filesystem is touched.
 */
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config";
import { buildModelCatalog } from "./model-catalog";
import { handleModelConfigRoutes } from "./model-config-routes";

const catalog = buildModelCatalog({
  readFile: () => {
    throw new Error("ENOENT");
  },
  env: {} as NodeJS.ProcessEnv,
});

interface HarnessOptions {
  config?: ElizaConfig;
  processEnv?: NodeJS.ProcessEnv;
  managerStart?: ReturnType<typeof vi.fn>;
}

function makeHarness(
  method: string,
  body: Record<string, unknown> | null,
  opts: HarnessOptions = {},
) {
  const config: ElizaConfig = opts.config ?? {};
  const processEnv: NodeJS.ProcessEnv = opts.processEnv ?? {};
  const json = vi.fn();
  const saveElizaConfig = vi.fn();
  const managerStart =
    opts.managerStart ??
    vi.fn(async (req: { prepare?: () => Promise<unknown> }) => {
      await req.prepare?.();
      return {
        kind: "accepted",
        operation: { id: "op-1" },
      };
    });
  const ctx = {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method,
    pathname: "/api/models/config",
    json,
    readJsonBody: vi.fn(async () => body),
    state: { config },
    saveElizaConfig,
    runtimeOperationManager: { start: managerStart } as never,
    catalog,
    processEnv,
  };
  return { ctx, json, saveElizaConfig, managerStart, config, processEnv };
}

function responseOf(json: ReturnType<typeof vi.fn>) {
  const call = json.mock.calls[0];
  if (!call) throw new Error("json was not called");
  return {
    body: call[1] as Record<string, unknown>,
    status: call[2] as number | undefined,
  };
}

describe("POST /api/models/config validation", () => {
  it("rejects ultra on gpt-5.6-luna", async () => {
    const { ctx, json, saveElizaConfig } = makeHarness("POST", {
      target: "coding",
      backend: "codex",
      model: "gpt-5.6-luna",
      effort: "ultra",
    });
    await expect(handleModelConfigRoutes(ctx as never)).resolves.toBe(true);
    const { body, status } = responseOf(json);
    expect(status).toBe(400);
    expect(body.code).toBe("MODEL_CONFIG_INVALID");
    expect(String(body.error)).toContain("ultra");
    expect(saveElizaConfig).not.toHaveBeenCalled();
  });

  it("rejects any effort on haiku via claude-chat (no chat effort knob)", async () => {
    const { ctx, json } = makeHarness("POST", {
      target: "small",
      provider: "claude-chat",
      model: "claude-haiku-4-5-20251001",
      effort: "high",
    });
    await handleModelConfigRoutes(ctx as never);
    const { body, status } = responseOf(json);
    expect(status).toBe(400);
    expect(body.code).toBe("MODEL_CONFIG_INVALID");
    expect(String(body.error)).toContain("no effort control");
  });

  // gemma carries a live-proven low/medium/high knob (2026-07-12 probe), so
  // effort validation on it rejects values outside that list, not all effort.
  it("rejects an effort outside gemma's supported list", async () => {
    const { ctx, json } = makeHarness("POST", {
      target: "small",
      provider: "cerebras",
      model: "gemma-4-31b",
      effort: "xhigh",
    });
    await handleModelConfigRoutes(ctx as never);
    const { body, status } = responseOf(json);
    expect(status).toBe(400);
    expect(String(body.error)).toContain("not supported by model");
  });

  it("rejects an unknown model for the provider", async () => {
    const { ctx, json } = makeHarness("POST", {
      target: "large",
      provider: "cerebras",
      model: "made-up-model",
    });
    await handleModelConfigRoutes(ctx as never);
    const { body, status } = responseOf(json);
    expect(status).toBe(400);
    expect(String(body.error)).toContain("Unknown model");
  });

  it("rejects a chat target carrying a coding backend (target/backend mismatch)", async () => {
    const { ctx, json } = makeHarness("POST", {
      target: "large",
      backend: "codex",
      model: "gpt-5.6-terra",
    });
    await handleModelConfigRoutes(ctx as never);
    const { body, status } = responseOf(json);
    expect(status).toBe(400);
    expect(String(body.error)).toContain("coding-target field");
  });

  it("rejects target coding without a backend", async () => {
    const { ctx, json } = makeHarness("POST", {
      target: "coding",
      model: "gpt-5.6-terra",
    });
    await handleModelConfigRoutes(ctx as never);
    const { status, body } = responseOf(json);
    expect(status).toBe(400);
    expect(String(body.error)).toContain("requires backend");
  });

  it("rejects a gemma large write (role mismatch on cerebras)", async () => {
    const { ctx, json } = makeHarness("POST", {
      target: "large",
      provider: "cerebras",
      model: "gemma-4-31b",
    });
    await handleModelConfigRoutes(ctx as never);
    const { status, body } = responseOf(json);
    expect(status).toBe(400);
    expect(String(body.error)).toContain("not offered");
  });

  it("rejects an ambiguous model when provider is omitted", async () => {
    const { ctx, json } = makeHarness("POST", {
      target: "large",
      model: "gpt-oss-120b",
    });
    await handleModelConfigRoutes(ctx as never);
    const { status, body } = responseOf(json);
    expect(status).toBe(400);
    expect(String(body.error)).toContain("multiple providers");
  });

  it("rejects effort on backends without an effort seam", async () => {
    const { ctx, json } = makeHarness("POST", {
      target: "coding",
      backend: "opencode",
      model: "cerebras/gpt-oss-120b",
      effort: "high",
    });
    await handleModelConfigRoutes(ctx as never);
    const { status, body } = responseOf(json);
    expect(status).toBe(400);
    expect(String(body.error)).toContain("no effort control");
  });
});

describe("POST /api/models/config chat writes", () => {
  it("writes both config seams + process.env and requests a restart", async () => {
    const { ctx, json, saveElizaConfig, managerStart, config, processEnv } =
      makeHarness("POST", {
        target: "large",
        provider: "cerebras",
        model: "gpt-oss-120b",
        effort: "high",
      });
    await handleModelConfigRoutes(ctx as never);

    const env = (config as Record<string, unknown>).env as Record<
      string,
      unknown
    > & { vars: Record<string, string> };
    expect(env.OPENAI_LARGE_MODEL).toBe("gpt-oss-120b");
    expect(env.vars.OPENAI_LARGE_MODEL).toBe("gpt-oss-120b");
    expect(processEnv.OPENAI_LARGE_MODEL).toBe("gpt-oss-120b");
    expect(env.OPENAI_REASONING_EFFORT).toBe("high");
    expect(env.vars.OPENAI_REASONING_EFFORT).toBe("high");
    expect(processEnv.OPENAI_REASONING_EFFORT).toBe("high");
    expect(saveElizaConfig).toHaveBeenCalledWith(config);
    expect(managerStart).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({ kind: "restart" }),
      }),
    );
    const { body } = responseOf(json);
    expect(body).toMatchObject({
      applied: true,
      restart: true,
      operationId: "op-1",
    });
  });

  it("writes ANTHROPIC keys (model + per-target effort) for claude-chat", async () => {
    // sonnet-5, not haiku: haiku carries no chat effort knob (live-probed).
    const { ctx, config, processEnv } = makeHarness("POST", {
      target: "small",
      provider: "claude-chat",
      model: "claude-sonnet-5",
      effort: "high",
    });
    await handleModelConfigRoutes(ctx as never);
    const env = (config as Record<string, unknown>).env as Record<
      string,
      unknown
    >;
    expect(env.ANTHROPIC_SMALL_MODEL).toBe("claude-sonnet-5");
    expect(env.ANTHROPIC_EFFORT_SMALL).toBe("high");
    expect(processEnv.ANTHROPIC_EFFORT_SMALL).toBe("high");
  });

  it("writes ELIZAOS_CLOUD keys (model + shared effort) for elizacloud", async () => {
    // Under cloud-proxy routing plugin-elizacloud owns chat and reads only the
    // ELIZAOS_CLOUD_* family — an OPENAI_* write here would be silently inert.
    const { ctx, config, processEnv } = makeHarness("POST", {
      target: "large",
      provider: "elizacloud",
      model: "zai-glm-4.7",
      effort: "high",
    });
    await handleModelConfigRoutes(ctx as never);
    const env = (config as Record<string, unknown>).env as Record<
      string,
      unknown
    > & { vars: Record<string, string> };
    expect(env.ELIZAOS_CLOUD_LARGE_MODEL).toBe("zai-glm-4.7");
    expect(env.vars.ELIZAOS_CLOUD_LARGE_MODEL).toBe("zai-glm-4.7");
    expect(processEnv.ELIZAOS_CLOUD_LARGE_MODEL).toBe("zai-glm-4.7");
    expect(env.ELIZAOS_CLOUD_REASONING_EFFORT).toBe("high");
    expect(processEnv.ELIZAOS_CLOUD_REASONING_EFFORT).toBe("high");
    expect(env.OPENAI_LARGE_MODEL).toBeUndefined();
  });

  it("resolves an ambiguous model to the ACTIVE chat provider", async () => {
    // gpt-oss-120b is offered by both cerebras and elizacloud; with cloud-proxy
    // routing live the bare write must land on the cloud family, not 400.
    const { ctx, json, config } = makeHarness(
      "POST",
      { target: "large", model: "gpt-oss-120b" },
      {
        config: {
          serviceRouting: {
            llmText: {
              backend: "elizacloud",
              transport: "cloud-proxy",
              accountId: "elizacloud",
            },
          },
        } as never,
      },
    );
    await handleModelConfigRoutes(ctx as never);
    const { status } = responseOf(json);
    expect(status).toBeUndefined();
    const env = (config as Record<string, unknown>).env as Record<
      string,
      unknown
    >;
    expect(env.ELIZAOS_CLOUD_LARGE_MODEL).toBe("gpt-oss-120b");
    expect(env.OPENAI_LARGE_MODEL).toBeUndefined();
  });

  it("returns 409 without writing when the runtime is busy", async () => {
    const managerStart = vi.fn(async () => ({
      kind: "rejected-busy",
      activeOperationId: "op-active",
    }));
    const { ctx, json, saveElizaConfig, config } = makeHarness(
      "POST",
      { target: "large", provider: "elizacloud", model: "zai-glm-4.7" },
      { managerStart },
    );
    await handleModelConfigRoutes(ctx as never);
    const { status, body } = responseOf(json);
    expect(status).toBe(409);
    expect(body.activeOperationId).toBe("op-active");
    expect(saveElizaConfig).not.toHaveBeenCalled();
    expect((config as Record<string, unknown>).env).toBeUndefined();
  });

  it("reports keys whose prior process.env value came from outside the config", async () => {
    const { ctx, json } = makeHarness(
      "POST",
      { target: "large", provider: "cerebras", model: "zai-glm-4.7" },
      {
        // service.env-style value: present in process.env, absent from config.
        processEnv: { OPENAI_LARGE_MODEL: "llama-x-from-service-env" },
      },
    );
    await handleModelConfigRoutes(ctx as never);
    const { body } = responseOf(json);
    expect(body.conflictingServiceEnvKeys).toEqual(["OPENAI_LARGE_MODEL"]);
  });

  it("does not flag a conflict when process.env just mirrors the old config value", async () => {
    const { ctx, json } = makeHarness(
      "POST",
      { target: "large", provider: "cerebras", model: "zai-glm-4.7" },
      {
        config: {
          env: { vars: { OPENAI_LARGE_MODEL: "gpt-oss-120b" } },
        } as ElizaConfig,
        processEnv: { OPENAI_LARGE_MODEL: "gpt-oss-120b" },
      },
    );
    await handleModelConfigRoutes(ctx as never);
    const { body } = responseOf(json);
    expect(body.conflictingServiceEnvKeys).toBeUndefined();
  });
});

describe("POST /api/models/config coding writes", () => {
  it("writes codex model + effort without a restart", async () => {
    const { ctx, json, saveElizaConfig, managerStart, config, processEnv } =
      makeHarness("POST", {
        target: "coding",
        backend: "codex",
        model: "gpt-5.6-terra",
        effort: "xhigh",
      });
    await handleModelConfigRoutes(ctx as never);

    const env = (config as Record<string, unknown>).env as Record<
      string,
      unknown
    > & { vars: Record<string, string> };
    expect(env.ELIZA_CODEX_MODEL_POWERFUL).toBe("gpt-5.6-terra");
    expect(env.vars.ELIZA_CODEX_MODEL_POWERFUL).toBe("gpt-5.6-terra");
    expect(processEnv.ELIZA_CODEX_MODEL_POWERFUL).toBe("gpt-5.6-terra");
    expect(env.ELIZA_CODEX_EFFORT).toBe("xhigh");
    expect(saveElizaConfig).toHaveBeenCalledWith(config);
    expect(managerStart).not.toHaveBeenCalled();
    const { body } = responseOf(json);
    expect(body).toMatchObject({ applied: true, restart: false });
  });

  it("accepts a free-form opencode model and a defaultBackend switch", async () => {
    const { ctx, config } = makeHarness("POST", {
      target: "coding",
      backend: "opencode",
      model: "cerebras/gpt-oss-120b",
      defaultBackend: "opencode",
    });
    await handleModelConfigRoutes(ctx as never);
    const env = (config as Record<string, unknown>).env as Record<
      string,
      unknown
    >;
    expect(env.ELIZA_OPENCODE_MODEL_POWERFUL).toBe("cerebras/gpt-oss-120b");
    expect(env.ELIZA_DEFAULT_AGENT_TYPE).toBe("opencode");
  });

  it("persists defaultBackend eliza-code under the orchestrator's elizaos spelling", async () => {
    const { ctx, config } = makeHarness("POST", {
      target: "coding",
      backend: "eliza-code",
      model: "eliza-local",
      defaultBackend: "eliza-code",
    });
    await handleModelConfigRoutes(ctx as never);
    const env = (config as Record<string, unknown>).env as Record<
      string,
      unknown
    >;
    expect(env.ELIZA_ELIZAOS_MODEL_POWERFUL).toBe("eliza-local");
    expect(env.ELIZA_DEFAULT_AGENT_TYPE).toBe("elizaos");
  });

  it("validates claude coding models against the claude-coding catalog", async () => {
    const { ctx, json } = makeHarness("POST", {
      target: "coding",
      backend: "claude",
      model: "claude-nonexistent-9",
    });
    await handleModelConfigRoutes(ctx as never);
    const { status } = responseOf(json);
    expect(status).toBe(400);
  });
});

describe("POST /api/models/config defaultBackend-only writes", () => {
  it("persists ELIZA_DEFAULT_AGENT_TYPE to all three seams without a restart", async () => {
    const { ctx, json, saveElizaConfig, managerStart, config, processEnv } =
      makeHarness("POST", { target: "coding", defaultBackend: "codex" });
    await handleModelConfigRoutes(ctx as never);

    const env = (config as Record<string, unknown>).env as Record<
      string,
      unknown
    > & { vars: Record<string, string> };
    expect(env.ELIZA_DEFAULT_AGENT_TYPE).toBe("codex");
    expect(env.vars.ELIZA_DEFAULT_AGENT_TYPE).toBe("codex");
    expect(processEnv.ELIZA_DEFAULT_AGENT_TYPE).toBe("codex");
    expect(saveElizaConfig).toHaveBeenCalledWith(config);
    expect(managerStart).not.toHaveBeenCalled();
    const { body } = responseOf(json);
    expect(body).toMatchObject({
      applied: true,
      restart: false,
      keys: ["ELIZA_DEFAULT_AGENT_TYPE"],
    });
  });

  it("maps a modelless eliza-code switch to the orchestrator's elizaos spelling", async () => {
    const { ctx, config } = makeHarness("POST", {
      target: "coding",
      defaultBackend: "eliza-code",
    });
    await handleModelConfigRoutes(ctx as never);
    const env = (config as Record<string, unknown>).env as Record<
      string,
      unknown
    >;
    expect(env.ELIZA_DEFAULT_AGENT_TYPE).toBe("elizaos");
  });

  it("rejects an unknown defaultBackend without writing", async () => {
    const { ctx, json, saveElizaConfig } = makeHarness("POST", {
      target: "coding",
      defaultBackend: "vscode",
    });
    await handleModelConfigRoutes(ctx as never);
    const { body, status } = responseOf(json);
    expect(status).toBe(400);
    expect(String(body.error)).toContain("Unknown defaultBackend");
    expect(saveElizaConfig).not.toHaveBeenCalled();
  });

  it("rejects model-seam fields on a modelless write", async () => {
    const { ctx, json } = makeHarness("POST", {
      target: "coding",
      backend: "codex",
      defaultBackend: "codex",
    });
    await handleModelConfigRoutes(ctx as never);
    const { body, status } = responseOf(json);
    expect(status).toBe(400);
    expect(String(body.error)).toContain("defaultBackend-only write");
  });

  it("still requires model for chat targets even with defaultBackend", async () => {
    const { ctx, json } = makeHarness("POST", {
      target: "large",
      defaultBackend: "codex",
    });
    await handleModelConfigRoutes(ctx as never);
    const { body, status } = responseOf(json);
    expect(status).toBe(400);
    expect(String(body.error)).toContain("model must be a non-empty string");
  });
});

describe("GET /api/models/config resolution order", () => {
  it("reports which source won per key: config.env > config.env.vars > process.env", async () => {
    const { ctx, json } = makeHarness("GET", null, {
      config: {
        env: {
          OPENAI_LARGE_MODEL: "direct-model",
          vars: {
            OPENAI_LARGE_MODEL: "vars-model",
            OPENAI_SMALL_MODEL: "vars-small",
          },
        },
      } as ElizaConfig,
      processEnv: {
        OPENAI_SMALL_MODEL: "proc-small",
        ELIZA_CLAUDE_MODEL_POWERFUL: "claude-opus-4-7",
      },
    });
    await handleModelConfigRoutes(ctx as never);
    const { body } = responseOf(json);
    const targets = body.targets as Record<
      string,
      Record<string, { value: string; source: string } | null>
    >;
    expect(targets.large?.OPENAI_LARGE_MODEL).toEqual({
      value: "direct-model",
      source: "config.env",
    });
    expect(targets.small?.OPENAI_SMALL_MODEL).toEqual({
      value: "vars-small",
      source: "config.env.vars",
    });
    expect(targets.coding?.ELIZA_CLAUDE_MODEL_POWERFUL).toEqual({
      value: "claude-opus-4-7",
      source: "process.env",
    });
    expect(targets.small?.ANTHROPIC_SMALL_MODEL).toBeNull();
  });

  it("falls back to the user-approved coding defaults when unset", async () => {
    const { ctx, json } = makeHarness("GET", null);
    await handleModelConfigRoutes(ctx as never);
    const { body } = responseOf(json);
    const targets = body.targets as Record<
      string,
      Record<string, { value: string; source: string } | null>
    >;
    expect(targets.coding?.ELIZA_CODEX_MODEL_POWERFUL).toEqual({
      value: "gpt-5.6-sol",
      source: "default",
    });
    expect(targets.coding?.ELIZA_CLAUDE_MODEL_POWERFUL).toEqual({
      value: "claude-opus-4-8",
      source: "default",
    });
  });
});

describe("GET /api/models/config activeChat", () => {
  const cloudRoutedConfig = {
    serviceRouting: {
      llmText: {
        backend: "elizacloud",
        transport: "cloud-proxy",
        accountId: "elizacloud",
      },
    },
  } as never;

  it("names the cloud brain + its endpoint under cloud-proxy routing", async () => {
    const { ctx, json } = makeHarness("GET", null, {
      config: cloudRoutedConfig,
      processEnv: {
        // Inert for chat under cloud-proxy — must NOT leak into the endpoint.
        OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
        ELIZAOS_CLOUD_BASE_URL: "https://elizacloud.ai/api/v1",
      },
    });
    await handleModelConfigRoutes(ctx as never);
    const { body } = responseOf(json);
    expect(body.activeChat).toEqual({
      provider: "elizacloud",
      family: "ELIZAOS_CLOUD",
      endpoint: "elizacloud.ai",
    });
    const targets = body.targets as Record<
      string,
      Record<string, { value: string; source: string } | null>
    >;
    // Unpinned cloud tiers report the plugin's code defaults so the operator
    // sees what actually serves — small gemma, large GLM (genuinely larger).
    expect(targets.small?.ELIZAOS_CLOUD_SMALL_MODEL).toEqual({
      value: "gemma-4-31b",
      source: "default",
    });
    expect(targets.large?.ELIZAOS_CLOUD_LARGE_MODEL).toEqual({
      value: "zai-glm-4.7",
      source: "default",
    });
  });

  it("names the direct provider endpoint under cerebras routing and omits cloud defaults", async () => {
    const { ctx, json } = makeHarness("GET", null, {
      config: {
        serviceRouting: {
          llmText: {
            backend: "cerebras",
            transport: "direct",
            accountId: "cerebras",
          },
        },
      } as never,
      processEnv: { OPENAI_BASE_URL: "https://api.cerebras.ai/v1" },
    });
    await handleModelConfigRoutes(ctx as never);
    const { body } = responseOf(json);
    expect(body.activeChat).toEqual({
      provider: "cerebras",
      family: "OPENAI",
      endpoint: "api.cerebras.ai",
    });
    const targets = body.targets as Record<
      string,
      Record<string, { value: string; source: string } | null>
    >;
    expect(targets.small?.ELIZAOS_CLOUD_SMALL_MODEL).toBeNull();
    expect(targets.large?.ELIZAOS_CLOUD_LARGE_MODEL).toBeNull();
  });

  it("omits activeChat when no routing is configured", async () => {
    const { ctx, json } = makeHarness("GET", null);
    await handleModelConfigRoutes(ctx as never);
    const { body } = responseOf(json);
    expect(body.activeChat).toBeUndefined();
  });
});

describe("route matching", () => {
  it("declines other paths and methods", async () => {
    const { ctx } = makeHarness("PUT", { target: "large", model: "x" });
    await expect(handleModelConfigRoutes(ctx as never)).resolves.toBe(false);
    const other = makeHarness("GET", null);
    other.ctx.pathname = "/api/models";
    await expect(handleModelConfigRoutes(other.ctx as never)).resolves.toBe(
      false,
    );
  });
});

describe("managed codex-acp effort contract", () => {
  it("rejects ultra even when the selected model advertises it", async () => {
    const { ctx, json, saveElizaConfig } = makeHarness("POST", {
      target: "coding",
      backend: "codex",
      model: "gpt-5.6-terra",
      effort: "ultra",
    });
    await expect(handleModelConfigRoutes(ctx as never)).resolves.toBe(true);
    const { body, status } = responseOf(json);
    expect(status).toBe(400);
    expect(String(body.error)).toContain("managed codex-acp contract");
    expect(String(body.error)).toContain("low, medium, high, xhigh");
    expect(saveElizaConfig).not.toHaveBeenCalled();
  });
});
