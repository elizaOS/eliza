/**
 * Integration test for the cache wrapper that plugs into the agent runtime
 * `registerAction` interceptor in `plugin-lifecycle.ts`.
 *
 * Builds a stub Action whose name matches a cacheable registry entry and
 * verifies that the wrapped handler short-circuits on hit, falls through on
 * miss, and leaves non-cacheable actions untouched.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Action, ActionResult } from "@elizaos/core";

import {
  createToolCallCacheFromConfig,
  wrapActionWithCache,
} from "./tool-call-cache-wrapper.ts";

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), "tool-cache-wrap-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function makeStubAction(
  name: string,
  impl: (parameters: Record<string, unknown>) => ActionResult,
): { action: Action; calls: () => number } {
  let count = 0;
  const action: Action = {
    name,
    description: "stub",
    handler: async (_runtime, _msg, _state, options) => {
      count += 1;
      const opts = options as
        | { parameters?: Record<string, unknown> }
        | undefined;
      return impl(opts?.parameters ?? {});
    },
    validate: async () => true,
  };
  return { action, calls: () => count };
}

describe("wrapActionWithCache", () => {
  it("short-circuits cacheable action on second invocation", async () => {
    const cache = createToolCallCacheFromConfig({ diskRoot: tempRoot });
    if (!cache) throw new Error("cache must be enabled");
    const { action, calls } = makeStubAction("web_search", (params) => ({
      success: true,
      text: `searched:${params.q ?? ""}`,
    }));
    const wrapped = wrapActionWithCache(action, cache, {
      diskRoot: tempRoot,
    });

    const opts = { parameters: { q: "foo" } };
    const r1 = await wrapped.handler({} as never, {} as never, undefined, opts);
    const r2 = await wrapped.handler({} as never, {} as never, undefined, opts);

    expect(calls()).toBe(1);
    expect(r1).toEqual(r2);
  });

  it("leaves non-cacheable actions untouched", async () => {
    const cache = createToolCallCacheFromConfig({ diskRoot: tempRoot });
    if (!cache) throw new Error("cache must be enabled");
    const { action, calls } = makeStubAction("send_email", (params) => ({
      success: true,
      text: `sent:${params.to ?? ""}`,
    }));
    const wrapped = wrapActionWithCache(action, cache, undefined);
    expect(wrapped).toBe(action);

    const opts = { parameters: { to: "x" } };
    await wrapped.handler({} as never, {} as never, undefined, opts);
    await wrapped.handler({} as never, {} as never, undefined, opts);
    expect(calls()).toBe(2);
  });

  it("respects per-tool TTL overrides from config", async () => {
    const cache = createToolCallCacheFromConfig({
      diskRoot: tempRoot,
      perTool: { web_search: { version: "9" } },
    });
    if (!cache) throw new Error("cache must be enabled");
    const { action, calls } = makeStubAction("web_search", () => ({
      success: true,
      text: "v9",
    }));
    const wrapped = wrapActionWithCache(action, cache, {
      diskRoot: tempRoot,
      perTool: { web_search: { version: "9" } },
    });

    const opts = { parameters: { q: "x" } };
    await wrapped.handler({} as never, {} as never, undefined, opts);
    await wrapped.handler({} as never, {} as never, undefined, opts);
    expect(calls()).toBe(1);

    // A subsequent wrapper using a bumped version must invalidate the prior entry.
    const wrapped2 = wrapActionWithCache(action, cache, {
      diskRoot: tempRoot,
      perTool: { web_search: { version: "10" } },
    });
    await wrapped2.handler({} as never, {} as never, undefined, opts);
    expect(calls()).toBe(2);
  });

  it("createToolCallCacheFromConfig returns null when disabled", () => {
    const cache = createToolCallCacheFromConfig({ enabled: false });
    expect(cache).toBeNull();
  });
});
