/**
 * Unit test asserting the plugin-owned health and screen-time assistant
 * commands are exported. Deterministic.
 */
import { describe, expect, it } from "vitest";
import { HEALTH_ASSISTANT_COMMANDS } from "./assistant-commands.js";

describe("health assistant commands", () => {
  it("exports plugin-owned health and screen-time assistant commands", () => {
    expect(HEALTH_ASSISTANT_COMMANDS.length).toBeGreaterThanOrEqual(6);
    expect(
      HEALTH_ASSISTANT_COMMANDS.every(
        (command) => command.sourcePlugin === "@elizaos/plugin-health",
      ),
    ).toBe(true);
    expect(HEALTH_ASSISTANT_COMMANDS.map((command) => command.id)).toEqual(
      expect.arrayContaining(["sleep-signal", "screen-time", "health-status"]),
    );
  });
});
