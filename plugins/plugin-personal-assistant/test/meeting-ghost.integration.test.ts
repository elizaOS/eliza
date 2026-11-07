/**
 * Meeting-ghost consumer integration test.
 *
 * Drives `runMeetingGhostForTranscript` against the REAL `PgApprovalQueue` on a
 * PGlite-backed runtime (same harness as approval-queue.integration.test.ts) —
 * no mocked queue. Proves the dead-code gap is closed: a realistic diarized
 * `TranscriptSegment[]` flows through the pure analyzer and every derived
 * follow-up/calendar approval lands as a real, resolvable `pending` row the
 * owner can approve.
 *
 * Run: bunx vitest run plugins/plugin-personal-assistant/test/meeting-ghost.integration.test.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { AgentEventService, getConnectorAccountManager } from "@elizaos/core";
import type { TranscriptSegment } from "@elizaos/core/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApprovalQueue } from "../src/lifeops/approval-queue.js";
import type { ApprovalQueue } from "../src/lifeops/approval-queue.types.js";
import { runMeetingGhostForTranscript } from "../src/lifeops/meeting-ghost/consumer.js";
import { handleMeetingTranscriptFinalized } from "../src/lifeops/meeting-ghost/event-handler.js";
import { resolveOwnerFactStore } from "../src/lifeops/owner/fact-store.js";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { createLifeOpsTestRuntime } from "./helpers/runtime.js";

let runtime: AgentRuntime;
let cleanup: () => Promise<void>;
let queue: ApprovalQueue;
let isolatedStateDir: string;
let isolatedConfigPath: string;
let senderGrantId: string;
let senderAccountId: string;

const isolatedEnvKeys = [
  "ELIZA_STATE_DIR",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
] as const;

const previousEnv = new Map<string, string | undefined>();

function setIsolatedEnv(): void {
  isolatedStateDir = mkdtempSync(join(tmpdir(), "meeting-ghost-state-"));
  isolatedConfigPath = join(isolatedStateDir, "eliza.json");
  writeFileSync(
    isolatedConfigPath,
    JSON.stringify({ logging: { level: "error" } }),
    "utf8",
  );
  for (const key of isolatedEnvKeys) {
    previousEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.ELIZA_STATE_DIR = isolatedStateDir;
  process.env.ELIZA_CONFIG_PATH = isolatedConfigPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = isolatedConfigPath;
}

function restoreEnv(): void {
  for (const key of isolatedEnvKeys) {
    const value = previousEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

function seg(
  speakerLabel: string,
  startMs: number,
  text: string,
): TranscriptSegment {
  return {
    id: `${speakerLabel}-${startMs}`,
    speakerLabel,
    startMs,
    endMs: startMs + 8_000,
    text,
    words: [],
  };
}

beforeAll(async () => {
  setIsolatedEnv();
  const result = await createLifeOpsTestRuntime();
  runtime = result.runtime;
  cleanup = result.cleanup;
  if (!runtime.getService(AgentEventService.serviceType)) {
    await runtime.registerService(AgentEventService);
    await runtime.getServiceLoadPromise(AgentEventService.serviceType);
  }
  queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
}, 180_000);

afterAll(async () => {
  await cleanup();
  restoreEnv();
  rmSync(isolatedStateDir, { recursive: true, force: true });
});

describe("meeting-ghost consumer (real approval queue)", () => {
  it("leaves approvals and commitments untouched when no email sender is connected", async () => {
    await expect(
      runMeetingGhostForTranscript(runtime, {
        agentId: runtime.agentId,
        owner: {
          ownerUserId: "owner-mtg-unconnected",
          ownerDisplayName: "Synthetic owner",
          requestedBy: "meeting-ghost",
          careAbouts: [],
          approvalExpiresAt: new Date(Date.now() + 86_400_000),
        },
        transcript: {
          meetingId: "unconnected-meeting",
          title: "Synthetic planning",
          startedAt: "2026-09-11T16:00:00.000Z",
          attendees: [{ name: "Ava", email: "ava@example.test" }],
          segments: [
            seg("Mira", 0, "Ava will send the school schedule by 2026-09-15."),
          ],
        },
      }),
    ).rejects.toThrow();
    expect(
      await queue.list({
        subjectUserId: "owner-mtg-unconnected",
        state: null,
        action: null,
      }),
    ).toEqual([]);
    const records = await new LifeOpsRepository(
      runtime,
    ).listCommitmentLedgerRecords(runtime.agentId, { source: "transcript" });
    expect(
      records.filter((record) =>
        record.sourceKey.startsWith("unconnected-meeting:"),
      ),
    ).toEqual([]);
  }, 60_000);

  it("enqueues follow-up + calendar approvals from a diarized transcript, resolvable by the owner", async () => {
    const manager = getConnectorAccountManager(runtime);
    if (!manager.getProvider("google"))
      manager.registerProvider({ provider: "google" });
    const sender = await manager.upsertAccount("google", {
      id: "meeting-owner",
      provider: "google",
      role: "OWNER",
      purpose: ["messaging"],
      accessGate: "owner_binding",
      status: "connected",
      displayHandle: "meeting-owner@example.test",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
      },
    });
    senderAccountId = sender.id;
    senderGrantId = `connector-account:${sender.id}`;
    const approvalExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const result = await runMeetingGhostForTranscript(runtime, {
      agentId: runtime.agentId,
      owner: {
        ownerUserId: "owner-mtg-1",
        ownerDisplayName: "Shaw",
        requestedBy: "meeting-ghost",
        careAbouts: ["launch date"],
        calendarId: "primary",
        approvalExpiresAt,
      },
      transcript: {
        meetingId: "ops-sync-integration",
        title: "Ops Sync",
        startedAt: "2026-07-06T16:00:00.000Z",
        timeZone: "UTC",
        attendees: [
          { name: "Ava", email: "ava@example.com" },
          { name: "Ben", email: "ben@example.com" },
        ],
        segments: [
          seg("Ava", 0, "Morning, nothing blocking on my side."),
          seg(
            "Mira",
            60_000,
            "Ava will send the launch-date rollback plan by 2026-07-10.",
          ),
          seg(
            "Mira",
            120_000,
            "Ben is going to update the public calendar by 2026-07-10.",
          ),
        ],
      },
    });

    // Two commitments → two follow-up emails + two dated calendar deadlines.
    expect(result.analysis.commitments).toHaveLength(2);
    expect(result.enqueued).toHaveLength(4);
    expect(result.commitmentLedgerIds).toHaveLength(2);
    expect(result.enqueued.every((r) => r.state === "pending")).toBe(true);

    const actions = result.enqueued.map((r) => r.action).sort();
    expect(actions).toEqual([
      "schedule_event",
      "schedule_event",
      "send_email",
      "send_email",
    ]);

    // The rows are real, listable, and resolvable — not a fire-and-forget stub.
    const pending = await queue.list({
      subjectUserId: "owner-mtg-1",
      state: "pending",
      action: null,
      limit: 20,
    });
    expect(pending.length).toBeGreaterThanOrEqual(4);

    const repo = new LifeOpsRepository(runtime);
    const ledgerRows = await repo.listCommitmentLedgerRecords(runtime.agentId, {
      source: "transcript",
    });
    const meetingRows = ledgerRows.filter((row) =>
      row.sourceKey.startsWith("ops-sync-integration:"),
    );
    expect(meetingRows).toHaveLength(2);
    expect(meetingRows.map((row) => row.summary).sort()).toEqual([
      "send the launch-date rollback plan",
      "update the public calendar",
    ]);
    expect(meetingRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          counterparty: "Ava",
          dueAt: "2026-07-10T17:00:00.000Z",
          status: "open",
          metadata: expect.objectContaining({
            meetingId: "ops-sync-integration",
            meetingTitle: "Ops Sync",
            sourceText:
              "Ava will send the launch-date rollback plan by 2026-07-10.",
          }),
        }),
      ]),
    );

    const rerun = await runMeetingGhostForTranscript(runtime, {
      agentId: runtime.agentId,
      owner: {
        ownerUserId: "owner-mtg-1",
        ownerDisplayName: "Shaw",
        requestedBy: "meeting-ghost",
        careAbouts: ["launch date"],
        calendarId: "primary",
        approvalExpiresAt,
      },
      transcript: {
        meetingId: "ops-sync-integration",
        title: "Ops Sync",
        startedAt: "2026-07-06T16:00:00.000Z",
        timeZone: "UTC",
        attendees: [
          { name: "Ava", email: "ava@example.com" },
          { name: "Ben", email: "ben@example.com" },
        ],
        segments: [
          seg("Ava", 0, "Morning, nothing blocking on my side."),
          seg(
            "Mira",
            60_000,
            "Ava will send the launch-date rollback plan by 2026-07-10.",
          ),
          seg(
            "Mira",
            120_000,
            "Ben is going to update the public calendar by 2026-07-10.",
          ),
        ],
      },
    });
    expect(rerun.enqueued.map((request) => request.id).sort()).toEqual(
      result.enqueued.map((request) => request.id).sort(),
    );
    const pendingAfterRerun = await queue.list({
      subjectUserId: "owner-mtg-1",
      state: "pending",
      action: null,
      limit: 20,
    });
    expect(pendingAfterRerun).toHaveLength(pending.length);
    const ledgerRowsAfterRerun = await repo.listCommitmentLedgerRecords(
      runtime.agentId,
      {
        source: "transcript",
      },
    );
    expect(
      ledgerRowsAfterRerun.filter((row) =>
        row.sourceKey.startsWith("ops-sync-integration:"),
      ),
    ).toHaveLength(2);

    const firstEmail = result.enqueued.find((r) => r.action === "send_email");
    if (!firstEmail) throw new Error("expected a send_email approval");
    const approved = await queue.approve(
      firstEmail.id,
      firstEmail.subjectUserId,
      {
        resolvedBy: "owner-mtg-1",
        resolutionReason: "send it",
      },
    );
    expect(approved.state).toBe("approved");
    if (approved.payload.action !== "send_email") {
      throw new Error("expected send_email payload");
    }
    expect(approved.payload.to).toEqual(["ava@example.com"]);
    expect(approved.payload.grantId).toBe(senderGrantId);
    expect(approved.reason).toContain("From: meeting-owner@example.test");
    for (const approval of result.analysis.followUpApprovals) {
      expect(approval.payload).toMatchObject({ grantId: senderGrantId });
      expect(approval.reason).toContain("From: meeting-owner@example.test");
    }
  }, 60_000);
  it("rejects revoked send permission before creating follow-ups and preserves existing sender bindings", async () => {
    const manager = getConnectorAccountManager(runtime);
    const sender = await manager.getAccount("google", senderAccountId);
    if (!sender) throw new Error("Fixture sender missing");
    await manager.upsertAccount("google", {
      ...sender,
      metadata: {
        grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      },
    });
    await expect(
      runMeetingGhostForTranscript(runtime, {
        agentId: runtime.agentId,
        owner: {
          ownerUserId: "owner-mtg-revoked",
          ownerDisplayName: "Synthetic owner",
          requestedBy: "meeting-ghost",
          careAbouts: [],
          approvalExpiresAt: new Date(Date.now() + 86_400_000),
        },
        transcript: {
          meetingId: "revoked-sender-meeting",
          title: "School planning",
          startedAt: "2026-09-11T16:00:00.000Z",
          attendees: [{ name: "Ava", email: "ava@example.test" }],
          segments: [
            seg("Mira", 0, "Ava will send the school schedule by 2026-09-15."),
          ],
        },
      }),
    ).rejects.toThrow();
    expect(
      await queue.list({
        subjectUserId: "owner-mtg-revoked",
        state: null,
        action: null,
      }),
    ).toEqual([]);
    const previous = await queue.list({
      subjectUserId: "owner-mtg-1",
      state: null,
      action: "send_email",
    });
    expect(previous).not.toHaveLength(0);
    for (const request of previous)
      expect(request.payload).toMatchObject({ grantId: senderGrantId });
  }, 60_000);
});

describe("finalized transcript commitments on the owner's local day (#32880)", () => {
  function ownerSeg(
    id: string,
    startMs: number,
    text: string,
  ): TranscriptSegment {
    return {
      id,
      speakerLabel: "Shaw",
      speakerEntityId: "owner-local-day",
      startMs,
      endMs: startMs + 8_000,
      text,
      words: [],
    };
  }

  // Drives the production finalized-event handler, so both the segment-keyed
  // transcript projection and the meeting-ghost consumer write real rows.
  async function finalizeInOwnerZone(input: {
    timeZone: string;
    transcriptId: string;
    meetingId: string;
    createdAt: string;
    segments: TranscriptSegment[];
  }) {
    await resolveOwnerFactStore(runtime).update(
      { timezone: input.timeZone },
      { source: "profile_save", recordedAt: new Date().toISOString() },
    );
    const createdAt = Date.parse(input.createdAt);
    await handleMeetingTranscriptFinalized({
      runtime,
      source: "test",
      session: {
        id: input.meetingId,
        platform: "google_meet",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        nativeMeetingId: "abc-defg-hij",
        botName: "Eliza Notetaker",
        status: "ended",
        requestedAt: createdAt - 60_000,
        activeAt: createdAt,
        endedAt: createdAt + 600_000,
        transcriptId: input.transcriptId,
        participants: [{ id: "owner", displayName: "Shaw" }],
      },
      transcript: {
        id: input.transcriptId,
        title: "Evening planning",
        createdAt,
        durationMs: 600_000,
        source: "meeting",
        scope: "owner-private",
        status: "ready",
        speakerCount: 2,
        segments: input.segments,
      },
      ghostAttendance: {
        ownerUserId: "owner-local-day",
        ownerDisplayName: "Shaw",
        careAbouts: [],
        // No attendee emails: no follow-up drafts, so no sender grant needed.
        attendees: [{ name: "Ava" }],
      },
    });
    const rows = await new LifeOpsRepository(
      runtime,
    ).listCommitmentLedgerRecords(runtime.agentId, { source: "transcript" });
    return rows.filter(
      (row) =>
        row.sourceKey.startsWith(`${input.transcriptId}:`) ||
        row.sourceKey.startsWith(`${input.meetingId}:`),
    );
  }

  it("resolves an evening 'tomorrow' in Los Angeles to 17:00 Pacific the next local day, persisted once", async () => {
    const rows = await finalizeInOwnerZone({
      timeZone: "America/Los_Angeles",
      transcriptId: "transcript-local-day",
      meetingId: "meeting-local-day",
      // Monday 2026-09-14 17:30 Pacific is already Tuesday in UTC.
      createdAt: "2026-09-14T17:30:00-07:00",
      segments: [
        ownerSeg("seg-1", 0, "I will send the report tomorrow."),
        ownerSeg("seg-2", 30_000, "I will book the venue by tomorrow."),
        seg("Ava", 60_000, "Ava will draft the agenda by tomorrow."),
      ],
    });

    // One row per spoken commitment: the owner's promises come only from the
    // segment-keyed transcript projection, Ava's only from the meeting ghost.
    expect(rows.map((row) => row.sourceKey).sort()).toEqual([
      expect.stringMatching(/^meeting-local-day:/),
      "transcript-local-day:seg-1",
      "transcript-local-day:seg-2",
    ]);
    const bySummary = new Map(rows.map((row) => [row.summary, row]));
    expect(bySummary.get("I will send the report tomorrow")).toMatchObject({
      sourceKey: "transcript-local-day:seg-1",
      dueAt: "2026-09-16T00:00:00.000Z",
      metadata: expect.objectContaining({
        observedAt: "2026-09-15T00:30:00.000Z",
      }),
    });
    expect(bySummary.get("I will book the venue by tomorrow")?.dueAt).toBe(
      "2026-09-16T00:00:00.000Z",
    );
    expect(bySummary.get("draft the agenda")).toMatchObject({
      counterparty: "Ava",
      dueAt: "2026-09-16T00:00:00.000Z",
    });
  }, 60_000);

  it("resolves a morning weekday in Tokyo on the local calendar while UTC is still the previous day", async () => {
    const rows = await finalizeInOwnerZone({
      timeZone: "Asia/Tokyo",
      transcriptId: "transcript-local-day-tokyo",
      meetingId: "meeting-local-day-tokyo",
      // Tuesday 2026-09-15 08:00 JST is still Monday in UTC.
      createdAt: "2026-09-15T08:00:00+09:00",
      segments: [
        ownerSeg("seg-1", 0, "I'll send the budget on Wednesday."),
        ownerSeg("seg-2", 30_000, "I will call the vendor tomorrow."),
      ],
    });

    // Both fall on Wednesday 2026-09-16 at 17:00 JST.
    expect(rows.map((row) => [row.sourceKey, row.dueAt]).sort()).toEqual([
      ["transcript-local-day-tokyo:seg-1", "2026-09-16T08:00:00.000Z"],
      ["transcript-local-day-tokyo:seg-2", "2026-09-16T08:00:00.000Z"],
    ]);
  }, 60_000);
});
