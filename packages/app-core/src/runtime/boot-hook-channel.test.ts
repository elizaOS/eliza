/**
 * Unit coverage for `drainBootHookContributors`, the generic PRE-READY boot-hook
 * channel that `repairRuntimeAfterBoot` drains before the runtime is marked
 * ready. It invokes each registry-declared contributor's `invoke(runtime)` in
 * declared order, silently skips a contributor whose optional plugin is absent
 * (OptionalAppRoutePluginUnavailableError), and rethrows any real failure —
 * short-circuiting the remaining contributors (matching the fixed if-chain it
 * replaced for plugin-local-inference's boot, arch-audit #12089 item 18).
 */
import type { AgentRuntime } from "@elizaos/core";
import { OptionalAppRoutePluginUnavailableError } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import {
  drainBootHookContributors,
  resolveBootHookContributors,
} from "./startup/app-contributors.ts";

// The generic boot-hook channel the pre-ready boot path drains. A "contributor"
// is an app/plugin that declared a `bootHook` in the registry; the drain invokes
// each against the runtime, skips an uninstalled optional plugin gracefully, and
// rethrows a real failure.
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

  it("skips a contributor whose optional plugin is unavailable", async () => {
    const runtime = makeFakeRuntime();
    const after = vi.fn().mockResolvedValue(undefined);

    await expect(
      drainBootHookContributors(runtime, [
        {
          id: "@elizaos/plugin-missing",
          invoke: () =>
            Promise.reject(
              new OptionalAppRoutePluginUnavailableError(
                "@elizaos/plugin-missing",
              ),
            ),
        },
        { id: "@elizaos/plugin-present", invoke: after },
      ]),
    ).resolves.toBeUndefined();

    // The graceful skip does not abort the rest of the drain.
    expect(after).toHaveBeenCalledOnce();
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

describe("resolveBootHookContributors — legacy local-inference fallback", () => {
  it("falls back to the legacy local-inference boot hook when the registry is empty", () => {
    // Packaged builds can ship without generated.json, so loadRegistry() is
    // empty. The fallback guarantees the local model handlers still install
    // (the pre-migration guarantee the hard-wired path used to provide).
    const contributors = resolveBootHookContributors([]);
    expect(contributors.map((c) => c.id)).toEqual([
      "@elizaos/plugin-local-inference",
    ]);
  });

  it("uses the registry-declared local-inference boot hook (no duplicate) when present", () => {
    const contributors = resolveBootHookContributors([
      {
        id: "@elizaos/plugin-local-inference",
        specifier: "@elizaos/plugin-local-inference/runtime",
        exportName: "registerLocalInferenceBoot",
      },
    ]);
    // Registry entry wins by id — the fallback must NOT add a second
    // local-inference contributor.
    expect(contributors.map((c) => c.id)).toEqual([
      "@elizaos/plugin-local-inference",
    ]);
  });

  it("includes other registry-declared boot hooks alongside the fallback", () => {
    const contributors = resolveBootHookContributors([
      {
        id: "@elizaos/plugin-some-app",
        specifier: "@elizaos/plugin-some-app",
        exportName: "registerSomeBoot",
      },
    ]);
    const ids = contributors.map((c) => c.id);
    // The declared app hook plus the legacy local-inference fallback.
    expect(ids).toContain("@elizaos/plugin-some-app");
    expect(ids).toContain("@elizaos/plugin-local-inference");
    expect(ids).toHaveLength(2);
  });
});
