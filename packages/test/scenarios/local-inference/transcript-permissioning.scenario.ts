/**
 * Deterministic per-plugin e2e for the transcript permissioning actions of
 * `@elizaos/plugin-local-inference` (issue #14779): the message -> planner ->
 * `SHARE_TRANSCRIPT` -> `TranscriptStore` path proven end to end, not at the
 * unit boundary.
 *
 * The seed writes one meeting transcript containing PII (email + phone) into
 * the transcripts partition, owned by the scenario's ADMIN requester. The turn
 * asks the agent to share it with a non-privileged colleague, redacted. The
 * planner fixture routes to `SHARE_TRANSCRIPT` with `mode: "redacted"`, which
 * mints the deterministic redacted variant and writes a per-entity grant on the
 * original row.
 *
 * The effect proof reads the store back the way the API route does — through
 * the ONE role-aware disclosure predicate (#14781): the colleague (USER, with
 * the redacted grant) gets the variant served under the original id with audio
 * withheld and PII scrubbed, while an ADMIN viewer gets the untouched original
 * with audio and raw PII intact. Handler success without those two disclosures
 * differing is not proof, so the check fails on either leak or missing redaction.
 */
import {
  type AgentRuntime,
  ModelType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import {
  TranscriptStore,
  type TranscriptStoreRuntime,
} from "@elizaos/plugin-local-inference/services/voice/transcript-store";
import { scenario } from "@elizaos/scenario-runner/schema";
import type { Transcript } from "@elizaos/shared";

const SHARE_TRANSCRIPT = "SHARE_TRANSCRIPT";

/** Stable ids so the planner fixture can name the transcript + grantee. */
const TRANSCRIPT_ID = stringToUuid(
  "scenario:transcript-permissioning:meeting-1",
) as UUID;
const COLLEAGUE_ID = "a11ce000-0000-4000-8000-000000000001" as UUID;
const ADMIN_VIEWER_ID = "ad311000-0000-4000-8000-000000000002" as UUID;

const ALICE_EMAIL = "alice@example.com";
const ALICE_PHONE = "415-555-0199";
const BOB_EMAIL = "bob@example.com";

type R = AgentRuntime & {
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

function buildTranscript(ownerHint: string): Transcript {
  return {
    id: TRANSCRIPT_ID,
    title: `Q3 Payroll Sync (${ownerHint})`,
    createdAt: 1_700_000_000_000,
    endedAt: 1_700_000_600_000,
    durationMs: 600_000,
    audioUrl: "/api/media/deadbeef.wav",
    audioContentType: "audio/wav",
    segments: [
      {
        id: "seg-1",
        speakerLabel: "Alice",
        startMs: 0,
        endMs: 8_000,
        text: `You can reach me at ${ALICE_EMAIL} or on ${ALICE_PHONE} after the call.`,
        words: [],
      },
      {
        id: "seg-2",
        speakerLabel: "Bob",
        startMs: 8_000,
        endMs: 15_000,
        text: `Thanks Alice, I will forward the deck to ${BOB_EMAIL} tonight.`,
        words: [],
      },
    ],
    source: "meeting",
    scope: "owner-private",
    status: "ready",
    speakerCount: 2,
  };
}

export default scenario({
  lane: "pr-deterministic",
  id: "local-inference.transcript-permissioning",
  title: "Local inference: share a meeting transcript redacted to a colleague",
  domain: "local-inference",
  tags: ["local-inference", "voice", "security", "permissioning", "memory"],
  description:
    "Exercises SHARE_TRANSCRIPT end to end: an admin asks the agent to share a PII-bearing meeting transcript with a non-privileged colleague; the colleague gets the redacted variant (audio withheld, PII scrubbed) while an admin viewer keeps the full original. Keyless deterministic proxy.",

  requires: { plugins: ["@elizaos/plugin-local-inference"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "seed-meeting-transcript-with-pii",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;
        const owner = (ctx.primaryUserId ?? runtime.agentId) as UUID;
        const roomId = (ctx.primaryRoomId ?? runtime.agentId) as UUID;

        const store = new TranscriptStore(
          runtime as unknown as TranscriptStoreRuntime,
        );
        await store.create({
          roomId,
          entityId: owner,
          transcript: buildTranscript(owner),
        });

        runtime.scenarioLlmFixtures?.register(
          {
            name: "transcript-permissioning-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) => v.toLowerCase().includes("share"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["voice"],
              intents: ["share a meeting transcript, redacted"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [SHARE_TRANSCRIPT],
            },
            times: 1,
          },
          {
            name: "transcript-permissioning-planner",
            match: {
              modelType: ModelType.ACTION_PLANNER,
              input: (v: string) => v.toLowerCase().includes("share"),
              toolName: SHARE_TRANSCRIPT,
            },
            response: {
              text: "",
              thought:
                "Alice is not an admin, so share the transcript with her as a redacted variant.",
              messageToUser: "",
              completed: true,
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "call-share-transcript",
                  name: SHARE_TRANSCRIPT,
                  type: "function",
                  arguments: {
                    transcriptId: TRANSCRIPT_ID,
                    entityId: COLLEAGUE_ID,
                    mode: "redacted",
                  },
                },
              ],
            },
            times: 1,
          },
          {
            name: "transcript-permissioning-decision",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.RESPONSE_HANDLER &&
              !call.toolNames.includes("HANDLE_RESPONSE"),
            response: {
              success: true,
              decision: "FINISH",
              thought: "Redacted transcript shared; nothing more to do.",
              messageToUser: "Shared the redacted transcript with Alice.",
            },
            times: 1,
          },
        );
        return undefined;
      },
    },
  ],

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Meeting transcript",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "share-redacted",
      text: `Share the meeting transcript ${TRANSCRIPT_ID} with Alice (${COLLEAGUE_ID}). She is not an admin, so send her the redacted version.`,
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find(
          (a) => a.actionName === SHARE_TRANSCRIPT,
        );
        if (!call) {
          return `Expected ${SHARE_TRANSCRIPT} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${SHARE_TRANSCRIPT} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: SHARE_TRANSCRIPT,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof: read the store the way the disclosure route does. A
      // non-privileged colleague with the redacted grant must get the variant
      // (audio withheld, PII scrubbed), and an admin viewer must still get the
      // untouched original — handler success is not enough on its own.
      type: "custom",
      name: "redacted-to-colleague-full-to-admin",
      predicate: async (ctx) => {
        const runtime = ctx.runtime as R;
        const store = new TranscriptStore(
          runtime as unknown as TranscriptStoreRuntime,
        );

        const colleagueView = await store.get(TRANSCRIPT_ID, {
          requesterEntityId: COLLEAGUE_ID,
          role: "USER",
        });
        if (!colleagueView) {
          return "colleague with a redacted grant saw nothing (expected the redacted variant)";
        }
        if (colleagueView.redacted !== true) {
          return "colleague view was not flagged redacted";
        }
        if (colleagueView.audioUrl !== undefined) {
          return "redacted colleague view leaked audioUrl (audio is never redacted in v1 and must be withheld)";
        }
        const colleagueText = colleagueView.segments
          .map((s) => s.text)
          .join(" ");
        if (
          colleagueText.includes(ALICE_EMAIL) ||
          colleagueText.includes(ALICE_PHONE) ||
          colleagueText.includes(BOB_EMAIL)
        ) {
          return `redacted colleague view leaked PII: ${colleagueText}`;
        }
        if (!colleagueText.includes("[EMAIL]")) {
          return `redacted colleague view did not scrub email to a surrogate: ${colleagueText}`;
        }

        const adminView = await store.get(TRANSCRIPT_ID, {
          requesterEntityId: ADMIN_VIEWER_ID,
          role: "ADMIN",
        });
        if (!adminView) {
          return "admin viewer saw nothing (expected the full original)";
        }
        if (adminView.redacted) {
          return "admin viewer got a redacted view (admins retain full disclosure)";
        }
        if (adminView.audioUrl !== "/api/media/deadbeef.wav") {
          return "admin viewer lost the original audioUrl (the original must be untouched)";
        }
        const adminText = adminView.segments.map((s) => s.text).join(" ");
        if (
          !adminText.includes(ALICE_EMAIL) ||
          !adminText.includes(ALICE_PHONE)
        ) {
          return `admin viewer lost original PII, so the original was mutated by redaction: ${adminText}`;
        }
        return undefined;
      },
    },
  ],
});
