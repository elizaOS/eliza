/**
 * MOCKED happy-path join → transcript (#11856, `pr-deterministic` — no browser,
 * no ASR, no model key). Drives the REAL JOIN_MEETING + GET_MEETING_TRANSCRIPT
 * handlers and the REAL MeetingService/transcript writer; only the browser bot
 * and the ASR are mocked (via the seed-installed mock dependency factory).
 *
 * Deterministic action turns are used deliberately: this lane must be reliable
 * and keyless. LIVE model→action routing is proven separately in
 * live-model-join-meeting.scenario.ts. The mock adapter auto-ends the meeting
 * (`holdUntilLeave: false`) so the real finalize path writes a `ready`
 * transcript row that GET_MEETING_TRANSCRIPT reads back with the scripted text.
 */

import type { UUID } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioDefinition,
} from "@elizaos/scenario-runner/schema";
import { installMockSeed } from "./_meetings-mock.js";

const MEET_URL = "https://meet.google.com/abc-defg-hij";

async function transcriptHasScriptedText(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as {
    getService(name: string): {
      listSessions(): Array<{ transcriptId?: string }>;
    } | null;
    getMemoryById(
      id: UUID,
    ): Promise<{ content: Record<string, unknown> } | null>;
  };
  const service = runtime.getService("meetings");
  if (!service) return "meetings service not running";
  const session = service.listSessions()[0];
  if (!session?.transcriptId) return "no session with a transcript was created";
  const row = await runtime.getMemoryById(session.transcriptId as UUID);
  if (!row) return `transcript row ${session.transcriptId} missing`;
  const raw = (row.content as { transcript?: unknown }).transcript;
  if (typeof raw !== "string") {
    return "transcript row has no serialized transcript";
  }
  const parsed = JSON.parse(raw) as {
    status?: string;
    segments?: Array<{ text?: string; speakerLabel?: string }>;
  };
  const segs = parsed.segments ?? [];
  if (segs.length < 2) return `expected >=2 segments, saw ${segs.length}`;
  const text = segs.map((s) => s.text ?? "").join(" ");
  if (!/roadmap/i.test(text)) {
    return `scripted text not found in transcript: ${text.slice(0, 200)}`;
  }
  const speakers = new Set(segs.map((s) => s.speakerLabel));
  if (!(speakers.has("Alice") && speakers.has("Bob"))) {
    return `expected Alice + Bob speaker labels, saw ${[...speakers].join(",")}`;
  }
  return undefined;
}

export default {
  id: "mock-join-meeting-happy",
  lane: "pr-deterministic",
  title: "Mocked JOIN_MEETING produces a scripted transcript (no browser)",
  domain: "meetings",
  tags: ["mock", "meetings", "join-meeting", "transcript"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-meetings"] },
  seed: [installMockSeed()],
  rooms: [{ id: "main", source: "chat", title: "Mock Meeting Join" }],
  turns: [
    {
      kind: "action",
      name: "agent joins the Google Meet as a notetaker",
      room: "main",
      actionName: "JOIN_MEETING",
      text: `join ${MEET_URL} and take notes`,
      assertResponse(text) {
        if (!/joining the google meet/i.test(text)) {
          return `expected a 'joining the Google Meet' confirmation, got: ${text.slice(0, 160)}`;
        }
      },
    },
    {
      kind: "wait",
      name: "let the mock meeting finalize its transcript",
      durationMs: 400,
    },
    {
      kind: "action",
      name: "agent returns the transcript text",
      room: "main",
      actionName: "GET_MEETING_TRANSCRIPT",
      text: "show me the transcript of that meeting",
      assertResponse(text) {
        if (!/roadmap/i.test(text)) {
          return `expected the scripted transcript text, got: ${text.slice(0, 200)}`;
        }
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      name: "JOIN_MEETING executed successfully",
      actionName: "JOIN_MEETING",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      name: "GET_MEETING_TRANSCRIPT executed successfully",
      actionName: "GET_MEETING_TRANSCRIPT",
      status: "success",
      minCount: 1,
    },
    {
      type: "custom",
      name: "transcript row holds the scripted two-speaker text",
      predicate: transcriptHasScriptedText,
    },
  ],
} satisfies ScenarioDefinition;
