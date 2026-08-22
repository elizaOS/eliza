/**
 * Deterministic per-plugin e2e for the transcript permissioning actions of
 * `@elizaos/plugin-local-inference` (issue #14779): the direct
 * `SHARE_TRANSCRIPT` -> `TranscriptStore` path proven end to end, not at the
 * unit boundary.
 *
 * The seed writes one meeting transcript containing PII (email + phone) into
 * the transcripts partition, owned by the scenario's ADMIN requester. The turn
 * asks the agent to redact it for every persisted room participant. The planner
 * fixture routes to `SHARE_TRANSCRIPT` with `redactForAll`, which mints the
 * deterministic redacted variant, snapshots the roster, and materializes one
 * grant per participant on the original row.
 *
 * The effect proof reads the store back the way the API route does — through
 * the ONE role-aware disclosure predicate (#14781): the colleague (USER, with
 * the redacted grant) gets the variant served under the original id with PII
 * scrubbed, while an ADMIN viewer gets the untouched original with raw PII.
 * This text-permissioning fixture intentionally has no retained audio; verified
 * audio publication is covered by the agent audio-redaction integration suite.
 * Handler success without those two disclosures
 * differing is not proof, so the check fails on either leak or missing redaction.
 */
import {
  type AgentRuntime,
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

/** Stable ids so the action turn can name the transcript and grantee. */
const TRANSCRIPT_ID = stringToUuid(
  "scenario:transcript-permissioning:meeting-1",
) as UUID;
const COLLEAGUE_ID = "a11ce000-0000-4000-8000-000000000001" as UUID;
const SECOND_COLLEAGUE_ID = "b0b00000-0000-4000-8000-000000000003" as UUID;
const ADMIN_VIEWER_ID = "ad311000-0000-4000-8000-000000000002" as UUID;

const ALICE_EMAIL = "alice@example.com";
const ALICE_PHONE = "415-555-0199";
const BOB_EMAIL = "bob@example.com";

type R = AgentRuntime;

function buildTranscript(ownerHint: string): Transcript {
  return {
    id: TRANSCRIPT_ID,
    title: `Q3 Payroll Sync (${ownerHint})`,
    createdAt: 1_700_000_000_000,
    endedAt: 1_700_000_600_000,
    durationMs: 600_000,
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
    metadata: {
      consent: { state: "granted" },
      participants: [
        { id: "alice", displayName: "Alice", entityId: COLLEAGUE_ID },
        { id: "bob", displayName: "Bob", entityId: SECOND_COLLEAGUE_ID },
      ],
    },
  };
}

export default scenario({
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "fixtures",
    fixtures: [],
  },
  id: "local-inference.transcript-permissioning",
  title: "Local inference: redact a meeting transcript for its room roster",
  domain: "local-inference",
  tags: ["local-inference", "voice", "security", "permissioning", "memory"],
  description:
    "Exercises SHARE_TRANSCRIPT end to end: an admin asks the agent to redact a PII-bearing meeting transcript for every persisted room participant; both users get the redacted variant while an admin viewer keeps the full original. Keyless deterministic proxy; verified audio has a separate real-byte integration suite.",

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
      kind: "action",
      name: "share-redacted",
      actionName: SHARE_TRANSCRIPT,
      options: {
        parameters: {
          transcriptId: TRANSCRIPT_ID,
          redactForAll: true,
          mode: "redacted",
        },
      },
      text: `Redact the meeting transcript ${TRANSCRIPT_ID} for everyone in that meeting room. Keep the full original available only to admins.`,
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
      // (PII scrubbed), and an admin viewer must still get the
      // untouched original — handler success is not enough on its own.
      type: "custom",
      name: "redacted-to-colleague-full-to-admin",
      predicate: async (ctx) => {
        const runtime = ctx.runtime as R;
        const store = new TranscriptStore(
          runtime as unknown as TranscriptStoreRuntime,
        );

        for (const colleagueId of [COLLEAGUE_ID, SECOND_COLLEAGUE_ID]) {
          const colleagueView = await store.get(TRANSCRIPT_ID, {
            requesterEntityId: colleagueId,
            role: "USER",
          });
          if (!colleagueView) {
            return `room participant ${colleagueId} saw nothing (expected the redacted variant)`;
          }
          if (colleagueView.redacted !== true) {
            return `room participant ${colleagueId} view was not flagged redacted`;
          }
          if (colleagueView.audioUrl !== undefined)
            return "audio-less fixture unexpectedly produced a participant audioUrl";
          const colleagueText = colleagueView.segments
            .map((s) => s.text)
            .join(" ");
          if (
            colleagueText.includes(ALICE_EMAIL) ||
            colleagueText.includes(ALICE_PHONE) ||
            colleagueText.includes(BOB_EMAIL)
          ) {
            return `redacted participant view leaked PII: ${colleagueText}`;
          }
          if (!colleagueText.includes("[EMAIL]")) {
            return `redacted participant view did not scrub email: ${colleagueText}`;
          }
        }

        const originalRow = await runtime.getMemoryById(TRANSCRIPT_ID);
        const share = (originalRow?.metadata as Record<string, unknown> | undefined)
          ?.share as
          | { roomSnapshot?: { roomId?: string; entityIds?: string[] } }
          | undefined;
        if (
          share?.roomSnapshot?.entityIds?.join(",") !==
          [COLLEAGUE_ID, SECOND_COLLEAGUE_ID].join(",")
        ) {
          return "room snapshot did not persist the exact participant roster";
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
        if (adminView.audioUrl !== undefined)
          return "audio-less fixture unexpectedly produced an admin audioUrl";
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
