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
    CONFIG_WRITE_ALLOWED_TOP_KEYS: new Set(["ui", "env"]),
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
  const previousConfigPath = process.env.ELIZA_CONFIG_PATH;
  let tempDir = "";

  beforeEach(() => {
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
});
