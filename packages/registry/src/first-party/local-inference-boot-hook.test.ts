/**
 * Verifies plugin-local-inference self-declares its PRE-READY boot hook in the
 * first-party registry, so the app-core host drains it through the generic
 * boot-hook channel instead of hard-wiring the
 * `@elizaos/plugin-local-inference/runtime` internals at fixed init points in
 * `repairRuntimeAfterBoot` (arch-audit #12089 item 18).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  clearRegistryCacheForTests,
  getEntryByNpmName,
  loadRegistry,
} from "./index";
import type { PluginEntry } from "./schema";

describe("local-inference boot-hook registry declaration", () => {
  afterEach(() => {
    clearRegistryCacheForTests();
  });

  it("declares registerLocalInferenceBoot as its pre-ready bootHook", () => {
    const entry = getEntryByNpmName(
      loadRegistry(),
      "@elizaos/plugin-local-inference",
    ) as PluginEntry | undefined;

    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("plugin");
    // Self-declared boot hook: the host drains this through the generic
    // pre-ready boot-hook channel instead of hard-wiring the local-inference
    // specifier + its internals in `repairRuntimeAfterBoot`.
    expect(entry?.launch?.bootHook).toEqual({
      specifier: "@elizaos/plugin-local-inference/runtime",
      exportName: "registerLocalInferenceBoot",
    });
  });
});
