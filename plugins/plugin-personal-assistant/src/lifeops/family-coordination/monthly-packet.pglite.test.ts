/**
 * Real-PGlite integration coverage for monthly family packet persistence,
 * provenance, contradictions, one-time carry-forward, privacy, expense
 * exclusion, and immutable canonical-approval binding.
 */

import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApprovalEnqueueInput,
  ApprovalRequest,
} from "../approval-queue.types.js";
import type { RawSqlQuery } from "../sql.js";
import {
  type FamilyPacketClaim,
  type FamilyPacketPeriod,
  MonthlyFamilyPacketService,
} from "./monthly-packet.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function period(key: string): FamilyPacketPeriod {
  const [year, month] = key.split("-").map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  return {
    key,
    startsOn: `${key}-01`,
    endsOnExclusive: next.toISOString().slice(0, 10),
    timeZone: "America/New_York",
  };
}

function claim(
  id: string,
  overrides: Partial<FamilyPacketClaim> = {},
): FamilyPacketClaim {
  return {
    claimId: id,
    stableKey: id,
    section: "custody_calendar",
    statement: `Statement ${id}`,
    visibility: "guest_shareable",
    provenance: [
      {
        source: "calendar",
        sourceId: `source-${id}`,
        observedAt: "2026-08-30T12:00:00.000Z",
        contentSha256: digest(id),
      },
    ],
    dates: ["2026-09-03"],
    requests: [],
    urgency: null,
    commitments: [],
    accountability: [],
    recipientEntityIds: ["guest-1"],
    ...overrides,
  };
}

const guestDraft = {
  recipient: "guest@example.com",
  recipientEntityId: "guest-1",
  calendarPrivacyMode: "full" as const,
};

function approval(
  input: ApprovalEnqueueInput,
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return {
    id: "approval-1",
    createdAt: new Date("2026-08-30T12:00:00.000Z"),
    updatedAt: new Date("2026-08-30T12:00:00.000Z"),
    state: "pending",
    requestedBy: input.requestedBy,
    subjectUserId: input.subjectUserId,
    action: input.action,
    payload: input.payload,
    channel: input.channel,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey ?? null,
    expiresAt: input.expiresAt,
    resolvedAt: null,
    resolvedBy: null,
    resolutionReason: null,
    execution: null,
    ...overrides,
  };
}

