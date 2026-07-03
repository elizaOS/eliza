/**
 * MOCKED leave (#11856, `pr-deterministic`). Join a mock meeting that holds
 * active until asked to leave, then LEAVE_MEETING finalizes the session. Asserts
 * the session left the active set and the transcript row finalized to `ready`.
 */

import type { UUID } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioDefinition,
} from "@elizaos/scenario-runner/schema";
import { installMockSeed } from "./_meetings-mock.js";

const NATIVE_ID = "abc-defg-hij";
const MEET_URL = `https://meet.google.com/${NATIVE_ID}`;

async function sessionFinalized(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as {
    getService(name: string): {
      listSessions(opts?: { active?: boolean }): Array<{
        transcriptId?: string;
        status: string;
      }>;
    } | null;
    getMemoryById(
      id: UUID,
    ): Promise<{ content: Record<string, unknown> } | null>;
  };
  const service = runtime.getService("meetings");
  if (!service) return "meetings service not running";
  const active = service.listSessions({ active: true });
  if (active.length !== 0) {
    return `expected 0 active sessions after leave, saw ${active.length} (${active
      .map((s) => s.status)
      .join(",")})`;
  }
  const all = service.listSessions();
  const ended = all[0];
  if (!ended) return "no session recorded";
  if (ended.status !== "ended") {
    return `expected terminal status 'ended', saw '${ended.status}'`;
  }
  if (!ended.transcriptId) return "ended session has no transcript";
  const row = await runtime.getMemoryById(ended.transcriptId as UUID);
  const raw = (row?.content as { transcript?: unknown })?.transcript;
  const status =
    typeof raw === "string"
      ? (JSON.parse(raw) as { status?: string }).status
      : undefined;
  if (status !== "ready") {
    return `expected finalized transcript status 'ready', saw '${status}'`;
  }
  return undefined;
}

export default {
  id: "mock-leave-meeting",
  lane: "pr-deterministic",
  title: "Mocked LEAVE_MEETING finalizes an active session (no browser)",
  domain: "meetings",
  tags: ["mock", "meetings", "leave-meeting"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-meetings"] },
  seed: [installMockSeed({ [NATIVE_ID]: { holdUntilLeave: true, turns: [] } })],
  rooms: [{ id: "main", source: "chat", title: "Mock Meeting Leave" }],
  turns: [
    {
      kind: "action",
      name: "agent joins and stays in the meeting",
      room: "main",
      actionName: "JOIN_MEETING",
      text: `join ${MEET_URL}`,
    },
    {
      kind: "action",
      name: "agent leaves on request",
      room: "main",
      actionName: "LEAVE_MEETING",
      text: "you can leave the meeting now",
      assertResponse(text) {
        if (!/leaving the google meet/i.test(text)) {
          return `expected a 'leaving the Google Meet' confirmation, got: ${text.slice(0, 160)}`;
        }
      },
    },
    {
      kind: "wait",
      name: "let the finalize path complete",
      durationMs: 300,
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      name: "JOIN_MEETING executed",
      actionName: "JOIN_MEETING",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      name: "LEAVE_MEETING executed",
      actionName: "LEAVE_MEETING",
      status: "success",
      minCount: 1,
    },
    {
      type: "custom",
      name: "session left the active set and transcript finalized to ready",
      predicate: sessionFinalized,
    },
  ],
} satisfies ScenarioDefinition;
