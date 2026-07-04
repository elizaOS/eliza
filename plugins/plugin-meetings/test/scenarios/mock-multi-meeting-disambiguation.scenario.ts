/**
 * MOCKED multi-meeting disambiguation (#11856, `pr-deterministic`). Two mock
 * meetings are active; an unqualified "leave the meeting" must NOT guess — the
 * agent asks which one to leave. Asserts the ambiguous reply and that both
 * sessions stay active (nothing was left).
 */

import type {
  ScenarioContext,
  ScenarioDefinition,
} from "@elizaos/scenario-runner/schema";
import { installMockSeed } from "./_meetings-mock.js";

const MEET_ID = "abc-defg-hij";
const ZOOM_ID = "9876543210";

async function bothStillActive(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const service = (
    ctx.runtime as {
      getService(name: string): {
        listSessions(opts?: { active?: boolean }): unknown[];
      } | null;
    }
  ).getService("meetings");
  if (!service) return "meetings service not running";
  const active = service.listSessions({ active: true });
  if (active.length !== 2) {
    return `expected both meetings to stay active, saw ${active.length}`;
  }
  return undefined;
}

export default {
  id: "mock-multi-meeting-disambiguation",
  lane: "pr-deterministic",
  title: "Mocked LEAVE_MEETING asks which meeting when two are active",
  domain: "meetings",
  tags: ["mock", "meetings", "leave-meeting", "disambiguation"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-meetings"] },
  seed: [
    installMockSeed({
      [MEET_ID]: { holdUntilLeave: true, turns: [] },
      [ZOOM_ID]: { holdUntilLeave: true, turns: [] },
    }),
  ],
  rooms: [{ id: "main", source: "chat", title: "Mock Two Meetings" }],
  turns: [
    {
      kind: "action",
      name: "agent joins the Google Meet",
      room: "main",
      actionName: "JOIN_MEETING",
      text: `join https://meet.google.com/${MEET_ID}`,
    },
    {
      kind: "action",
      name: "agent joins the Zoom meeting",
      room: "main",
      actionName: "JOIN_MEETING",
      text: `join https://zoom.us/j/${ZOOM_ID}`,
    },
    {
      kind: "action",
      name: "user asks to leave without naming which meeting",
      room: "main",
      actionName: "LEAVE_MEETING",
      text: "leave the meeting",
      assertResponse(text) {
        if (!/which one/i.test(text) || !/2 meetings/i.test(text)) {
          return `expected an ambiguous 'which one' reply, got: ${text.slice(0, 200)}`;
        }
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      name: "JOIN_MEETING executed twice",
      actionName: "JOIN_MEETING",
      status: "success",
      minCount: 2,
    },
    {
      type: "custom",
      name: "both meetings remain active (none left on an ambiguous request)",
      predicate: bothStillActive,
    },
  ],
} satisfies ScenarioDefinition;
