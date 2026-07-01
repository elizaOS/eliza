import {
  type ScenarioContext,
  scenario,
} from "@elizaos/scenario-runner/schema";
import { expectTurnToCallAction } from "../_helpers/action-assertions.ts";

function assertSimpleMeetingCreated(ctx: ScenarioContext): string | undefined {
  const calls = ctx.actionsCalled.filter(
    (action) => action.actionName === "CALENDAR",
  );
  if (calls.length === 0) {
    return "expected CALENDAR action result";
  }

  const payload = JSON.stringify(
    calls.map((call) => ({
      parameters: call.parameters ?? null,
      data: call.result?.data ?? null,
      text: call.result?.text ?? null,
    })),
  ).toLowerCase();

  if (
    !payload.includes("create_event") &&
    !payload.includes("created calendar event")
  ) {
    return `Expected calendar create-event signal in action payload. Payload: ${payload.slice(0, 400)}`;
  }
  if (!payload.includes("alex")) {
    return `Expected created event payload to reference Alex. Payload: ${payload.slice(0, 400)}`;
  }
  if (!payload.includes("meeting")) {
    return `Expected created event payload to reference the meeting. Payload: ${payload.slice(0, 400)}`;
  }
  if (!/\b(?:3\s*(?::\s*00)?\s*(?:pm|p\.m\.)|15:00)\b/u.test(payload)) {
    return `Expected created event payload to carry a 3pm time signal. Payload: ${payload.slice(0, 400)}`;
  }

  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "calendar.create.simple",
  title: "Create a calendar event for a simple meeting",
  domain: "calendar",
  tags: ["lifeops", "calendar", "smoke", "happy-path"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Calendar Create Simple",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "create-simple-event",
      text: "Schedule a meeting with Alex tomorrow at 3pm.",
      expectedActions: ["CALENDAR"],
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["CALENDAR"],
        description: "simple calendar event creation",
        includesAll: ["Alex", "meeting"],
      }),
      responseIncludesAny: ["alex", "3", "tomorrow", "meeting", "scheduled"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "calendar-simple-created-event",
      predicate: assertSimpleMeetingCreated,
    },
  ],
});
