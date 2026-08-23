/**
 * Coverage for hono-next-style-params.
 */
import { describe, expect, it } from "vitest";

import { nextStyleParams } from "./hono-next-style-params.js";

function mockCtx(params: Record<string, string | undefined>, splat?: string) {
  return {
    req: {
      param: (name: string) => {
        if (name === "*") return splat;
        return params[name];
      },
    },
  } as never;
}

describe("nextStyleParams", () => {
  it("resolves single param", async () => {
    const c = mockCtx({ id: "abc" });
    const r = nextStyleParams(c, [{ name: "id", splat: false }] as const);
    expect(await r.params).toEqual({ id: "abc" });
  });

  it("resolves splat param", async () => {
    const c = mockCtx({}, "a/b/c");
    const r = nextStyleParams(c, [{ name: "path", splat: true }] as const);
    expect(await r.params).toEqual({ path: ["a", "b", "c"] });
  });

  it("handles empty splat", async () => {
    const c = mockCtx({}, "");
    const r = nextStyleParams(c, [{ name: "path", splat: true }] as const);
    expect(await r.params).toEqual({ path: [] });
  });

  it("handles undefined splat", async () => {
    const c = mockCtx({}, undefined);
    const r = nextStyleParams(c, [{ name: "path", splat: true }] as const);
    expect(await r.params).toEqual({ path: [] });
  });

  it("ignores missing non-splat", async () => {
    const c = mockCtx({});
    const r = nextStyleParams(c, [{ name: "id", splat: false }] as const);
    expect(await r.params).toEqual({});
  });

  it("filters empty segments in splat", async () => {
    const c = mockCtx({}, "a//b/");
    const r = nextStyleParams(c, [{ name: "path", splat: true }] as const);
    expect(await r.params).toEqual({ path: ["a", "b"] });
  });
});
