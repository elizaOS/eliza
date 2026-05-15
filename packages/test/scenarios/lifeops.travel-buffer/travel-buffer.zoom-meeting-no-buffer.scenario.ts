/**
 * Zoom / virtual meeting — no physical travel, so no travel buffer. Agent
 * must distinguish virtual from in-person.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import {
  seedCalendarCache,
  seedMeetingPreferences,
} from "../_helpers/lifeops-seeds.ts";

function checkVirtualNoBuffer(ctx: ScenarioContext): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  // Reply must reference zoom/virtual and either skip buffer or explain
  // why none is needed.
  const virtualSignals = ["zoom", "virtual", "video", "remote", "online"];
  if (!virtualSignals.some((s) => reply.includes(s))) {
    return `Agent didn't acknowledge this is a virtual meeting. Reply: ${reply.slice(0, 300)}`;
  }
  if (
    reply.includes("travel buffer") &&
    !reply.includes("skip") &&
    !reply.includes("no buffer") &&
    !reply.includes("won't") &&
    !reply.includes("wont") &&
    !reply.includes("not needed")
  ) {
    return `Agent added a travel buffer to a Zoom meeting. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "travel-buffer.zoom-meeting-no-buffer",
  title: "Zoom / virtual meeting skips the auto travel buffer",
  domain: "lifeops.travel-buffer",
  tags: ["lifeops", "travel-buffer", "virtual"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Virtual Meeting No Buffer",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-prefs",
      apply: seedMeetingPreferences({
        preferredStartLocal: "09:00",
        preferredEndLocal: "18:00",
        defaultDurationMinutes: 30,
        travelBufferMinutes: 15,
      }),
    },
    {
      type: "custom",
      name: "seed-empty",
      apply: seedCalendarCache({ events: [] }),
    },
  ],
  turns: [
    {
      kind: "message",
      name: "create-zoom-meeting",
      room: "main",
      text: "Schedule a 30-minute Zoom call with Roger tomorrow at 3pm.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "virtual-no-buffer",
      predicate: checkVirtualNoBuffer,
    },
    judgeRubric({
      name: "travel-buffer-virtual-rubric",
      threshold: 0.5,
      description: `Zoom meeting — no commute. Correct: agent creates the event with NO travel buffer, OR explicitly mentions skipping the buffer for a virtual meeting. Incorrect: agent auto-adds a travel block before a Zoom call.`,
    }),
  ],
});
