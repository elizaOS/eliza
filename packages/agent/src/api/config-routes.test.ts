/**
 * PUT /api/config nest bound. Recursive strip/safeMerge stack limits are
 * runtime-dependent, so structurally excessive patches are rejected by the
 * canonical blocked-object-key walker before those consumers run.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetDevCloudEnvAuthorityForTests,
  resolveDevCloudEnvAuthority,
} from "../config/dev-cloud-env-authority";
import {
  type ConfigRouteContext,
  configPatchExceedsBound,
  handleConfigRoutes,
  MAX_CONFIG_PATCH_DEPTH,
} from "./config-routes";

/** N container wrappers around a scalar leaf — matches the canonical walker. */
function nest(depth: number): Record<string, unknown> {
  let node: unknown = "leaf";
  for (let i = 0; i < depth; i++) {
    node = { n: node };
  }
  return node as Record<string, unknown>;
}

function makeCtx(
  body: Record<string, unknown>,
  strip: ConfigRouteContext["stripRedactedPlaceholderValuesDeep"],
  options: {
    config?: ConfigRouteContext["config"];
    allowedTopKeys?: string[];
  } = {},
): {
  ctx: ConfigRouteContext;
  error: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const error = vi.fn();
  const json = vi.fn();
  const ctx: ConfigRouteContext = {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "PUT",
    pathname: "/api/config",
    url: new URL("http://127.0.0.1/api/config"),
    config: options.config ?? {},
    runtime: null,
    json,
    error,
    readJsonBody: async () => body as never,
    redactConfigSecrets: (value) => value,
    isBlockedObjectKey: () => false,
    stripRedactedPlaceholderValuesDeep: strip,
    patchTouchesProviderSelection: () => false,
    isBlockedEnvKey: () => false,
    CONFIG_WRITE_ALLOWED_TOP_KEYS: new Set(
      options.allowedTopKeys ?? ["ui", "env"],
    ),
    resolveMcpServersRejection: async () => null,
    resolveMcpTerminalAuthorizationRejection: () => null,
  };
  return { ctx, error, json };
}

describe("config patch nest bound", () => {
  it("accepts a shallow honest patch", () => {
    expect(configPatchExceedsBound({ ui: { theme: "dark" } })).toBe(false);
    expect(
      configPatchExceedsBound({ ui: nest(MAX_CONFIG_PATCH_DEPTH - 4) }),
    ).toBe(false);
  });

  it("pins the canonical depth contract: 32 accepted, 33 rejected", () => {
    expect(configPatchExceedsBound(nest(32))).toBe(false);
    expect(configPatchExceedsBound(nest(33))).toBe(true);
  });

  it("rejects a compact nest that recursive strip/merge cannot safely walk", () => {
    expect(configPatchExceedsBound({ ui: nest(8000) })).toBe(true);
    expect(configPatchExceedsBound({ ui: nest(16_000) })).toBe(true);
  });

  it("PUT /api/config returns 400 and never walks an over-nested ui patch", async () => {
    const strip = vi.fn(
      (_value: unknown) => undefined,
    ) as ConfigRouteContext["stripRedactedPlaceholderValuesDeep"];
    const { ctx, error } = makeCtx({ ui: nest(16_000) }, strip);
    const handled = await handleConfigRoutes(ctx);
    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "config patch exceeds the nesting-depth limit",
      400,
    );
    expect(strip).not.toHaveBeenCalled();
  });
});

