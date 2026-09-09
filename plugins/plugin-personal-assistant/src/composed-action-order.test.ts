/**
 * Real-runtime check that the personal-assistant's composed CALENDAR,
 * CONFLICT_DETECT, and OWNER_GOALS own those names when the plugins are
 * registered in the order the standalone agent's plugin collector derives for
 * a manifest-less host with the assistant enabled (#30943). Boots a real
 * AgentRuntime on PGlite; cross-plugin `override` is neutralized by the plugin
 * lifecycle (#12658), so the collector's order is the contract under test and
 * a regression in either the collector reorder or the home-tile insertion
 * fails here.
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

/** The three plugins this test can register, keyed by collector name. */
const KNOWN: Record<string, Plugin> = {
  "@elizaos/plugin-personal-assistant": personalAssistantPlugin,
  "@elizaos/plugin-calendar": calendarPlugin,
  "@elizaos/plugin-goals": goalsPlugin,
};

describe("composed action order", () => {
  it("owns CALENDAR, CONFLICT_DETECT, and OWNER_GOALS in the collector's own order", async () => {
    const config = {
      plugins: { entries: { "personal-assistant": { enabled: true } } },
    } as Parameters<typeof collectPluginNames>[0];
    const collected = Array.from(collectPluginNames(config));
    const plugins = collected
      .filter((name) => name in KNOWN)
      .map((name) => KNOWN[name]);
    expect(plugins).toContain(personalAssistantPlugin);
    expect(plugins).toContain(calendarPlugin);
    expect(
      collected.indexOf("@elizaos/plugin-personal-assistant"),
    ).toBeLessThan(collected.indexOf("@elizaos/plugin-calendar"));
    // goals is not in the collector's default set; register it after the
    // assistant the way its init would, so OWNER_GOALS is contested too.
    if (!plugins.includes(goalsPlugin)) plugins.push(goalsPlugin);

    const { runtime, cleanup } = await createTestRuntime({ plugins });
    try {
      const byName = (name: string) =>
        runtime.actions.filter((action) => action.name === name);
      for (const name of ["CALENDAR", "CONFLICT_DETECT", "OWNER_GOALS"]) {
        const registered = byName(name);
        expect(registered).toHaveLength(1);
        expect(registered[0]).toBe(assistantAction(name));
      }
      // Every other calendar action stays with the standalone plugin.
      const sources = byName("CALENDAR_SOURCES");
      expect(sources).toHaveLength(1);
      expect(calendarPlugin.actions ?? []).toContain(sources[0]);
    } finally {
      await cleanup();
    }
  }, 240_000);
});
