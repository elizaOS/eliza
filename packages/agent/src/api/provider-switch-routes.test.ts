/**
 * Exercises the provider-switch HTTP boundary with real request validation,
 * provider normalization, configuration mutation, and vault persistence.
 * Runtime-operation outcomes are injected so each transport response remains
 * deterministic without starting or restarting a live agent runtime.
 */
import type http from "node:http";
import type { ReadJsonBodyOptions } from "@elizaos/shared";
import type { SecretsManager } from "@elizaos/vault";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import type {
  OperationIntent,
  RuntimeOperation,
  RuntimeOperationManager,
  StartOperationOutcome,
  StartOperationRequest,
} from "../runtime/operations/index.ts";
import {
  handleProviderSwitchRoutes,
  type ProviderSwitchRouteContext,
} from "./provider-switch-routes.ts";

const CLOUD_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
] as const;

const originalCloudEnv = Object.fromEntries(
  CLOUD_ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of CLOUD_ENV_KEYS) {
    const original = originalCloudEnv[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

function operation(
  id: string,
  status: RuntimeOperation["status"] = "pending",
  intent: OperationIntent = { kind: "provider-switch", provider: "openai" },
): RuntimeOperation {
  return {
    id,
    kind: intent.kind,
    intent,
    tier: "cold",
    status,
    phases: [],
    startedAt: 1,
  };
}

function managerReturning(
  outcome: StartOperationOutcome | Error,
): RuntimeOperationManager & { start: ReturnType<typeof vi.fn> } {
  const start = vi.fn(async (request: StartOperationRequest) => {
    if (outcome instanceof Error) throw outcome;
    if (outcome.kind === "accepted") {
      const preparedIntent = await request.prepare?.();
      if (preparedIntent) outcome.operation.intent = preparedIntent;
    }
    return outcome;
  });

  return {
    start,
    get: vi.fn(async () => null),
    list: vi.fn(async () => []),
    findActive: vi.fn(async () => null),
  };
}

function memorySecrets(): {
  secrets: SecretsManager;
  set: ReturnType<typeof vi.fn>;
  reveal: ReturnType<typeof vi.fn>;
} {
  const values = new Map<string, string>();
  const set = vi.fn(
    async (key: string, value: string) => void values.set(key, value),
  );
  const reveal = vi.fn(async (key: string) => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`Missing secret: ${key}`);
    return value;
  });
  return {
    secrets: { vault: { set, reveal } } as unknown as SecretsManager,
    set,
    reveal,
  };
}

function makeContext(args: {
  method?: string;
  pathname?: string;
  body?: Record<string, unknown> | null;
  headers?: http.IncomingHttpHeaders;
  manager?: RuntimeOperationManager;
  secretsManager?: SecretsManager;
}) {
  const config = {} as ElizaConfig;
  const json = vi.fn();
  const error = vi.fn();
  const readJsonBody = vi.fn();
  const readJsonBodyForContext: ProviderSwitchRouteContext["readJsonBody"] =
    async <T extends object>(
      req: http.IncomingMessage,
      res: http.ServerResponse,
      options?: ReadJsonBodyOptions,
    ) => {
      readJsonBody(req, res, options);
      return (args.body ?? null) as T | null;
    };
  const saveElizaConfig = vi.fn();
  const req = { headers: args.headers ?? {} } as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const ctx: ProviderSwitchRouteContext = {
    req,
    res,
    method: args.method ?? "POST",
    pathname: args.pathname ?? "/api/provider/switch",
    state: { config },
    json,
    error,
    readJsonBody: readJsonBodyForContext,
    saveElizaConfig,
    scheduleRuntimeRestart: vi.fn(),
    runtimeOperationManager:
      args.manager ??
      managerReturning({
        kind: "accepted",
        operation: operation("op-default"),
      }),
    ...(args.secretsManager ? { secretsManager: args.secretsManager } : {}),
  };
  return { ctx, config, json, error, readJsonBody, saveElizaConfig };
}

