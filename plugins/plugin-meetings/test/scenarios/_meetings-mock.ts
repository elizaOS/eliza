/**
 * Strict meetings-provider setup shared by deterministic scenarios.
 *
 * The production meetings plugin is registered first, then its test-support
 * companion is registered before `AgentRuntime.initialize()`. The companion's
 * init hook replaces only the browser/ASR dependency boundary before
 * `MeetingService.start()` captures it. Ordinary scenario seeds then install
 * exact per-meeting scripts and reset the call ledger between attempts.
 */

import type { UUID } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import type { MeetingPlatform } from "@elizaos/shared";
import {
  ASSERT_MEETING_MOCK_LEDGER,
  clearMockMeetingScripts,
  DEFAULT_MOCK_TURNS,
  type MockMeetingScript,
  setMockMeetingScript,
} from "../../src/test-support.js";

export const MEETINGS_MOCK_REQUIRED_PLUGINS = [
  "@elizaos/plugin-meetings",
  "@elizaos/plugin-meetings/test-support",
] as const;

type SeedStep = {
  type: "custom";
  name?: string;
  apply: () => void | Promise<void>;
};

/** Build the canonical exact one-call script for a platform. */
export function defaultMockMeetingScript(
  platform: MeetingPlatform,
): MockMeetingScript {
  return {
    platform,
    holdUntilLeave: false,
    turns: DEFAULT_MOCK_TURNS.map((turn) => ({ ...turn })),
    times: 1,
  };
}

/** Reset and install exact provider expectations for one scenario attempt. */
export function installMockSeed(
  scripts: Record<string, MockMeetingScript> = {},
): SeedStep {
  return {
    type: "custom",
    name: "install strict meetings provider expectations",
    apply: () => {
      clearMockMeetingScripts();
      for (const [nativeMeetingId, script] of Object.entries(scripts)) {
        setMockMeetingScript(nativeMeetingId, script);
      }
    },
  };
}

/** Production-memory quiescence predicate for a joined transcript. */
export async function joinedTranscriptIsReady(
  ctx: ScenarioContext,
): Promise<boolean> {
  const joined = [...ctx.actionsCalled]
    .reverse()
    .find(
      (action) =>
        action.actionName === "JOIN_MEETING" && action.result?.success === true,
    );
  const transcriptId = (
    joined?.result?.data as { transcriptId?: unknown } | undefined
  )?.transcriptId;
  if (typeof transcriptId !== "string") return false;
  const runtime = ctx.runtime as {
    getMemoryById(id: UUID): Promise<{ content?: unknown } | null>;
  };
  const row = await runtime.getMemoryById(transcriptId as UUID);
  const serialized = (
    row?.content as { transcript?: unknown } | null | undefined
  )?.transcript;
  if (typeof serialized !== "string") return false;
  return (JSON.parse(serialized) as { status?: unknown }).status === "ready";
}

/** Assert the reviewer-visible strict provider ledger action result. */
export function assertMeetingMockLedger(
  turn: ScenarioTurnExecution,
): string | undefined {
  const assertion = turn.actionsCalled.find(
    (action) => action.actionName === ASSERT_MEETING_MOCK_LEDGER,
  );
  return assertion?.result?.success === true
    ? undefined
    : (assertion?.result?.text ?? "strict meetings provider ledger missing");
}
