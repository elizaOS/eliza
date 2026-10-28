/**
 * MOCKED invalid-url guard (#11856, `pr-deterministic`). A non-meeting URL must
 * NOT start a meeting: JOIN_MEETING's handler finds no recognizable
 * Meet/Teams/Zoom link and replies that it needs one before any side effect, so
 * the bot never joins and nothing crashes. Asserts the graceful non-join through
 * the runtime-registered production action; no session, provider call, or
 * language-model routing is allowed.
 */

import { type ScenarioContext, scenario } from "@elizaos/testing";
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
      "A direct action turn proves the registered production action declines invalid input.",
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
      name: "registered JOIN_MEETING asks for a link on a non-meeting URL",
      room: "main",
      actionName: "JOIN_MEETING",
      text: `join this: ${BAD_URL}`,
      assertTurn(turn) {
        const body = turn.responseBody as { success?: unknown } | null;
        return body?.success === false &&
          turn.responseText?.includes("I need a meeting link")
          ? undefined
          : `expected the need-a-link failure reply, saw ${JSON.stringify(turn.responseBody ?? null)}`;
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
      name: "no meeting joined for a non-meeting URL",
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
