/**
 * Real-runtime check that the personal-assistant's composed CALENDAR,
 * CONFLICT_DETECT, and OWNER_GOALS own those names when the assistant is
 * registered before the standalone calendar and goals plugins, which is the
 * order the standalone agent's plugin collector guarantees (#30943). Boots a
 * real AgentRuntime on PGlite; cross-plugin `override` is neutralized by the
 * plugin lifecycle (#12658), so order is the contract under test.
 */
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

describe("composed action order", () => {
  it("owns CALENDAR, CONFLICT_DETECT, and OWNER_GOALS when registered before the standalone plugins", async () => {
    const { runtime, cleanup } = await createTestRuntime({
      plugins: [personalAssistantPlugin, calendarPlugin, goalsPlugin],
    });
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