describe("MonthlyFamilyPacketService with real PGlite", () => {
  let db: PGlite;
  let runtime: IAgentRuntime;
  let service: MonthlyFamilyPacketService;

  beforeEach(async () => {
    db = await PGlite.create();
    runtime = {
      agentId: "agent-a",
      getService: () => null,
      adapter: {
        db: {
          execute: async (query: RawSqlQuery) =>
            db.query(
              query.queryChunks.map((chunk) => chunk.value ?? "").join(""),
            ),
          transaction: async <T>(
            fn: (tx: {
              execute: (query: RawSqlQuery) => Promise<unknown>;
            }) => Promise<T> | T,
          ) =>
            db.transaction(async (transaction) =>
              fn({
                execute: async (query) =>
                  transaction.query(
                    query.queryChunks
                      .map((chunk) => chunk.value ?? "")
                      .join(""),
                  ),
              }),
            ),
        },
      },
    } as unknown as IAgentRuntime;
    service = new MonthlyFamilyPacketService(
      runtime,
      () => new Date("2026-08-30T12:00:00.000Z"),
    );
  });

  afterEach(async () => db.close());

  it("survives restart, preserves provenance, deduplicates content, and versions changed internal packets", async () => {
    const first = await service.buildInternal(period("2026-09"), [claim("a")]);
    const restarted = new MonthlyFamilyPacketService(runtime);
    const duplicate = await restarted.buildInternal(period("2026-09"), [
      claim("a"),
    ]);
    expect(duplicate.version).toBe(1);
    expect(duplicate.contentSha256).toBe(first.contentSha256);
    expect(duplicate.claims[0]?.provenance[0]?.sourceId).toBe("source-a");

    const changed = await restarted.buildInternal(period("2026-09"), [
      claim("a", { requests: ["Please confirm pickup by September 2."] }),
    ]);
    expect(changed.version).toBe(2);
    expect(changed.contentSha256).not.toBe(first.contentSha256);
  });

  it("distinguishes missing from contradictory sections and retains all conflicting provenance", async () => {
    const packet = await service.buildInternal(period("2026-09"), [
      claim("school-a", {
        stableKey: "school:first-day",
        section: "school",
        statement: "School starts September 1.",
        provenance: [
          {
            source: "school",
            sourceId: "district-pdf",
            observedAt: "2026-08-30T12:00:00.000Z",
            contentSha256: digest("pdf"),
          },
        ],
      }),
      claim("school-b", {
        stableKey: "school:first-day",
        section: "school",
        statement: "School starts September 2.",
        provenance: [
          {
            source: "knowledge",
            sourceId: "pinned-note",
            observedAt: "2026-08-29T12:00:00.000Z",
            contentSha256: digest("note"),
          },
        ],
      }),
    ]);
    expect(
      packet.sections.find((entry) => entry.section === "school")?.state,
    ).toBe("contradictory");
    expect(
      packet.sections.find((entry) => entry.section === "approved_obligations")
        ?.state,
    ).toBe("missing");
    const draft = await service.createExternalDraft(packet, guestDraft);
    expect(draft.body).toContain("Needs resolution");
    expect(draft.body).not.toContain("district-pdf");
    expect(draft.body).not.toContain("pinned-note");
  });

  it("carries an unanswered item forward exactly once", async () => {
    await service.buildInternal(period("2026-09"), [
      claim("answer-me", {
        section: "unanswered",
        unanswered: true,
        carryForwardCount: 0,
        requests: ["Please confirm."],
      }),
    ]);
    const october = await service.buildInternal(period("2026-10"), []);
    expect(october.claims).toHaveLength(1);
    expect(october.claims[0]?.carryForwardCount).toBe(1);
    expect(october.claims[0]?.carriedFromClaimId).toBe("answer-me");
    const november = await service.buildInternal(period("2026-11"), []);
    expect(november.claims).toHaveLength(0);
  });

  it("omits owner-only material, excludes unapproved obligations, and rejects expenses by construction", async () => {
    const packet = await service.buildInternal(period("2026-09"), [
      claim("private", {
        visibility: "owner_only",
        statement: "private medical detail canary",
      }),
      claim("obligation", {
        section: "approved_obligations",
        statement: "Unapproved notice canary",
        obligationApprovalId: null,
      }),
    ]);
    const draft = await service.createExternalDraft(packet, guestDraft);
    expect(draft.body).not.toContain("private medical detail canary");
    expect(draft.body).not.toContain("Unapproved notice canary");
    expect(draft.transformations.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "private_claim_omitted",
        "unapproved_obligation_omitted",
      ]),
    );

    await expect(
      service.buildInternal(period("2026-10"), [
        { ...claim("expense"), section: "expenses" } as never,
      ]),
    ).rejects.toMatchObject({ code: "FAMILY_PACKET_EXPENSE_FORBIDDEN" });
    await expect(
      service.buildInternal(period("2026-10"), [
        { ...claim("expense-class"), dataClass: "expense" } as never,
      ]),
    ).rejects.toMatchObject({ code: "FAMILY_PACKET_EXPENSE_FORBIDDEN" });
  });

  it("binds calendar projection to the recipient Entity and requested privacy mode", async () => {
    const packet = await service.buildInternal(period("2026-09"), [
      claim("custody", { statement: "Private custody title" }),
    ]);
    const wrongGuest = await service.createExternalDraft(packet, {
      ...guestDraft,
      recipientEntityId: "guest-2",
    });
    expect(wrongGuest.body).not.toContain("Private custody title");
    expect(wrongGuest.transformations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "recipient_acl_omitted" }),
      ]),
    );

    const timesOnly = await service.createExternalDraft(packet, {
      ...guestDraft,
      calendarPrivacyMode: "times_only",
    });
    expect(timesOnly.body).toContain("Scheduled event");
    expect(timesOnly.body).not.toContain("Private custody title");
    expect(timesOnly.body).not.toContain("source-custody");

    const busyOnly = await service.createExternalDraft(packet, {
      ...guestDraft,
      calendarPrivacyMode: "busy_only",
    });
    expect(busyOnly.body).toContain("Busy");
    expect(busyOnly.body).not.toContain("Private custody title");

    const full = await service.createExternalDraft(packet, guestDraft);
    expect(full.body).toContain("Private custody title");
  });

  it("omits agreement claims when the exact resource grant cannot be proven", async () => {
    const packet = await service.buildInternal(period("2026-09"), [
      claim("agreement", {
        section: "approved_obligations",
        statement: "Agreement obligation canary",
        obligationApprovalId: "approved-obligation",
        agreementArtifactId: "agreement-artifact",
      }),
    ]);
    const draft = await service.createExternalDraft(packet, guestDraft);
    expect(draft.body).not.toContain("Agreement obligation canary");
    expect(draft.transformations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agreement_grant_omitted" }),
      ]),
    );
  });

  it("preserves material fields without inventing apology, legal, or therapy claims", async () => {
    const packet = await service.buildInternal(period("2026-09"), [
      claim("travel", {
        section: "travel_consent_health",
        statement: "Trip is planned.",
        dates: ["2026-09-12 through 2026-09-15"],
        requests: ["Please provide consent by 2026-09-05."],
        urgency: "Reply needed before booking.",
        commitments: ["I will share the itinerary."],
        accountability: ["Alex owns the consent response."],
      }),
    ]);
    const draft = await service.createExternalDraft(packet, guestDraft);
    for (const exact of [
      "2026-09-12 through 2026-09-15",
      "Please provide consent by 2026-09-05.",
      "Reply needed before booking.",
      "I will share the itinerary.",
    ]) {
      expect(draft.body).toContain(exact);
    }
    expect(draft.body).not.toContain("Alex owns the consent response.");
    expect(draft.body.toLowerCase()).not.toMatch(
      /sorry|apolog|legal advice|therapy/,
    );
  });

  it("uses the canonical approval queue and rejects stale or tampered drafts and approvals", async () => {
    const packet = await service.buildInternal(period("2026-09"), [claim("a")]);
    const first = await service.createExternalDraft(packet, guestDraft);
    let enqueued: ApprovalRequest | null = null;
    const queue = {
      enqueueTransactional: vi.fn(async (input: ApprovalEnqueueInput) => {
        enqueued = approval(input);
        return { request: enqueued, reused: false };
      }),
      surfaceEnqueuedApproval: vi.fn(async () => undefined),
    };
    await service.enqueueDraftApproval({
      draft: first,
      queue,
      requestedBy: "owner",
      subjectUserId: "owner",
      expiresAt: new Date("2026-09-05T00:00:00.000Z"),
    });
    expect(queue.enqueueTransactional).toHaveBeenCalledOnce();
    expect(queue.surfaceEnqueuedApproval).toHaveBeenCalledOnce();
    await expect(
      service.readLatestDraft(packet.packetId),
    ).resolves.toMatchObject({
      draftVersion: first.draftVersion,
      recipientEntityId: "guest-1",
    });
    await expect(
      service.readDraftApprovalId(packet.packetId, first.draftVersion),
    ).resolves.toBe("approval-1");
    expect(enqueued?.payload).toMatchObject({
      action: "send_message",
      recipient: "guest@example.com",
      body: first.body,
    });

    const approved = {
      ...(enqueued as unknown as ApprovalRequest),
      state: "approved" as const,
    };
    await expect(
      service.validateApprovedDraft(approved),
    ).resolves.toMatchObject({
      bodySha256: first.bodySha256,
    });
    const tampered = {
      ...approved,
      payload: { ...approved.payload, body: `${first.body}\nchanged` },
    } as ApprovalRequest;
    await expect(service.validateApprovedDraft(tampered)).rejects.toMatchObject(
      {
        code: "FAMILY_PACKET_APPROVAL_TAMPERED",
      },
    );

    const second = await service.createExternalDraft(packet, guestDraft);
    expect(second.internalVersion).toBe(first.internalVersion);
    expect(second.draftVersion).toBe(first.draftVersion + 1);
    await expect(service.validateApprovedDraft(approved)).rejects.toMatchObject(
      {
        code: "FAMILY_PACKET_APPROVAL_STALE",
      },
    );
    await expect(
      service.enqueueDraftApproval({
        draft: { ...first, body: `${first.body}\ntampered` },
        queue,
        requestedBy: "owner",
        subjectUserId: "owner",
        expiresAt: new Date("2026-09-05T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "FAMILY_PACKET_DRAFT_TAMPERED" });
  });
});