describe("handleProviderSwitchRoutes", () => {
  it("ignores methods and paths outside the provider-switch route", async () => {
    const { ctx, readJsonBody } = makeContext({
      method: "GET",
      pathname: "/api/provider/switch",
    });

    await expect(handleProviderSwitchRoutes(ctx)).resolves.toBe(false);
    expect(readJsonBody).not.toHaveBeenCalled();
  });

  it("treats an already-handled null body as a matched route", async () => {
    const { ctx, json, error } = makeContext({ body: null });

    await expect(handleProviderSwitchRoutes(ctx)).resolves.toBe(true);
    expect(json).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("rejects malformed request bodies before starting an operation", async () => {
    const manager = managerReturning({
      kind: "accepted",
      operation: operation("op-unused"),
    });
    const { ctx, error } = makeContext({ body: {}, manager });

    await expect(handleProviderSwitchRoutes(ctx)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Invalid input: expected string, received undefined",
      400,
    );
    expect(manager.start).not.toHaveBeenCalled();
  });

  it("rejects provider names outside the supported catalog", async () => {
    const manager = managerReturning({
      kind: "accepted",
      operation: operation("op-unused"),
    });
    const { ctx, error } = makeContext({
      body: { provider: "not-a-provider" },
      manager,
    });

    await expect(handleProviderSwitchRoutes(ctx)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(ctx.res, "Invalid provider", 400);
    expect(manager.start).not.toHaveBeenCalled();
  });

  it("normalizes the provider, trims the idempotency key, and prepares config", async () => {
    const manager = managerReturning({
      kind: "accepted",
      operation: operation("op-accepted"),
    });
    const { ctx, config, json, error, saveElizaConfig } = makeContext({
      body: {
        provider: " @elizaos/plugin-openai ",
        primaryModel: " gpt-5.6 ",
      },
      headers: { "idempotency-key": " retry-42 " },
      manager,
    });

    await expect(handleProviderSwitchRoutes(ctx)).resolves.toBe(true);

    const request = manager.start.mock.calls[0]?.[0] as StartOperationRequest;
    expect(request.intent).toEqual({
      kind: "provider-switch",
      provider: "openai",
      primaryModel: "gpt-5.6",
    });
    expect(request.idempotencyKey).toBe("retry-42");
    expect(config.agents?.defaults?.model?.primary).toBe("gpt-5.6");
    expect(saveElizaConfig).toHaveBeenCalledWith(config);
    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      {
        success: true,
        provider: "openai",
        restarting: true,
        operationId: "op-accepted",
      },
      202,
    );
  });

  it("persists a trimmed API key and passes only its vault reference to the operation", async () => {
    const { secrets, set, reveal } = memorySecrets();
    const accepted = operation("op-secret");
    const manager = managerReturning({ kind: "accepted", operation: accepted });
    const { ctx } = makeContext({
      body: { provider: "openai", apiKey: " sk-secret " },
      manager,
      secretsManager: secrets,
    });

    await expect(handleProviderSwitchRoutes(ctx)).resolves.toBe(true);

    expect(set).toHaveBeenCalledWith("providers.openai.api-key", "sk-secret", {
      caller: "provider-switch-route",
      sensitive: true,
    });
    expect(reveal).toHaveBeenCalledWith(
      "providers.openai.api-key",
      "provider-switch-route:verify",
    );
    expect(accepted.intent).toEqual({
      kind: "provider-switch",
      provider: "openai",
      apiKeyRef: "providers.openai.api-key",
    });
    expect(accepted.intent).not.toHaveProperty("apiKey");
  });

  it("applies the elizacloud proxy environment before accepting", async () => {
    const { secrets } = memorySecrets();
    const manager = managerReturning({
      kind: "accepted",
      operation: operation("op-cloud"),
    });
    const { ctx, config } = makeContext({
      body: { provider: "elizacloud", apiKey: "cloud-key" },
      manager,
      secretsManager: secrets,
    });

    await expect(handleProviderSwitchRoutes(ctx)).resolves.toBe(true);

    expect(process.env.OPENAI_BASE_URL).toBe("https://cloud.eliza.app/api/v1");
    expect(process.env.ANTHROPIC_BASE_URL).toBe(
      "https://cloud.eliza.app/api/v1",
    );
    expect(process.env.OPENAI_API_KEY).toBe("cloud-key");
    expect(process.env.ANTHROPIC_API_KEY).toBe("cloud-key");
    expect(config.cloud?.apiKey).toBe("cloud-key");
  });

  it.each([
    ["pending", true],
    ["running", true],
    ["succeeded", false],
  ] as const)(
    "reports a deduped %s operation with restarting=%s",
    async (status, restarting) => {
      const manager = managerReturning({
        kind: "deduped",
        operation: operation("op-existing", status),
      });
      const { ctx, json, saveElizaConfig } = makeContext({
        body: { provider: "openai" },
        manager,
      });

      await expect(handleProviderSwitchRoutes(ctx)).resolves.toBe(true);

      expect(saveElizaConfig).not.toHaveBeenCalled();
      expect(json).toHaveBeenCalledWith(ctx.res, {
        success: true,
        provider: "openai",
        restarting,
        operationId: "op-existing",
        deduped: true,
      });
    },
  );

  it("returns the active operation when the single-flight gate is busy", async () => {
    const manager = managerReturning({
      kind: "rejected-busy",
      activeOperationId: "op-active",
    });
    const { ctx, json, saveElizaConfig } = makeContext({
      body: { provider: "openai" },
      manager,
    });

    await expect(handleProviderSwitchRoutes(ctx)).resolves.toBe(true);
    expect(saveElizaConfig).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      {
        error: "Provider switch already in progress",
        activeOperationId: "op-active",
      },
      409,
    );
  });

  it("returns the specific vault failure without accepting an operation", async () => {
    const secrets = {
      vault: {
        set: vi.fn(async () => {
          throw new Error("keychain unavailable");
        }),
      },
    } as unknown as SecretsManager;
    const manager = managerReturning({
      kind: "accepted",
      operation: operation("op-unused"),
    });
    const { ctx, error, json } = makeContext({
      body: { provider: "openai", apiKey: "secret" },
      manager,
      secretsManager: secrets,
    });

    await expect(handleProviderSwitchRoutes(ctx)).resolves.toBe(true);
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(ctx.res, "Vault write failed", 500);
  });

  it("translates unexpected operation failures to the generic boundary error", async () => {
    const manager = managerReturning(new Error("repository unavailable"));
    const { ctx, error, json } = makeContext({
      body: { provider: "openai" },
      manager,
    });

    await expect(handleProviderSwitchRoutes(ctx)).resolves.toBe(true);
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(ctx.res, "Provider switch failed", 500);
  });
});
