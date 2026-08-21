/**
 * PUT /api/config nest bound. Recursive strip/safeMerge stack limits are
 * runtime-dependent, so structurally excessive patches are rejected by the
 * canonical blocked-object-key walker before those consumers run.
 */
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  type ConfigRouteContext,
  MAX_CONFIG_PATCH_DEPTH,
  configPatchExceedsBound,
  handleConfigRoutes,
} from "./config-routes";

function nest(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < depth; i++) {
    node = { n: node };
  }
  return node;
}

function makeCtx(
  body: Record<string, unknown>,
  strip: ConfigRouteContext["stripRedactedPlaceholderValuesDeep"],
): { ctx: ConfigRouteContext; error: ReturnType<typeof vi.fn> } {
  const error = vi.fn();
  const json = vi.fn();
  const ctx: ConfigRouteContext = {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "PUT",
    pathname: "/api/config",
    url: new URL("http://127.0.0.1/api/config"),
    config: {},
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
  return { ctx, error };
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
