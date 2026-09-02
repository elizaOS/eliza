/**
 * Real-PGlite behavioral coverage for immutable agreement knowledge. The
 * runtime uses the production graph, household authorization, migrations, and
 * content-addressed file service; only PDF fixture bytes are synthetic.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import {
  type AgentRuntime,
  documentsPluginCore,
  type Plugin,
  Service,
  ServiceType,
  type UUID,
} from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalFileStorageService } from "../../../../../packages/agent/src/services/file-storage.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import {
  AgreementKnowledgeError,
  createAgreementKnowledgeService,
  type ParentingAgreementArtifact,
} from "./agreement-knowledge.js";
import {
  getHouseholdCoordinationService,
  type HouseholdCoordinationService,
} from "./service.js";

const fileStoragePlugin: Plugin = {
  name: "agreement-knowledge-test-file-storage",
  description: "Production content-addressed file storage for agreement tests.",
  services: [LocalFileStorageService],
};

class AgreementTestPdfService extends Service {
  static override serviceType = ServiceType.PDF;
  override capabilityDescription =
    "Deterministic complete PDF extraction for agreement domain tests";

  async stop(): Promise<void> {}

  async extractCompleteDocument(bytes: Buffer | Uint8Array) {
    const text = Buffer.from(bytes).toString("utf8");
    return {
      complete: true as const,
      pageCount: 12,
      pages: Array.from({ length: 12 }, (_, index) => ({
        pageNumber: index + 1,
        width: 612,
        height: 792,
        method: "native" as const,
        nativeText: text,
        ocrText: null,
        visionText: null,
        text,
        hasVisualContent: false,
      })),
      text: Array.from(
        { length: 12 },
        (_, index) => `--- Page ${index + 1} ---\n${text}`,
      ).join("\n\n"),
    };
  }
}

function pdf(label: string): Buffer {
  return Buffer.from(`%PDF-1.7\n${label}\n%%EOF\n`, "utf8");
}

describe("parenting-agreement knowledge — real PGlite", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let household: HouseholdCoordinationService;
  let artifact: ParentingAgreementArtifact;
  let guestHouseholdGrantId: string;
  let mediaStateDir: string;

  beforeAll(async () => {
    mediaStateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "agreement-knowledge-media-"),
    );
    process.env.ELIZA_STATE_DIR = mediaStateDir;
    runtimeResult = await createLifeOpsTestRuntime({
      plugins: [fileStoragePlugin, documentsPluginCore],
    });
    runtime = runtimeResult.runtime;
    runtime.services.set(ServiceType.PDF, [
      new AgreementTestPdfService(runtime),
    ]);
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    const entities = graph.getEntityStore(runtime.agentId);
    await entities.ensureSelf();
    await entities.upsert({
      entityId: "child-one",
      type: "person",
      preferredName: "Child One",
      identities: [],
      tags: [],
      visibility: "owner_only",
      state: {},
    });
    await entities.upsert({
      entityId: "verified-co-parent",
      type: "person",
      preferredName: "Verified Co-parent",
      identities: [
        {
          platform: "imessage",
          handle: "+15555550101",
          verified: true,
          confidence: 1,
          addedAt: "2026-01-01T00:00:00.000Z",
          addedVia: "user_chat",
          evidence: ["Owner verified the co-parent's iMessage identity."],
        },
      ],
      tags: [],
      visibility: "owner_only",
      state: {},
    });
    await entities.upsert({
      entityId: "unverified-guest",
      type: "person",
      preferredName: "Unverified Guest",
      identities: [
        {
          platform: "email",
          handle: "unverified@example.test",
          verified: false,
          confidence: 0.5,
          addedAt: "2026-01-01T00:00:00.000Z",
          addedVia: "user_chat",
          evidence: ["Unverified address supplied in chat."],
        },
      ],
      tags: [],
      visibility: "owner_only",
      state: {},
    });

    household = getHouseholdCoordinationService(
      runtime,
    ) as HouseholdCoordinationService;
    await household.bindRole({
      entityId: "child-one",
      role: "child",
      subjectEntityIds: [],
      evidence: "Owner identified the child for agreement access boundaries.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    await household.bindRole({
      entityId: "verified-co-parent",
      role: "co_parent",
      subjectEntityIds: ["child-one"],
      evidence: "Owner verified the co-parent relationship.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    await household.bindRole({
      entityId: "unverified-guest",
      role: "caregiver",
      subjectEntityIds: ["child-one"],
      evidence:
        "Owner recorded a caregiver relationship without identity verification.",
      boundByEntityId: SELF_ENTITY_ID,
    });
    const householdGrant = await household.issueGrant({
      principalEntityId: "verified-co-parent",
      role: "co_parent",
      subjectEntityIds: ["child-one"],
      scopes: ["knowledge.read"],
      issuedByEntityId: SELF_ENTITY_ID,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    guestHouseholdGrantId = householdGrant.id;
  });

  afterAll(async () => {
    await runtimeResult?.cleanup();
    delete process.env.ELIZA_STATE_DIR;
    fs.rmSync(mediaStateDir, { recursive: true, force: true });
  });

  it("stores immutable content-addressed versions and rejects duplicate bytes", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const firstBytes = pdf("agreement version one");
    artifact = await service.createAgreementVersion({
      agreementKey: "parenting-plan",
      title: "Parenting plan",
      originalFilename: "parenting-plan.pdf",
      mimeType: "application/pdf",
      bytes: firstBytes,
      uploadedByEntityId: SELF_ENTITY_ID,
    });
    expect(artifact).toMatchObject({
      version: 1,
      supersedesArtifactId: null,
      contentSha256: crypto
        .createHash("sha256")
        .update(firstBytes)
        .digest("hex"),
      mimeType: "application/pdf",
      byteSize: firstBytes.byteLength,
      pageCount: 12,
    });
    expect(artifact.mediaUrl).toBe(
      `/api/lifeops/agreements/${artifact.id}/download`,
    );
    await expect(
      runtime.getMemoryById(artifact.documentId as UUID),
    ).resolves.toMatchObject({
      metadata: {
        scope: "owner-private",
        pinned: false,
        mediaUrl: artifact.mediaUrl,
        mediaHash: artifact.contentSha256,
      },
    });

    await expect(
      service.createAgreementVersion({
        agreementKey: "parenting-plan",
        title: "Duplicate",
        originalFilename: "duplicate.pdf",
        mimeType: "application/pdf",
        bytes: firstBytes,
        uploadedByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_DUPLICATE_CONTENT" });

    const second = await service.createAgreementVersion({
      agreementKey: "parenting-plan",
      title: "Parenting plan amended",
      originalFilename: "parenting-plan-amended.pdf",
      mimeType: "application/pdf",
      bytes: pdf("agreement version two"),
      uploadedByEntityId: SELF_ENTITY_ID,
    });
    expect(second).toMatchObject({
      version: 2,
      supersedesArtifactId: artifact.id,
    });
    await expect(
      service.createAgreementVersion({
        agreementKey: "parenting-plan",
        title: "Old content replay",
        originalFilename: "old-content.pdf",
        mimeType: "application/pdf",
        bytes: firstBytes,
        uploadedByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_DUPLICATE_CONTENT" });
    await expect(
      service.readFor({
        artifactId: artifact.id,
        principalEntityId: SELF_ENTITY_ID,
      }),
    ).resolves.toMatchObject({
      artifact: { version: 1, title: "Parenting plan" },
    });
  });

  it("requires valid page citations and makes review decisions terminal", async () => {
    const service = createAgreementKnowledgeService(runtime);
    await expect(
      service.proposeObligation({
        artifactId: artifact.id,
        title: "Invalid citation",
        obligationText: "This must never persist.",
        pageStart: 12,
        pageEnd: 13,
        citationText: "Outside the source page range.",
        proposedByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_INVALID_CONTRACT" });

    const approved = await service.proposeObligation({
      artifactId: artifact.id,
      title: "School notice",
      obligationText: "Share school notices within twenty-four hours.",
      pageStart: 4,
      pageEnd: 5,
      citationText: "Each parent shall forward school notices within 24 hours.",
      proposedByEntityId: runtime.agentId,
    });
    expect(approved).toMatchObject({
      status: "proposed",
      pageStart: 4,
      pageEnd: 5,
      proposedByEntityId: runtime.agentId,
    });
    const decided = await service.decideObligation({
      obligationId: approved.id,
      decision: "approve",
      decidedByEntityId: SELF_ENTITY_ID,
      reason: "Owner checked the cited pages against the signed PDF.",
    });
    expect(decided).toMatchObject({
      status: "approved",
      decidedByEntityId: SELF_ENTITY_ID,
      citationText: approved.citationText,
    });
    await expect(
      service.decideObligation({
        obligationId: approved.id,
        decision: "reject",
        decidedByEntityId: SELF_ENTITY_ID,
        reason: "Attempted reversal.",
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_OBLIGATION_CONFLICT" });

    const rejected = await service.proposeObligation({
      artifactId: artifact.id,
      title: "Unsupported interpretation",
      obligationText: "An unsupported model interpretation.",
      pageStart: 8,
      citationText: "Source text retained for the rejection record.",
      proposedByEntityId: SELF_ENTITY_ID,
    });
    await service.decideObligation({
      obligationId: rejected.id,
      decision: "reject",
      decidedByEntityId: SELF_ENTITY_ID,
      reason: "The source does not support this interpretation.",
    });
  });

  it("keeps agent and chat pins separate from guest authorization", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const agentPin = await service.pin({
      artifactId: artifact.id,
      targetType: "agent",
      targetId: runtime.agentId,
      pinnedByEntityId: SELF_ENTITY_ID,
    });
    await service.pin({
      artifactId: artifact.id,
      targetType: "chat",
      targetId: "family-chat",
      pinnedByEntityId: SELF_ENTITY_ID,
    });
    await expect(
      service.readFor({
        artifactId: artifact.id,
        principalEntityId: "verified-co-parent",
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_ACCESS_DENIED" });

    await service.unpin({
      pinId: agentPin.id,
      unpinnedByEntityId: SELF_ENTITY_ID,
    });

    const pinned = await service.activePinnedContext({
      ownerEntityId: SELF_ENTITY_ID,
      roomId: "family-chat",
    });
    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.obligations).toHaveLength(1);
    expect(pinned[0]?.obligations[0]?.status).toBe("approved");
    await expect(
      service.activePinnedContext({
        ownerEntityId: SELF_ENTITY_ID,
        roomId: "different-chat",
      }),
    ).resolves.toEqual([]);

    const ownerList = await service.listOwnerAgreements({
      ownerEntityId: SELF_ENTITY_ID,
    });
    expect(ownerList.map((view) => view.artifact.version)).toEqual([2, 1]);
    await expect(
      service.listOwnerAgreements({ ownerEntityId: "verified-co-parent" }),
    ).rejects.toMatchObject({ code: "AGREEMENT_ACCESS_DENIED" });
  });

  it("requires verified identity plus an exact active household grant", async () => {
    const service = createAgreementKnowledgeService(runtime);
    await service.pin({
      artifactId: artifact.id,
      targetType: "chat",
      targetId: "family-chat",
      pinnedByEntityId: SELF_ENTITY_ID,
    });
    await expect(
      service.activePinnedContextForPrincipal({
        principalEntityId: "verified-co-parent",
        roomId: "family-chat",
      }),
    ).resolves.toEqual([]);
    const unverifiedGrant = await household.issueGrant({
      principalEntityId: "unverified-guest",
      role: "caregiver",
      subjectEntityIds: ["child-one"],
      scopes: ["knowledge.read"],
      issuedByEntityId: SELF_ENTITY_ID,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    await expect(
      service.grantGuestRead({
        artifactId: artifact.id,
        principalEntityId: "unverified-guest",
        householdGrantId: unverifiedGrant.id,
        issuedByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_ACCESS_DENIED" });

    await expect(
      service.previewGuestRead({
        artifactId: artifact.id,
        principalEntityId: "unverified-guest",
        householdGrantId: unverifiedGrant.id,
        ownerEntityId: SELF_ENTITY_ID,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      denial: { code: "AGREEMENT_ACCESS_DENIED" },
      exclusions: expect.arrayContaining(["inherit_access_from_pin"]),
    });

    await expect(
      service.previewGuestRead({
        artifactId: artifact.id,
        principalEntityId: "verified-co-parent",
        householdGrantId: guestHouseholdGrantId,
        ownerEntityId: SELF_ENTITY_ID,
      }),
    ).resolves.toMatchObject({
      allowed: true,
      denial: null,
      effects: ["read_artifact_metadata", "read_approved_obligations"],
    });

    const resourceGrant = await service.grantGuestRead({
      artifactId: artifact.id,
      principalEntityId: "verified-co-parent",
      householdGrantId: guestHouseholdGrantId,
      issuedByEntityId: SELF_ENTITY_ID,
    });
    const guestView = await service.readFor({
      artifactId: artifact.id,
      principalEntityId: "verified-co-parent",
    });
    expect(guestView.obligations).toHaveLength(1);
    expect(guestView.obligations[0]).toMatchObject({
      status: "approved",
      pageStart: 4,
      pageEnd: 5,
    });
    for (const forbidden of [
      "mediaUrl",
      "mediaFileName",
      "contentSha256",
      "documentId",
      "agentId",
      "uploadedByEntityId",
      "householdId",
      "agreementKey",
      "supersedesArtifactId",
    ]) {
      expect(guestView.artifact).not.toHaveProperty(forbidden);
    }
    for (const forbidden of [
      "agentId",
      "artifactId",
      "proposedByEntityId",
      "decidedByEntityId",
      "decisionReason",
      "createdAt",
      "updatedAt",
    ]) {
      expect(guestView.obligations[0]).not.toHaveProperty(forbidden);
    }
    const guestPinned = await service.activePinnedContextForPrincipal({
      principalEntityId: "verified-co-parent",
      roomId: "family-chat",
    });
    expect(guestPinned).toEqual([guestView]);

    const restartedService = createAgreementKnowledgeService(runtime);
    await expect(
      restartedService.readFor({
        artifactId: artifact.id,
        principalEntityId: "verified-co-parent",
      }),
    ).resolves.toMatchObject({ artifact: { id: artifact.id, version: 1 } });

    await service.revokeGuestRead({
      grantId: resourceGrant.id,
      revokedByEntityId: SELF_ENTITY_ID,
      reason: "Owner removed access.",
    });
    await expect(
      restartedService.readFor({
        artifactId: artifact.id,
        principalEntityId: "verified-co-parent",
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_ACCESS_DENIED" });
    await expect(
      restartedService.activePinnedContextForPrincipal({
        principalEntityId: "verified-co-parent",
        roomId: "family-chat",
      }),
    ).resolves.toEqual([]);
  });

  it("fails closed after household-grant revocation or expiry", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const expiring = await household.issueGrant({
      principalEntityId: "verified-co-parent",
      role: "co_parent",
      subjectEntityIds: ["child-one"],
      scopes: ["knowledge.read"],
      issuedByEntityId: SELF_ENTITY_ID,
      expiresAt: "2099-06-01T00:00:00.000Z",
    });
    await service.grantGuestRead({
      artifactId: artifact.id,
      principalEntityId: "verified-co-parent",
      householdGrantId: expiring.id,
      issuedByEntityId: SELF_ENTITY_ID,
    });
    await expect(
      service.readFor({
        artifactId: artifact.id,
        principalEntityId: "verified-co-parent",
        at: new Date("2100-01-01T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_ACCESS_DENIED" });

    await household.revokeGrant({
      grantId: expiring.id,
      revokedByEntityId: SELF_ENTITY_ID,
      reason: "Relationship access was revoked.",
    });
    await expect(
      service.readFor({
        artifactId: artifact.id,
        principalEntityId: "verified-co-parent",
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_ACCESS_DENIED" });
  });

  it("rejects non-owner mutations and malformed PDF input", async () => {
    const service = createAgreementKnowledgeService(runtime);
    await expect(
      service.createAgreementVersion({
        agreementKey: "guest-write",
        title: "Guest write",
        originalFilename: "guest.pdf",
        mimeType: "application/pdf",
        bytes: pdf("guest"),
        uploadedByEntityId: "verified-co-parent",
      }),
    ).rejects.toBeInstanceOf(AgreementKnowledgeError);
    await expect(
      service.createAgreementVersion({
        agreementKey: "not-pdf",
        title: "Not PDF",
        originalFilename: "not-pdf.pdf",
        mimeType: "application/pdf",
        bytes: Buffer.from("not actually a PDF"),
        uploadedByEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_INVALID_CONTRACT" });
  });
});
