/**
 * Unit coverage for `drainBootHookContributors`, the generic PRE-READY boot-hook
 * channel that the shared agent host drains before the runtime is marked ready.
 * It invokes each registry-declared contributor in order, retains the packaged
 * local-inference fallback, and rethrows real failures.
 */

import {
  drainBootHookContributors,
  getBootHookContributors,
  resolveBootHookContributors,
} from "@elizaos/agent/runtime/boot-hooks";
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

// The generic boot-hook channel the pre-ready boot path drains. A "contributor"
// is an app/plugin that declared a `bootHook` in the registry; the drain invokes
// each against the runtime and rethrows a real failure.
function makeFakeRuntime(): AgentRuntime {
  return {} as AgentRuntime;
}

describe("drainBootHookContributors — generic pre-ready boot-hook channel", () => {
  it("invokes a registered contributor with the runtime", async () => {
    const runtime = makeFakeRuntime();
    const invoke = vi.fn().mockResolvedValue(undefined);

    await drainBootHookContributors(runtime, [
      { id: "@elizaos/plugin-local-inference", invoke },
    ]);

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(runtime);
  });

  it("invokes every contributor in declared order", async () => {
    const runtime = makeFakeRuntime();
    const order: string[] = [];

    await drainBootHookContributors(runtime, [
      {
        id: "a",
        invoke: async () => {
          order.push("a");
        },
      },
      {
        id: "b",
        invoke: async () => {
          order.push("b");
        },
      },
    ]);

    expect(order).toEqual(["a", "b"]);
  });

  it("no-ops when there are no contributors", async () => {
    const runtime = makeFakeRuntime();
    await expect(
      drainBootHookContributors(runtime, []),
    ).resolves.toBeUndefined();
  });

  it("rethrows a real contributor failure (not mistaken for a benign absence)", async () => {
    const runtime = makeFakeRuntime();
    const boom = new Error("boot hook init blew up");
    const after = vi.fn().mockResolvedValue(undefined);

    await expect(
      drainBootHookContributors(runtime, [
        { id: "@elizaos/plugin-broken", invoke: () => Promise.reject(boom) },
        { id: "@elizaos/plugin-never", invoke: after },
      ]),
    ).rejects.toThrow(boom);

    // A real failure short-circuits the remaining contributors — a broken
    // pre-ready boot step must fail loud, not silently skip to the next.
    expect(after).not.toHaveBeenCalled();
  });
});

describe("resolveBootHookContributors — declared hooks and packaged fallback", () => {
  it("discovers the local inference hook from the generated registry", () => {
    expect(
      getBootHookContributors().map((contributor) => contributor.id),
    ).toContain("@elizaos/plugin-local-inference");
  });

  it("retains local inference when a packaged build has no registry data", () => {
    expect(
      resolveBootHookContributors([]).map((contributor) => contributor.id),
    ).toEqual(["@elizaos/plugin-local-inference"]);
  });

  it("resolves a registry-declared hook", () => {
    const contributors = resolveBootHookContributors([
      {
        id: "@elizaos/plugin-local-inference",
        specifier: "@elizaos/plugin-local-inference/runtime",
        exportName: "registerLocalInferenceBoot",
      },
    ]);
    expect(contributors.map((c) => c.id)).toEqual([
      "@elizaos/plugin-local-inference",
    ]);
  });

  it("deduplicates declarations by id while retaining the packaged fallback", () => {
    const contributors = resolveBootHookContributors([
      {
        id: "same-plugin",
        specifier: "first-module",
        exportName: "firstHook",
      },
      {
        id: "same-plugin",
        specifier: "second-module",
        exportName: "secondHook",
      },
    ]);
    expect(contributors.map((contributor) => contributor.id)).toEqual([
      "same-plugin",
      "@elizaos/plugin-local-inference",
    ]);
  });
});
