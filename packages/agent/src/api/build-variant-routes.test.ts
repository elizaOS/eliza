import type http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleBuildVariantRoutes } from "./build-variant-routes";

const originalEnv = process.env.MILADY_BUILD_VARIANT;

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.MILADY_BUILD_VARIANT;
  } else {
    process.env.MILADY_BUILD_VARIANT = originalEnv;
  }
});

function makeCtx(method: string, pathname: string) {
  const json = vi.fn();
  return {
    ctx: {
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method,
      pathname,
      json,
    },
    json,
  };
}

describe("handleBuildVariantRoutes", () => {
  it("returns variant=store + platform when env is store", () => {
    process.env.MILADY_BUILD_VARIANT = "store";
    const { ctx, json } = makeCtx("GET", "/api/build/variant");
    const handled = handleBuildVariantRoutes(ctx);
    expect(handled).toBe(true);
    expect(json).toHaveBeenCalledOnce();
    const payload = json.mock.calls[0]?.[1];
    expect(payload).toEqual({
      variant: "store",
      platform: process.platform,
    });
  });

  it("returns variant=direct by default", () => {
    delete process.env.MILADY_BUILD_VARIANT;
    const { ctx, json } = makeCtx("GET", "/api/build/variant");
    expect(handleBuildVariantRoutes(ctx)).toBe(true);
    const payload = json.mock.calls[0]?.[1];
    expect(payload).toEqual({
      variant: "direct",
      platform: process.platform,
    });
  });

  it("does not handle other paths", () => {
    const { ctx, json } = makeCtx("GET", "/api/health");
    expect(handleBuildVariantRoutes(ctx)).toBe(false);
    expect(json).not.toHaveBeenCalled();
  });

  it("does not handle non-GET methods", () => {
    const { ctx, json } = makeCtx("POST", "/api/build/variant");
    expect(handleBuildVariantRoutes(ctx)).toBe(false);
    expect(json).not.toHaveBeenCalled();
  });
});
