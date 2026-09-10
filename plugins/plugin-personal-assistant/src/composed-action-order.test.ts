/**
 * Real-runtime check that the personal-assistant's composed CALENDAR,
 * CONFLICT_DETECT, and OWNER_GOALS own those names when the plugins the
 * standalone agent's collector derives for a manifest-less host are
 * registered concurrently, the way `AgentRuntime.initialize` registers
 * non-core plugins (#30943). Cross-plugin `override` is neutralized by the
 * plugin lifecycle (#12658) and array order does not survive concurrent
 * registration, so the contract under test is that the collector withholds
 * the standalone calendar and goals entries and the assistant's init
 * registers them itself with the composed names withheld.
 */
import { collectPluginNames } from "@elizaos/agent/runtime/plugin-collector";
import type { Plugin } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/core/testing";
import { calendarPlugin } from "@elizaos/plugin-calendar";
import { goalsPlugin } from "@elizaos/plugin-goals/plugin";
import { describe, expect, it } from "vitest";
import { personalAssistantPlugin } from "./index";

/** The assistant's own action object for `name`, by identity. */
function assistantAction(name: string) {
  const action = (personalAssistantPlugin.actions ?? []).find(
    (candidate) => candidate.name === name,
  );
  if (!action) throw new Error(`assistant does not declare ${name}`);
  return action;
}

/** The plugins this test can register, keyed by collector name. */
const KNOWN: Record<string, Plugin> = {
  "@elizaos/plugin-personal-assistant": personalAssistantPlugin,
  "@elizaos/plugin-calendar": calendarPlugin,
  "@elizaos/plugin-goals": goalsPlugin,
};

describe("composed action order", () => {
  it("owns CALENDAR, CONFLICT_DETECT, and OWNER_GOALS when the collector's plugins register concurrently", async () => {
    const config = {
      plugins: { entries: { "personal-assistant": { enabled: true } } },
    } as Parameters<typeof collectPluginNames>[0];
    const collected = Array.from(collectPluginNames(config));
    expect(collected).toContain("@elizaos/plugin-personal-assistant");
    // The collector leaves these to the assistant's init; a standalone entry
    // here would register concurrently and win first-wins.
    expect(collected).not.toContain("@elizaos/plugin-calendar");
    expect(collected).not.toContain("@elizaos/plugin-goals");
    const plugins = collected
      .filter((name) => name in KNOWN)
      .map((name) => KNOWN[name]);

    const { runtime, cleanup } = await createTestRuntime({});
    try {
      await Promise.all(
        plugins.map((plugin) => runtime.registerPlugin(plugin)),
      );
      const byName = (name: string) =>
        runtime.actions.filter((action) => action.name === name);
      for (const name of ["CALENDAR", "CONFLICT_DETECT", "OWNER_GOALS"]) {
        const registered = byName(name);
        expect(registered).toHaveLength(1);
        expect(registered[0]).toBe(assistantAction(name));
      }
      // The assistant registered the calendar plugin itself: its other
      // actions are present and belong to the standalone plugin object.
      expect(runtime.plugins.map((plugin) => plugin.name)).toContain(
        "calendar",
      );
      const sources = byName("CALENDAR_SOURCES");
      expect(sources).toHaveLength(1);
      expect(calendarPlugin.actions ?? []).toContain(sources[0]);
    } finally {
      await cleanup();
    }
  }, 240_000);

  it("loses all three names to a standalone calendar and goals entry registered concurrently", async () => {
    // The mechanism the collector guards against: with the standalone
    // plugins in the same concurrent wave, first-wins keeps their actions.
    const { runtime, cleanup } = await createTestRuntime({});
    try {
      await Promise.all(
        [personalAssistantPlugin, calendarPlugin, goalsPlugin].map((plugin) =>
          runtime.registerPlugin(plugin),
        ),
      );
      for (const name of ["CALENDAR", "CONFLICT_DETECT", "OWNER_GOALS"]) {
        const registered = runtime.actions.filter((a) => a.name === name);
        expect(registered).toHaveLength(1);
        expect(registered[0]).not.toBe(assistantAction(name));
      }
    } finally {
      await cleanup();
    }
  }, 240_000);
});
