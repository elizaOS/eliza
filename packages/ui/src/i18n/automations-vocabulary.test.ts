import { describe, expect, it } from "vitest";
import { DESKTOP_WORKSPACE_SURFACES } from "../utils/desktop-workspace";
import en from "./locales/en.json";

/**
 * Glossary guard for the automations surface (#12360 / #12177 WI-5). Asserts
 * that user-visible strings use the canonical vocabulary — Automations
 * (umbrella), Workflow, Prompt automation, Scheduled item, Coding task — and
 * never the retired "Heartbeat" trigger label. Runs on leaf data modules
 * (locale dictionary + surface table) so it needs no jsdom or runtime graph.
 */

const messages = en as Record<string, string>;

/**
 * Keys allowed to keep the word "Heartbeat": connection keep-alive uptime,
 * which the glossary explicitly reserves the term for (WI-2).
 */
const CONNECTOR_HEARTBEAT_KEYS = new Set([
  "cloud.agents.detail.lastHeartbeatLabel",
  "cloud.elizaAgentsTable.heartbeat",
]);

describe("automations vocabulary", () => {
  it("has no trigger-facing 'Heartbeat' string left in en.json", () => {
    const offenders = Object.entries(messages).filter(
      ([key, value]) =>
        !CONNECTOR_HEARTBEAT_KEYS.has(key) && /heartbeat/i.test(value),
    );
    expect(offenders).toEqual([]);
  });

  it("has fully retired the heartbeat trigger key families", () => {
    const deadPrefixes = ["heartbeatsview.", "heartbeatform.", "triggersview."];
    const deadKeys = ["common.heartbeat", "nav.heartbeats"];
    const survivors = Object.keys(messages).filter(
      (key) =>
        deadPrefixes.some((prefix) => key.startsWith(prefix)) ||
        deadKeys.includes(key),
    );
    expect(survivors).toEqual([]);
  });

  it("labels the non-workflow automations filter as Prompts, not Tasks", () => {
    expect(messages["automationsfeed.filterTasks"]).toBe("Prompts");
    expect(messages["automationsfeed.task"]).toBe("Prompt automation");
  });

  it("names the detached triggers surface without the heartbeat label", () => {
    expect(messages["desktopworkspacesection.surface.triggers.label"]).toBe(
      "Triggers Window",
    );
    const triggersSurface = DESKTOP_WORKSPACE_SURFACES.find(
      (surface) => surface.id === "triggers",
    );
    expect(triggersSurface?.label).toBe("Triggers Window");
    for (const surface of DESKTOP_WORKSPACE_SURFACES) {
      expect(surface.label).not.toMatch(/heartbeat/i);
    }
  });
});
