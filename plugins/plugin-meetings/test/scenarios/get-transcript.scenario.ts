/**
 * Exercises transcript retrieval through the real scenario runtime,
 * MeetingService state machine, and transcript repository. Browser capture and
 * ASR are the only synthetic boundaries; their scripted state is read back
 * from the production memory store before this scenario can pass.
 */

import type { UUID } from "@elizaos/core";
import {
  callPayloadBlob,
  describeCalls,
  successfulActionData,
} from "@elizaos/scenario-runner/scenario-assertions";
import {
  type ScenarioContext,
  scenario,
} from "@elizaos/scenario-runner/schema";
import {
  assertMeetingMockLedger,
  installMockSeed,
  joinedTranscriptIsReady,
  MEETINGS_MOCK_REQUIRED_PLUGINS,
} from "./_meetings-mock.js";

const GET_MEETING_TRANSCRIPT = "GET_MEETING_TRANSCRIPT";
const MEET_URL = "https://meet.google.com/abc-defg-hij";
const SEGMENT_TEXT = "the quarterly roadmap review is on track for friday";
const USER_REQUEST =
  "Show me the transcript from my last meeting — what was said?";

async function transcriptEffect(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const data = successfulActionData(ctx, GET_MEETING_TRANSCRIPT);
  if (!data) {
    return `no successful ${GET_MEETING_TRANSCRIPT} result data; calls: ${describeCalls(ctx)}`;
  }
  const transcriptId = data.transcriptId;
  if (typeof transcriptId !== "string") {
    return `expected a transcript id, saw ${String(transcriptId ?? "(missing)")}`;
  }
  const joined = successfulActionData(ctx, "JOIN_MEETING");
  if (joined?.transcriptId !== transcriptId) {
    return `expected retrieval of joined transcript ${String(joined?.transcriptId)}, saw ${transcriptId}`;
  }
  const row = await ctx.runtime.getMemoryById(transcriptId as UUID);
  if (!row) return `transcript row ${transcriptId} is missing`;
  const serialized = (row.content as { transcript?: unknown }).transcript;
  if (typeof serialized !== "string") {
    return `transcript row ${transcriptId} has no serialized transcript`;
  }
  const persisted = JSON.parse(serialized) as {
    status?: string;
    segments?: Array<{ speakerLabel?: string; text?: string }>;
  };
  if (persisted.status !== "ready") {
    return `expected transcript status ready, saw ${String(persisted.status)}`;
  }
  const segment = persisted.segments?.[0];
  if (segment?.speakerLabel !== "Alex" || segment.text !== SEGMENT_TEXT) {
    return `unexpected authoritative transcript readback: ${JSON.stringify(persisted.segments)}`;
  }
  const blob = callPayloadBlob(ctx, GET_MEETING_TRANSCRIPT);
  if (!blob.includes(SEGMENT_TEXT)) {
    return `expected the transcribed speech in the action result, saw ${blob.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "fixtures",
    fixtures: [
      {
        name: "meetings-transcript-stage1",
        match: {
          modelType: "RESPONSE_HANDLER",
          input: { includes: USER_REQUEST },
          toolNames: ["HANDLE_RESPONSE"],
        },
        response: {
          json: {
            contexts: ["meetings"],
            intents: ["show me the meeting transcript"],
            replyText: "",
            threadOps: [],
            candidateActionNames: [GET_MEETING_TRANSCRIPT],
          },
        },
      },
      {
        name: "meetings-transcript-planner",
        match: {
          modelType: "ACTION_PLANNER",
          input: { includes: USER_REQUEST },
          toolNames: [
            "GET_MEETING_TRANSCRIPT",
            "IGNORE",
            "REPLY",
            "RESOLVE_REQUEST",
            "RESOLVE_REQUEST_APPROVE",
            "RESOLVE_REQUEST_RECONCILE_DELIVERED",
            "RESOLVE_REQUEST_RECONCILE_NOT_DELIVERED",
            "RESOLVE_REQUEST_REJECT",
            "STOP",
          ],
        },
        response: {
          json: {
            text: "",
            thought: "Read the most recent meeting transcript.",
            messageToUser: "",
            completed: true,
            finishReason: "tool-calls",
            toolCalls: [
              {
                id: "call-transcript",
                name: GET_MEETING_TRANSCRIPT,
                type: "function",
                arguments: {},
              },
            ],
          },
        },
      },
      {
        name: "meetings-transcript-decision",
        match: {
          modelType: "RESPONSE_HANDLER",
          input: { includes: USER_REQUEST },
          toolNames: [],
        },
        response: {
          json: {
            success: true,
            decision: "FINISH",
            thought: "Returned the meeting transcript; nothing more to do.",
            messageToUser: "Here's the transcript from your last meeting.",
          },
        },
      },
      {
        name: "meetings-transcript-post-turn-evaluator",
        match: {
          modelType: "TEXT_SMALL",
          input: {
            pattern:
              "# Task: Post-turn evaluation[\\s\\S]*Show me the transcript from my last meeting — what was said\\?",
          },
          toolNames: [],
        },
        response: { json: {} },
        cardinality: 1,
      },
    ],
  },
  id: "meetings.get-transcript",
  title:
    "Meetings: read a finalized meeting transcript via GET_MEETING_TRANSCRIPT",
  domain: "meetings",
  tags: ["smoke", "meetings", "transcripts"],
  description:
    "Reads a finalized transcript through production meeting and memory paths with scripted capture and strict model fixtures.",
  requires: { plugins: MEETINGS_MOCK_REQUIRED_PLUGINS },
  isolation: "per-scenario",
  seed: [
    installMockSeed({
      "abc-defg-hij": {
        platform: "google_meet",
        holdUntilLeave: false,
        turns: [
          {
            speakerKey: "spk-alex",
            displayName: "Alex",
            startMs: 0,
            endMs: 900,
            text: SEGMENT_TEXT,
          },
        ],
      },
    }),
  ],
  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Meetings" },
  ],
  turns: [
    {
      kind: "action",
      name: "join the scripted meeting through the production action",
      actionName: "JOIN_MEETING",
      text: `join ${MEET_URL} and take notes`,
    },
    {
      kind: "wait",
      name: "wait for the authoritative transcript row to become ready",
      timeoutMs: 5_000,
      until: joinedTranscriptIsReady,
    },
    {
      kind: "message",
      name: "get-transcript",
      text: USER_REQUEST,
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find(
          (action) => action.actionName === GET_MEETING_TRANSCRIPT,
        );
        if (!call) {
          return `Expected ${GET_MEETING_TRANSCRIPT} but got: ${turn.actionsCalled
            .map((action) => action.actionName)
            .join(", ")}`;
        }
        return call.result?.success
          ? undefined
          : `${GET_MEETING_TRANSCRIPT} did not succeed: ${call.error?.message ?? call.result?.text ?? "unknown error"}`;
      },
    },
    {
      kind: "action",
      name: "strict meetings provider ledger matches",
      actionName: "ASSERT_MEETING_MOCK_LEDGER",
      assertTurn: assertMeetingMockLedger,
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: GET_MEETING_TRANSCRIPT,
      status: "success",
      minCount: 1,
    },
    {
      type: "custom",
      name: "transcript result matches the authoritative ready row",
      predicate: transcriptEffect,
    },
  ],
});