describe("config patch persistence", () => {
  const envKey = "ELIZA_CONFIG_ROUTE_ATOMICITY_TEST";
  const previousEnvValue = process.env[envKey];
  const previousOpenAIKey = process.env.OPENAI_API_KEY;
  const previousConfigPath = process.env.ELIZA_CONFIG_PATH;
  const authorityEnvKeys = [
    "ELIZA_DEV_SOURCE",
    "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
    "ELIZA_DEV_CLOUD_TARGET",
    "ELIZAOS_CLOUD_API_KEY",
    "ELIZAOS_CLOUD_BASE_URL",
  ] as const;
  const previousAuthorityEnv = Object.fromEntries(
    authorityEnvKeys.map((key) => [key, process.env[key]]),
  );
  let tempDir = "";

  beforeEach(() => {
    resetDevCloudEnvAuthorityForTests();
    for (const key of authorityEnvKeys) delete process.env[key];
    delete process.env.OPENAI_API_KEY;
    tempDir = mkdtempSync(path.join(tmpdir(), "eliza-config-route-"));
    process.env.ELIZA_CONFIG_PATH = path.join(tempDir, "eliza.json");
  });

  afterEach(() => {
    if (previousEnvValue === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = previousEnvValue;
    }
    if (previousConfigPath === undefined) {
      delete process.env.ELIZA_CONFIG_PATH;
    } else {
      process.env.ELIZA_CONFIG_PATH = previousConfigPath;
    }
    if (previousOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAIKey;
    }
    for (const key of authorityEnvKeys) {
      const value = previousAuthorityEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetDevCloudEnvAuthorityForTests();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects a failed save without changing live config or process.env", async () => {
    process.env[envKey] = "before";
    const config: ConfigRouteContext["config"] = {
      ui: { theme: "eliza", seamColor: "#ffffff" },
      env: { vars: { [envKey]: "before" } },
    };
    const before = structuredClone(config);
    const blockedDirectory = path.join(tempDir, "not-a-directory");
    writeFileSync(blockedDirectory, "file blocks config parent");
    process.env.ELIZA_CONFIG_PATH = path.join(blockedDirectory, "eliza.json");
    const { ctx, error, json } = makeCtx(
      {
        ui: { theme: "haxor" },
        env: { vars: { [envKey]: "after" } },
      },
      vi.fn(),
      { config },
    );

    expect(await handleConfigRoutes(ctx)).toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Config update could not be persisted",
      500,
    );
    expect(json).not.toHaveBeenCalled();
    expect(config).toEqual(before);
    expect(process.env[envKey]).toBe("before");
  });

  it("preserves the successful response while committing staged state", async () => {
    process.env[envKey] = "before";
    const config: ConfigRouteContext["config"] = {
      ui: { theme: "eliza", seamColor: "#ffffff" },
      env: { vars: { [envKey]: "before" } },
    };
    const { ctx, error, json } = makeCtx(
      {
        ui: { theme: "haxor" },
        env: { vars: { [envKey]: "after" } },
      },
      vi.fn(),
      { config },
    );

    expect(await handleConfigRoutes(ctx)).toBe(true);
    const expected = {
      ui: { theme: "haxor", seamColor: "#ffffff" },
      env: { vars: { [envKey]: "after" } },
    };
    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(ctx.res, expected);
    expect(config).toEqual(expected);
    expect(process.env[envKey]).toBe("after");
    expect(
      JSON.parse(readFileSync(process.env.ELIZA_CONFIG_PATH as string, "utf8")),
    ).toEqual(expected);
  });

  it("keeps exact responses for two previously-valid patch shapes", async () => {
    const corpus: Array<{
      config: ConfigRouteContext["config"];
      patch: Record<string, unknown>;
      expected: Record<string, unknown>;
    }> = [
      {
        config: { ui: { theme: "eliza", seamColor: "#ffffff" } },
        patch: { ui: { theme: "haxor" } },
        expected: { ui: { theme: "haxor", seamColor: "#ffffff" } },
      },
      {
        config: {
          ui: { theme: "eliza" },
          env: { vars: { [envKey]: "before", EMPTY_VALUE: "" } },
        },
        patch: { env: { vars: { [envKey]: "after" } } },
        expected: {
          ui: { theme: "eliza" },
          env: { vars: { [envKey]: "after" } },
        },
      },
    ];

    for (const entry of corpus) {
      const { ctx, error, json } = makeCtx(entry.patch, vi.fn(), {
        config: structuredClone(entry.config),
      });
      expect(await handleConfigRoutes(ctx)).toBe(true);
      expect(error).not.toHaveBeenCalled();
      expect(json).toHaveBeenCalledWith(ctx.res, entry.expected);
    }
  });

  it("strips forged launcher authority from direct and nested env patches", async () => {
    for (const key of [
      "ELIZA_DEV_SOURCE",
      "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
      "ELIZA_DEV_CLOUD_TARGET",
    ]) {
      delete process.env[key];
    }
    resetDevCloudEnvAuthorityForTests();
    const config: ConfigRouteContext["config"] = {};
    const { ctx, error } = makeCtx(
      {
        env: {
          ELIZA_DEV_SOURCE: "1",
          vars: {
            ELIZA_DEV_CLOUD_ENV_AUTHORITY: "staging-default",
            ELIZA_DEV_CLOUD_TARGET: "production",
            [envKey]: "safe-value",
          },
        },
      },
      vi.fn(),
      { config },
    );

    expect(await handleConfigRoutes(ctx)).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(config.env?.ELIZA_DEV_SOURCE).toBeUndefined();
    expect(config.env?.vars?.ELIZA_DEV_CLOUD_ENV_AUTHORITY).toBeUndefined();
    expect(config.env?.vars?.ELIZA_DEV_CLOUD_TARGET).toBeUndefined();
    expect(process.env.ELIZA_DEV_SOURCE).toBeUndefined();
    expect(process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY).toBeUndefined();
    expect(process.env.ELIZA_DEV_CLOUD_TARGET).toBeUndefined();
    expect(process.env[envKey]).toBe("safe-value");
    expect(resolveDevCloudEnvAuthority()).toBeNull();
  });

  it.each([
    "staging-default",
    "offline",
    "staging-explicit",
    "production",
    "self-hosted",
  ] as const)(
    "does not persist Cloud-owned env edits under %s authority",
    async (authority) => {
      resetDevCloudEnvAuthorityForTests();
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
      process.env.ELIZAOS_CLOUD_BASE_URL =
        authority === "production"
          ? "https://api.eliza.app/api/v1"
          : authority === "self-hosted"
            ? "http://127.0.0.1:8787/api/v1"
            : "https://api-staging.eliza.app/api/v1";
      process.env.ELIZAOS_CLOUD_API_KEY =
        authority === "staging-default" || authority === "offline"
          ? ""
          : "launcher-key";
      expect(resolveDevCloudEnvAuthority()).toBe(authority);

      const config: ConfigRouteContext["config"] = {
        env: {
          ELIZAOS_CLOUD_API_KEY: "durable-production-key",
          vars: {
            ELIZAOS_CLOUD_BASE_URL: "https://durable.example/api/v1",
            ELIZAOS_CLOUD_SMALL_MODEL: "durable-cloud-model",
            [envKey]: "before",
          },
        },
      };
      const durableCloudBefore = structuredClone(config.env);
      const launchBase = process.env.ELIZAOS_CLOUD_BASE_URL;
      const launchKey = process.env.ELIZAOS_CLOUD_API_KEY;
      const { ctx, error } = makeCtx(
        {
          env: {
            ELIZAOS_CLOUD_API_KEY: "late-production-key",
            vars: {
              ELIZAOS_CLOUD_BASE_URL: "https://api.attacker.example/v1",
              ELIZAOS_CLOUD_SMALL_MODEL: "late-cloud-model",
              [envKey]: "safe-after",
            },
          },
        },
        vi.fn(),
        { config },
      );

      expect(await handleConfigRoutes(ctx)).toBe(true);
      expect(error).not.toHaveBeenCalled();
      expect(config.env?.ELIZAOS_CLOUD_API_KEY).toBe(
        durableCloudBefore?.ELIZAOS_CLOUD_API_KEY,
      );
      expect(config.env?.vars?.ELIZAOS_CLOUD_BASE_URL).toBe(
        durableCloudBefore?.vars?.ELIZAOS_CLOUD_BASE_URL,
      );
      expect(config.env?.vars?.ELIZAOS_CLOUD_SMALL_MODEL).toBe(
        durableCloudBefore?.vars?.ELIZAOS_CLOUD_SMALL_MODEL,
      );
      expect(config.env?.vars?.[envKey]).toBe("safe-after");
      expect(process.env[envKey]).toBe("safe-after");
      expect(process.env.ELIZAOS_CLOUD_BASE_URL).toBe(launchBase);
      expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe(launchKey);
      const persisted = JSON.parse(
        readFileSync(process.env.ELIZA_CONFIG_PATH as string, "utf8"),
      ) as ConfigRouteContext["config"];
      expect(persisted.env?.ELIZAOS_CLOUD_API_KEY).toBe(
        durableCloudBefore?.ELIZAOS_CLOUD_API_KEY,
      );
      expect(persisted.env?.vars?.ELIZAOS_CLOUD_BASE_URL).toBe(
        durableCloudBefore?.vars?.ELIZAOS_CLOUD_BASE_URL,
      );
      expect(persisted.env?.vars?.ELIZAOS_CLOUD_SMALL_MODEL).toBe(
        durableCloudBefore?.vars?.ELIZAOS_CLOUD_SMALL_MODEL,
      );
    },
  );

  it.each([
    "staging-default",
    "offline",
    "staging-explicit",
    "production",
    "self-hosted",
  ] as const)(
    "preserves durable Cloud topology under %s authority while applying unrelated topology",
    async (authority) => {
      resetDevCloudEnvAuthorityForTests();
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
      process.env.ELIZAOS_CLOUD_BASE_URL =
        authority === "production"
          ? "https://api.eliza.app/api/v1"
          : authority === "self-hosted"
            ? "http://127.0.0.1:8787/api/v1"
            : "https://api-staging.eliza.app/api/v1";
      process.env.ELIZAOS_CLOUD_API_KEY =
        authority === "staging-default" || authority === "offline"
          ? ""
          : "launcher-key";
      expect(resolveDevCloudEnvAuthority()).toBe(authority);

      const config: ConfigRouteContext["config"] = {
        cloud: {
          apiKey: "durable-production-key",
          baseUrl: "https://durable.example/api/v1",
          enabled: true,
        },
        deploymentTarget: { runtime: "remote", provider: "elizacloud" },
        linkedAccounts: {
          elizacloud: { status: "linked", source: "api-key" },
          "openai-codex": { status: "linked", source: "oauth" },
        },
        serviceRouting: {
          llmText: {
            backend: "elizacloud",
            transport: "cloud-proxy",
            accountId: "elizacloud",
            largeModel: "durable-cloud-model",
          },
          media: { backend: "local-media", transport: "direct" },
        },
      } as ConfigRouteContext["config"];
      const durableCloudBefore = structuredClone({
        cloud: config.cloud,
        deploymentTarget: config.deploymentTarget,
        linkedAccount: config.linkedAccounts?.elizacloud,
        cloudRoute: config.serviceRouting?.llmText,
      });
      const { ctx, error } = makeCtx(
        {
          cloud: {
            apiKey: "replacement-key",
            baseUrl: "https://attacker.example/api/v1",
            enabled: true,
          },
          deploymentTarget: { runtime: "cloud", provider: "elizacloud" },
          linkedAccounts: {
            elizacloud: { status: "unlinked", source: "credentials" },
            "anthropic-subscription": {
              status: "linked",
              source: "subscription",
            },
          },
          serviceRouting: {
            llmText: {
              backend: "elizacloud",
              transport: "cloud-proxy",
              accountId: "elizacloud",
              largeModel: "replacement-cloud-model",
            },
            tts: { backend: "eliza-cloud", transport: "cloud-proxy" },
            media: { backend: "direct-media-v2", transport: "direct" },
          },
        },
        vi.fn(),
        {
          config,
          allowedTopKeys: [
            "cloud",
            "deploymentTarget",
            "linkedAccounts",
            "serviceRouting",
          ],
        },
      );

      expect(await handleConfigRoutes(ctx)).toBe(true);
      expect(error).not.toHaveBeenCalled();
      expect(config.cloud).toEqual(durableCloudBefore.cloud);
      expect(config.deploymentTarget).toEqual(
        durableCloudBefore.deploymentTarget,
      );
      expect(config.linkedAccounts?.elizacloud).toEqual(
        durableCloudBefore.linkedAccount,
      );
      expect(config.serviceRouting?.llmText).toEqual(
        durableCloudBefore.cloudRoute,
      );
      expect(config.linkedAccounts?.["anthropic-subscription"]).toEqual({
        status: "linked",
        source: "subscription",
      });
      expect(config.serviceRouting?.media).toEqual({
        backend: "direct-media-v2",
        transport: "direct",
      });
      expect(config.serviceRouting?.tts).toBeUndefined();
    },
  );

  it("preserves legacy top-level Cloud topology writes without launcher authority", async () => {
    const config: ConfigRouteContext["config"] = {};
    const { ctx, error } = makeCtx(
      {
        cloud: {
          apiKey: "legacy-key",
          baseUrl: "https://legacy.example/api/v1",
          enabled: true,
        },
        deploymentTarget: { runtime: "cloud", provider: "elizacloud" },
        linkedAccounts: {
          elizacloud: { status: "linked", source: "api-key" },
        },
        serviceRouting: {
          llmText: {
            backend: "elizacloud",
            transport: "cloud-proxy",
            accountId: "elizacloud",
          },
        },
      },
      vi.fn(),
      {
        config,
        allowedTopKeys: [
          "cloud",
          "deploymentTarget",
          "linkedAccounts",
          "serviceRouting",
        ],
      },
    );

    expect(await handleConfigRoutes(ctx)).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(config.cloud).toMatchObject({
      apiKey: "legacy-key",
      baseUrl: "https://legacy.example/api/v1",
      enabled: true,
    });
    expect(config.deploymentTarget).toEqual({
      runtime: "cloud",
      provider: "elizacloud",
    });
    expect(config.linkedAccounts?.elizacloud).toEqual({
      status: "linked",
      source: "api-key",
    });
    expect(config.serviceRouting?.llmText).toMatchObject({
      backend: "elizacloud",
      transport: "cloud-proxy",
      accountId: "elizacloud",
    });
  });

  it.each([
    "staging-default",
    "offline",
    "staging-explicit",
    "production",
    "self-hosted",
  ] as const)(
    "rejects config reload under %s authority before any side effect",
    async (authority) => {
      resetDevCloudEnvAuthorityForTests();
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
      process.env.ELIZAOS_CLOUD_BASE_URL =
        authority === "production"
          ? "https://api.eliza.app/api/v1"
          : authority === "self-hosted"
            ? "http://127.0.0.1:8787/api/v1"
            : "https://api-staging.eliza.app/api/v1";
      process.env.ELIZAOS_CLOUD_API_KEY =
        authority === "staging-default" || authority === "offline"
          ? ""
          : "launcher-key";
      expect(resolveDevCloudEnvAuthority()).toBe(authority);

      const config: ConfigRouteContext["config"] = {
        ui: { theme: "eliza" },
        cloud: { apiKey: "durable-production-key" },
      };
      const configBefore = structuredClone(config);
      const runtime = {
        character: {
          name: "Current Agent",
          settings: { ELIZAOS_CLOUD_API_KEY: "current-runtime-key" },
        },
      };
      const runtimeBefore = structuredClone(runtime.character);
      process.env.OPENAI_API_KEY = "current-openai-key";
      writeFileSync(
        process.env.ELIZA_CONFIG_PATH as string,
        JSON.stringify({
          ui: { theme: "haxor" },
          cloud: { apiKey: "loaded-production-key" },
          env: { vars: { OPENAI_API_KEY: "loaded-openai-key" } },
          agents: {
            defaults: {
              name: "Loaded Agent",
              settings: { ELIZAOS_CLOUD_API_KEY: "loaded-runtime-key" },
            },
          },
        }),
      );
      const { ctx, error, json } = makeCtx({}, vi.fn(), { config });
      ctx.method = "POST";
      ctx.pathname = "/api/config/reload";
      ctx.runtime = runtime as never;

      expect(await handleConfigRoutes(ctx)).toBe(true);
      expect(error).toHaveBeenCalledWith(
        ctx.res,
        expect.stringContaining("immutable local dev Cloud target"),
        409,
      );
      expect(json).not.toHaveBeenCalled();
      expect(config).toEqual(configBefore);
      expect(runtime.character).toEqual(runtimeBefore);
      expect(process.env.OPENAI_API_KEY).toBe("current-openai-key");
    },
  );

  it("preserves config reload behavior without launcher authority", async () => {
    const config: ConfigRouteContext["config"] = {
      ui: { theme: "eliza" },
    };
    writeFileSync(
      process.env.ELIZA_CONFIG_PATH as string,
      JSON.stringify({ ui: { theme: "haxor" } }),
    );
    const { ctx, error, json } = makeCtx({}, vi.fn(), { config });
    ctx.method = "POST";
    ctx.pathname = "/api/config/reload";

    expect(await handleConfigRoutes(ctx)).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(config.ui?.theme).toBe("haxor");
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({ reloaded: true }),
    );
  });
});
