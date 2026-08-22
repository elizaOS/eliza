/**
 * Strict meetings-provider setup shared by deterministic scenarios.
 *
 * The production meetings plugin is registered first, then its test-support
 * companion is registered before `AgentRuntime.initialize()`. The companion's
 * init hook replaces only the browser/ASR dependency boundary before
 * `MeetingService.start()` captures it. Ordinary scenario seeds then install
 * exact per-meeting scripts and reset the call ledger between attempts.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import type {
  ScenarioCleanupStep,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import type { MeetingPlatform } from "@elizaos/shared";
import {
  ASSERT_MEETING_MOCK_LEDGER,
  clearMockMeetingScripts,
  DEFAULT_MOCK_TURNS,
  finalizeMockMeetingProviderLedger,
  getMockMeetingProviderLedger,
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
  apply: (ctx: ScenarioContext) => void | Promise<void>;
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
    apply: (ctx: ScenarioContext) => {
      const runtime = ctx.runtime as IAgentRuntime;
      clearMockMeetingScripts(runtime);
      for (const [nativeMeetingId, script] of Object.entries(scripts)) {
        setMockMeetingScript(runtime, nativeMeetingId, script);
      }
    },
  };
}

/** Production-memory quiescence predicate for a joined transcript. */
export async function joinedTranscriptIsReady(
  ctx: ScenarioContext,
): Promise<boolean> {
  const service = (
    ctx.runtime as {
      getService(name: string): {
        listSessions(): Array<{ id?: unknown; transcriptId?: unknown }>;
        waitForSessionCompletion(id: UUID): Promise<unknown>;
        pendingSessionWorkCount(): number;
      } | null;
    }
  ).getService("meetings");
  const latest = service?.listSessions()[0];
  if (typeof latest?.id !== "string") return false;
  await service.waitForSessionCompletion(latest.id as UUID);
  if (service.pendingSessionWorkCount() !== 0) return false;
  const transcriptId = service.listSessions()[0]?.transcriptId;
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

/** Final-check predicate with exact, reviewer-visible provider cardinalities. */
export function meetingMockLedgerMatches(
  ctx: ScenarioContext,
): string | undefined {
  const ledger = getMockMeetingProviderLedger(ctx.runtime as IAgentRuntime);
  return ledger.problems.length === 0
    ? undefined
    : `strict meetings provider ledger mismatch: ${ledger.problems.join("; ")}; ledger=${JSON.stringify(ledger)}`;
}

/** Assert the structured ledger snapshot action used as reviewer evidence. */
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

/**
 * Guaranteed finalization assertion. The executor runs cleanup in `finally`,
 * after turns and final checks, so late, missing, and over-consumed calls cannot
 * escape merely because earlier scenario work threw.
 */
export function finalizeMeetingMockLedger(): ScenarioCleanupStep {
  return {
    type: "custom",
    name: "finalize exact meetings provider ledger",
    apply: async (ctx) => {
      const runtime = ctx.runtime as IAgentRuntime;
      const problems: string[] = [];
      try {
        const service = (
          runtime as {
            getService(name: string): {
              listSessions(options?: { active?: boolean }): Array<{ id: UUID }>;
              stopSession(id: UUID): boolean;
              waitForSessionCompletion(id: UUID): Promise<unknown>;
              pendingSessionWorkCount(): number;
            } | null;
          }
        ).getService("meetings");
        if (!service) {
          problems.push("meetings service missing during finalization");
        } else {
          const active = service.listSessions({ active: true });
          for (const session of active) service.stopSession(session.id);
          const completions = await Promise.allSettled(
            active.map((session) =>
              service.waitForSessionCompletion(session.id),
            ),
          );
          for (const [index, completion] of completions.entries()) {
            if (completion.status === "rejected") {
              const sessionId = active[index]?.id ?? "unknown";
              const detail =
                completion.reason instanceof Error
                  ? completion.reason.message
                  : String(completion.reason);
              problems.push(
                `meeting session ${sessionId} failed to quiesce: ${detail}`,
              );
            }
          }
          const pending = service.pendingSessionWorkCount();
          if (pending !== 0) {
            problems.push(
              `meetings service retained ${pending} pending session(s) after finalization`,
            );
          }
        }
      } catch (error) {
        // error-policy:J1 scenario cleanup translates quiescence failure into a failed invariant.
        problems.push(
          `meetings service quiescence failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        const ledgerProblem = finalizeMockMeetingProviderLedger(runtime);
        if (ledgerProblem) problems.push(ledgerProblem);
      }
      return problems.length > 0 ? problems.join("; ") : undefined;
    },
  };
}
