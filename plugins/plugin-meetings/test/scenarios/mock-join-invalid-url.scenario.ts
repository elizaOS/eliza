/**
 * MOCKED invalid-url guard (#11856, `pr-deterministic`). A non-meeting URL must
 * NOT start a meeting: JOIN_MEETING's `validate` rejects it (no recognizable
 * Meet/Teams/Zoom link), so the bot never joins and nothing crashes. Asserts the
 * graceful non-join through the runtime-registered production action validator;
 * no handler, session, provider call, or language-model routing is allowed.
 */

import {
  type ScenarioContext,
  scenario,
} from "@elizaos/scenario-runner/schema";
import {
  assertMeetingMockLedger,
  finalizeMeetingMockLedger,
  installMockSeed,
  MEETINGS_MOCK_REQUIRED_PLUGINS,
  meetingMockLedgerMatches,
} from "./_meetings-mock.js";

const BAD_URL = "https://example.com/notameeting";

async function gracefulInvalidUrl(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as {
    getService(name: string): {
      listSessions(): Array<{ meetingUrl?: string }>;
    } | null;
  };
  const service = runtime.getService("meetings") as {
    listSessions(): Array<{ meetingUrl?: string }>;
  } | null;
  if (!service) return "meetings service not running";
  if (
    service.listSessions().some((session) => session.meetingUrl === BAD_URL)
  ) {
    return "a meeting session was created for a non-meeting URL";
  }
  return undefined;
}

export default scenario({
  id: "mock-join-invalid-url",
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "model-free",
    reason:
      "A direct action turn proves the registered production validator rejects invalid input.",
  },
  title: "Mocked JOIN_MEETING declines a non-meeting URL gracefully",
  domain: "meetings",
  tags: ["mock", "meetings", "join-meeting", "invalid-url"],
  isolation: "per-scenario",
  requires: { plugins: MEETINGS_MOCK_REQUIRED_PLUGINS },
  seed: [installMockSeed()],
  rooms: [{ id: "main", source: "chat", title: "Mock Invalid URL" }],
  turns: [
    {
      kind: "action",
      name: "registered JOIN_MEETING rejects a non-meeting URL",
      room: "main",
      actionName: "JOIN_MEETING",
      text: `join this: ${BAD_URL}`,
      expectedValidation: "rejected",
      assertTurn(turn) {
        const validation = turn.validation;
        return validation?.actionName === "JOIN_MEETING" &&
          validation.accepted === false &&
          validation.expected === "rejected" &&
          turn.actionsCalled.length === 0
          ? undefined
          : `expected registered validation rejection, saw ${JSON.stringify(validation ?? null)}`;
      },
    },
    {
      kind: "action",
      name: "snapshot strict meetings provider ledger",
      actionName: "ASSERT_MEETING_MOCK_LEDGER",
      assertTurn: assertMeetingMockLedger,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "no meeting joined after registered validation rejection",
      predicate: gracefulInvalidUrl,
    },
    {
      type: "custom",
      name: "strict meetings provider ledger matches",
      predicate: meetingMockLedgerMatches,
    },
  ],
  cleanup: [finalizeMeetingMockLedger()],
});
