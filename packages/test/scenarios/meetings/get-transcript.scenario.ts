/**
 * Keyless per-plugin e2e for `@elizaos/plugin-meetings` (issue #8801, cluster 1
 * of #15759).
 *
 * Drives the `GET_MEETING_TRANSCRIPT` action end-to-end against a real
 * MeetingService whose browser adapters + ASR pipeline are replaced by scripted
 * mocks (via `MeetingService.dependencyFactory`, overridden in the seed after
 * the plugin module is imported so the override survives registration). The
 * seed registers the plugin itself, drives a real `requestJoin` on a Google
 * Meet URL, lets the mock adapter/pipeline run the full lifecycle to a
 * finalized transcript record, and waits for the session to reach a terminal
 * state — so the persisted transcript the action reads is produced by the real
 * session state machine + transcript writer (#15704 finalization path), with no
 * browser, no live meeting, and no credentials.
 */
import type { AgentRuntime, UUID } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import type {
  MeetingBotSession,
  MeetingPipelineInstance,
  MeetingPlatformAdapter,
  MeetingService,
  MeetingServiceDependencies,
} from "@elizaos/plugin-meetings";
import { scenario } from "@elizaos/scenario-runner/schema";
import type {
  MeetingPlatform,
  MeetingSession,
  TranscriptSegment,
} from "@elizaos/shared";
import {
  callPayloadBlob,
  describeCalls,
  successfulActionData,
} from "../_helpers/effect-assertions.ts";

const GET_MEETING_TRANSCRIPT = "GET_MEETING_TRANSCRIPT";
const MEET_URL = "https://meet.google.com/abc-defg-hij";
const SEGMENT_TEXT = "the quarterly roadmap review is on track for friday";
const SPEAKER = "Alex";

