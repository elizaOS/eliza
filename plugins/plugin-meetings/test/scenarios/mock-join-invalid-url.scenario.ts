/**
 * MOCKED invalid-url guard (#11856, `pr-deterministic`). A non-meeting URL must
 * NOT start a meeting: JOIN_MEETING's `validate` rejects it (no recognizable
 * Meet/Teams/Zoom link), so the bot never joins and nothing crashes. Asserts the
 * graceful non-join — no JOIN_MEETING call, no session created — and that a
 * direct handler invocation with the bad URL returns the typed invalid-url reply
 * rather than throwing.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioDefinition,
} from "@elizaos/scenario-runner/schema";
import { joinMeetingAction } from "../../src/actions/index.js";
import { installMockSeed } from "./_meetings-mock.js";

const BAD_URL = "https://example.com/notameeting";

async function gracefulInvalidUrl(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as IAgentRuntime;
  const service = runtime.getService("meetings") as {
    listSessions(): unknown[];
  } | null;
  if (!service) return "meetings service not running";
  if (service.listSessions().length !== 0) {
    return "a meeting session was created for a non-meeting URL";
  }
  if (ctx.actionsCalled.some((a) => a.actionName === "JOIN_MEETING")) {
    return "JOIN_MEETING was called for a non-meeting URL";
  }

  // The action must decline the bad URL rather than throw: validate=false, and a
  // forced handler call returns the typed invalid-url reply (success=false).
  const message = {
    id: crypto.randomUUID(),
    entityId: crypto.randomUUID(),
    roomId: crypto.randomUUID(),
    content: { text: `join this: ${BAD_URL}`, source: "chat" },
  } as unknown as Memory;
  const valid = await joinMeetingAction.validate(runtime, message);
  if (valid) return "JOIN_MEETING.validate accepted a non-meeting URL";

  let replyText = "";
  const result = await joinMeetingAction.handler(
    runtime,
    message,
    undefined,
    undefined,
    async (c: { text?: string }) => {
      if (c.text) replyText += c.text;
      return [];
    },
  );
  if (result && (result as { success?: boolean }).success === true) {
    return "JOIN_MEETING handler reported success for a non-meeting URL";
  }
  if (!/meeting link|google meet|teams|zoom/i.test(replyText)) {
    return `expected a typed invalid-url reply, got: ${replyText.slice(0, 160)}`;
  }
  return undefined;
}

export default {
  id: "mock-join-invalid-url",
  lane: "pr-deterministic",
  title: "Mocked JOIN_MEETING declines a non-meeting URL gracefully",
  domain: "meetings",
  tags: ["mock", "meetings", "join-meeting", "invalid-url"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-meetings"] },
  seed: [installMockSeed()],
  rooms: [{ id: "main", source: "chat", title: "Mock Invalid URL" }],
  turns: [
    {
      kind: "message",
      name: "user pastes a non-meeting URL",
      room: "main",
      text: `join this: ${BAD_URL}`,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "no meeting joined; typed invalid-url reply, no crash",
      predicate: gracefulInvalidUrl,
    },
  ],
} satisfies ScenarioDefinition;
