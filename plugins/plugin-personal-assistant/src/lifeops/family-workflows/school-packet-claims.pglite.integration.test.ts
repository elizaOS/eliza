/**
 * Real-runtime proof that the monthly family packet projects each school
 * notice's current revisions only: a correction or cancellation replaces the
 * revision it supersedes, and an unresolved contradiction stays visible.
 */

import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import type { MonthlyFamilyPacket } from "../family-coordination/index.js";
import { getSchoolSourceFactRuntimeService } from "../school/service.js";
import {
  type IngestSchoolNoticeInput,
  type SchoolNoticeExtraction,
  sha256,
} from "../school/types.js";
import { selectedFamilyPacketPeriod } from "./period.js";
import { FamilyWorkflowRuntimeService } from "./runtime.js";

function notice(args: {
  reference: string;
  content: string;
  sequence: number;
  extraction: Pick<SchoolNoticeExtraction, "noticeKey" | "title"> &
    Partial<SchoolNoticeExtraction>;
}): IngestSchoolNoticeInput {
  return {
    artifact: {
      kind: "gmail",
      sourceId: "school-mail",
      stableReference: args.reference,
      snapshotReference: `gmail:${args.reference}`,
      sourceActor: {
        kind: "external",
        id: "school-mail",
        label: "Lincoln School",
      },
      observedAt: "2026-10-20T12:00:00.000Z",
      retrievedAt: "2026-10-20T12:00:00.000Z",
      effectiveAt: null,
      contentSha256: sha256(args.content),
      untrustedContent: args.content,
      visibility: "household",
    },
    extraction: {
      kind: "event",
      childReference: {
        preferredName: null,
        externalChildId: null,
        schoolName: "Lincoln School",
        grade: null,
        teamName: null,
      },
      timing: null,
      deadlines: [],
      forms: [],
      cost: null,
      location: null,
      contact: null,
      nextActions: [],
      correctsNoticeKey: null,
      cancelsNoticeKey: null,
      ...args.extraction,
    },
    confidence: 0.95,
    authority: "school_notice",
    version: { sequence: args.sequence, externalVersion: `v${args.sequence}` },
    extractorId: "packet-test-extractor",
    extractorVersion: "1.0.0",
    responsibility: null,
  };
}

function dateTiming(startDate: string, endDateExclusive: string) {
  return { kind: "date" as const, startDate, endDateExclusive };
}

function noticeClaimIds(
  packet: MonthlyFamilyPacket,
  noticeKey: string,
): string[] {
  return packet.claims
    .filter((claim) => claim.stableKey === `school.notice:${noticeKey}`)
    .map((claim) => claim.claimId)
    .sort();
}

function schoolContradictions(packet: MonthlyFamilyPacket): readonly string[] {
  return (
    packet.sections.find((summary) => summary.section === "school")
      ?.contradictoryKeys ?? []
  );
}

describe("monthly family packet school claims — real runtime", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
  }, 180_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  function school() {
    const service = getSchoolSourceFactRuntimeService(runtime);
    if (!service) throw new Error("school source-fact service is missing");
    return service;
  }

  async function packet(): Promise<MonthlyFamilyPacket> {
    return new FamilyWorkflowRuntimeService(runtime).generatePacket(
      selectedFamilyPacketPeriod("2026-12"),
    );
  }

  it("presents only the corrected revision of a school notice", async () => {
    const original = await school().ingestSchoolNotice(
      notice({
        reference: "field-trip",
        content: "Field trip to the science museum on December 10.",
        sequence: 1,
        extraction: {
          noticeKey: "field-trip",
          title: "Science museum field trip on December 10",
          timing: dateTiming("2026-12-10", "2026-12-11"),
        },
      }),
    );
    const corrected = await school().ingestSchoolNotice(
      notice({
        reference: "field-trip-correction",
        content:
          "Correction: the science museum field trip moves to December 17.",
        sequence: 2,
        extraction: {
          noticeKey: "field-trip-correction",
          kind: "correction",
          correctsNoticeKey: "field-trip",
          title: "Science museum field trip on December 17",
          timing: dateTiming("2026-12-17", "2026-12-18"),
        },
      }),
    );
    expect(corrected.noticeResolution.supersededFactIds).toEqual([
      original.sourceFact.id,
    ]);

    const result = await packet();

    expect(noticeClaimIds(result, "field-trip")).toEqual([
      `school:${corrected.sourceFact.id}`,
    ]);
    expect(schoolContradictions(result)).not.toContain(
      "school.notice:field-trip",
    );
  }, 180_000);

  it("presents the cancellation instead of the cancelled notice", async () => {
    await school().ingestSchoolNotice(
      notice({
        reference: "science-night",
        content: "Science night is December 3.",
        sequence: 1,
        extraction: {
          noticeKey: "science-night",
          title: "Science night on December 3",
          timing: dateTiming("2026-12-03", "2026-12-04"),
        },
      }),
    );
    const cancelled = await school().ingestSchoolNotice(
      notice({
        reference: "science-night-cancellation",
        content: "Science night will not take place.",
        sequence: 2,
        extraction: {
          noticeKey: "science-night-cancellation",
          kind: "cancellation",
          cancelsNoticeKey: "science-night",
          title: "Science night cancelled",
        },
      }),
    );
    expect(cancelled.noticeResolution.state).toBe("cancelled");

    const result = await packet();

    expect(noticeClaimIds(result, "science-night")).toEqual([
      `school:${cancelled.sourceFact.id}`,
    ]);
    expect(schoolContradictions(result)).not.toContain(
      "school.notice:science-night",
    );
  }, 180_000);

  it("keeps both sides of an unresolved contradiction", async () => {
    const first = await school().ingestSchoolNotice(
      notice({
        reference: "concert-a",
        content: "The winter concert is December 14.",
        sequence: 1,
        extraction: {
          noticeKey: "concert",
          title: "Winter concert",
          timing: dateTiming("2026-12-14", "2026-12-15"),
        },
      }),
    );
    const second = await school().ingestSchoolNotice(
      notice({
        reference: "concert-b",
        content: "The winter concert is December 15.",
        sequence: 1,
        extraction: {
          noticeKey: "concert",
          title: "Winter concert",
          timing: dateTiming("2026-12-15", "2026-12-16"),
        },
      }),
    );
    expect(second.noticeResolution.state).toBe("conflicted");

    const result = await packet();

    expect(noticeClaimIds(result, "concert")).toEqual(
      [
        `school:${first.sourceFact.id}`,
        `school:${second.sourceFact.id}`,
      ].sort(),
    );
    expect(schoolContradictions(result)).toContain("school.notice:concert");
  }, 180_000);
});
