/**
 * Unit coverage for `drainRuntimeHookContributors`, the generic runtime-hook
 * channel the boot tail drains. It invokes each registry-declared contributor's
 * `invoke(runtime)` in declared order, silently skips a contributor whose
 * optional plugin is absent (OptionalAppRoutePluginUnavailableError), and
 * rethrows any real failure — short-circuiting the remaining contributors.
 */
import type { AgentRuntime } from "@elizaos/core";
import { OptionalAppRoutePluginUnavailableError } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { drainRuntimeHookContributors } from "./eliza.ts";

// The generic runtime-hook channel the boot tail drains. A "contributor" is
// an app that declared a `runtimeHook` in the registry; the drain invokes each
// against the runtime, skips an uninstalled optional plugin gracefully, and
// rethrows a real failure. These tests exercise the drain directly (the boot
// tail's post-ready timing is covered in repair-boot-phase.test.ts).
function makeFakeRuntime(): AgentRuntime {
  return {} as AgentRuntime;
}

describe("drainRuntimeHookContributors — generic runtime-hook channel", () => {
  it("invokes a registered contributor with the runtime", async () => {
    const runtime = makeFakeRuntime();
    const invoke = vi.fn().mockResolvedValue(undefined);

    await drainRuntimeHookContributors(runtime, [
      { id: "@elizaos/plugin-example", invoke },
    ]);

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(runtime);
  });

  it("invokes every contributor in declared order", async () => {
    const runtime = makeFakeRuntime();
    const order: string[] = [];

    await drainRuntimeHookContributors(runtime, [
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
      drainRuntimeHookContributors(runtime, []),
    ).resolves.toBeUndefined();
  });

  it("skips a contributor whose optional plugin is unavailable", async () => {
    const runtime = makeFakeRuntime();
    const after = vi.fn().mockResolvedValue(undefined);

    await expect(
      drainRuntimeHookContributors(runtime, [
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
    const boom = new Error("hook init blew up");
    const after = vi.fn().mockResolvedValue(undefined);

    await expect(
      drainRuntimeHookContributors(runtime, [
        { id: "@elizaos/plugin-broken", invoke: () => Promise.reject(boom) },
        { id: "@elizaos/plugin-never", invoke: after },
      ]),
    ).rejects.toThrow(boom);

    // A real failure short-circuits the remaining contributors.
    expect(after).not.toHaveBeenCalled();
  });
});