type R = AgentRuntime & {
  registerPlugin: (plugin: unknown) => Promise<unknown>;
  getService: (name: string) => unknown;
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

let joinedTranscriptId: string | undefined;

/**
 * A scripted ASR pipeline: emits exactly one confirmed segment when the adapter
 * pushes audio, and returns the accumulated segments on finalize — the same
 * confirmed/pending update flow the real pipeline drives, minus the model.
 */
function createMockPipeline(): MeetingPipelineInstance {
  let listener:
    | ((update: {
        confirmed: TranscriptSegment[];
        pending: TranscriptSegment[];
      }) => void)
    | null = null;
  const segments: TranscriptSegment[] = [];
  const makeSegment = (): TranscriptSegment => ({
    id: `seg-${segments.length + 1}`,
    speakerLabel: SPEAKER,
    startMs: segments.length * 1000,
    endMs: segments.length * 1000 + 900,
    text: SEGMENT_TEXT,
    words: [],
  });
  return {
    onUpdate(l) {
      listener = l;
      return () => {
        listener = null;
      };
    },
    pushSpeakerAudio() {
      const segment = makeSegment();
      segments.push(segment);
      listener?.({ confirmed: [segment], pending: [] });
    },
    setSpeakerName() {},
    flushSpeaker() {},
    participantJoined() {},
    participantLeft() {},
    async finalize() {
      return segments;
    },
    speakerNames() {
      return [SPEAKER];
    },
  };
}

/** A scripted Google Meet adapter: join → one speaker turn → normal completion. */
const mockAdapter: MeetingPlatformAdapter = {
  platform: "google_meet",
  async run(session: MeetingBotSession) {
    session.reportStatus("joining");
    session.reportStatus("active");
    session.sink.participantJoined({
      id: "p-alex",
      displayName: SPEAKER,
      joinedAtMs: 0,
    });
    session.sink.setSpeakerName("spk-alex", SPEAKER);
    session.sink.pushSpeakerAudio("spk-alex", new Float32Array(320));
    session.sink.flushSpeaker("spk-alex");
    return "normal_completion";
  },
};

export default scenario({
  lane: "pr-deterministic",
  id: "meetings.get-transcript",
  title:
    "Meetings: read a finalized meeting transcript via GET_MEETING_TRANSCRIPT",
  domain: "meetings",
  tags: ["smoke", "meetings", "transcripts"],
  description:
    "Reads a finalized meeting transcript through the GET_MEETING_TRANSCRIPT action, backed by a real MeetingService driven with scripted browser/ASR mocks — keyless, no browser or live meeting.",

  requires: { plugins: ["@elizaos/plugin-meetings"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "meetings-mock-join-and-fixtures",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;

        // Import the plugin FIRST (evaluates its module, which sets the real
        // dependencyFactory), then override with scripted mocks. The module is
        // cached, so the executor's later auto-load will not re-run it and reset
        // the factory back to the browser adapters.
        const meetings = (await import("@elizaos/plugin-meetings")) as {
          MeetingService: typeof MeetingService;
          meetingsPlugin: unknown;
        };
        const dependencies: MeetingServiceDependencies = {
          adapters: new Map<MeetingPlatform, MeetingPlatformAdapter>([
            ["google_meet", mockAdapter],
          ]),
          createPipeline: () => createMockPipeline(),
        };
        meetings.MeetingService.dependencyFactory = () => dependencies;

        await runtime.registerPlugin(meetings.meetingsPlugin);

        const svc = runtime.getService("meetings") as MeetingService;
        const session = await svc.requestJoin({
          platform: "google_meet",
          meetingUrl: MEET_URL,
        });
        joinedTranscriptId = session.transcriptId;

        // The mock adapter completes synchronously; wait for the session state
        // machine + transcript writer to reach a terminal state so the persisted
        // transcript is finalized ("ready") before the turn reads it.
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const current = svc.getSession(
            session.id as UUID,
          ) as MeetingSession | null;
          if (
            current &&
            (current.status === "ended" || current.status === "failed")
          ) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        runtime.scenarioLlmFixtures?.register(
          {
            name: "meetings-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) =>
                v.includes("transcript") || v.includes("meeting"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["meetings"],
              intents: ["show me the meeting transcript"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [GET_MEETING_TRANSCRIPT],
            },
            times: 1,
          },
          {
            name: "meetings-planner",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.ACTION_PLANNER &&
              call.toolNames.includes(GET_MEETING_TRANSCRIPT),
            response: {
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
            times: 1,
          },
          {
            name: "meetings-decision",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.RESPONSE_HANDLER &&
              !call.toolNames.includes("HANDLE_RESPONSE"),
            response: {
              success: true,
              decision: "FINISH",
              thought: "Returned the meeting transcript; nothing more to do.",
              messageToUser: "Here's the transcript from your last meeting.",
            },
            times: 1,
          },
        );
        return undefined;
      },
    },
  ],

  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Meetings" },
  ],

  turns: [
    {
      kind: "message",
      name: "get-transcript",
      text: "Show me the transcript from my last meeting — what was said?",
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find(
          (a) => a.actionName === GET_MEETING_TRANSCRIPT,
        );
        if (!call) {
          return `Expected ${GET_MEETING_TRANSCRIPT} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${GET_MEETING_TRANSCRIPT} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
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
      // Effect proof (#11381): the action returned the transcript that the real
      // session lifecycle finalized — the id matches the joined session's
      // transcript, and the reply carries the transcribed speech — not just
      // "the handler returned success".
      type: "custom",
      name: "meetings-transcript-effect",
      predicate: (ctx) => {
        if (!joinedTranscriptId) {
          return "the mock meeting never produced a transcript id in the seed";
        }
        const data = successfulActionData(ctx, GET_MEETING_TRANSCRIPT);
        if (!data) {
          return `no successful ${GET_MEETING_TRANSCRIPT} result data; calls: ${describeCalls(ctx)}`;
        }
        if (data.transcriptId !== joinedTranscriptId) {
          return `expected result.data.transcriptId ${joinedTranscriptId} (the finalized session's transcript), saw ${String(data.transcriptId ?? "(missing)")}`;
        }
        const blob = callPayloadBlob(ctx, GET_MEETING_TRANSCRIPT);
        if (!blob.includes(SEGMENT_TEXT)) {
          return `expected the transcribed speech "${SEGMENT_TEXT}" in the ${GET_MEETING_TRANSCRIPT} reply, saw ${blob.slice(0, 300)}`;
        }
      },
    },
  ],
});
