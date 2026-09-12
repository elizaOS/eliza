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
  attestAuthenticatedApiDeliveryAudience,
  ChannelType,
  documentsPluginCore,
  type IAgentRuntime,
  type Memory,
  type Plugin,
  Service,
  ServiceType,
  type UUID,
} from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalFileStorageService } from "../../../../../packages/agent/src/services/file-storage.js";
import { composeResponseState } from "../../../../../packages/core/src/services/message/provider-state.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import { executeRawSql, sqlQuote } from "../sql.js";
import {
  AgreementKnowledgeError,
  AgreementKnowledgeRepository,
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

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<AgreementTestPdfService> {
    return new AgreementTestPdfService(runtime);
  }

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
        nativePositionedText: [],
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

function readStoredZip(bytes: Buffer): Map<string, Buffer> {
  // Independently read ZIP local records rather than using the archive writer.
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    if (bytes.readUInt16LE(offset + 8) !== 0)
      throw new Error("Unsupported ZIP method");
    const size = bytes.readUInt32LE(offset + 18);
    const nameSize = bytes.readUInt16LE(offset + 26);
    const extraSize = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + nameSize + extraSize;
    const name = bytes
      .subarray(offset + 30, offset + 30 + nameSize)
      .toString("utf8");
    files.set(name, bytes.subarray(start, start + size));
    offset = start + size;
  }
  return files;
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

  it("composes approved pins on ordinary owner turns while preserving room and audience boundaries", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const ownerId = crypto.randomUUID() as UUID;
    const roomId = crypto.randomUUID() as UUID;
    const otherRoomId = crypto.randomUUID() as UUID;
    const previousOwner = runtime.getSetting("ELIZA_ADMIN_ENTITY_ID");
    runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", ownerId);
    await runtime.createEntity({
      id: ownerId,
      names: ["Pin owner"],
      agentId: runtime.agentId,
    });
    for (const id of [roomId, otherRoomId]) {
      await runtime.createRoom({
        id,
        source: "eliza-client",
        type: ChannelType.DM,
        worldId: runtime.agentId,
      });
      await runtime.addParticipant(ownerId, id);
      await runtime.addParticipant(runtime.agentId, id);
    }
    const compose = async (targetRoomId: UUID) => {
      const message: Memory = {
        id: crypto.randomUUID() as UUID,
        entityId: ownerId,
        agentId: runtime.agentId,
        roomId: targetRoomId,
        content: {
          text: "What approved agreement obligation applies here?",
          source: "eliza-client",
        },
      };
      await attestAuthenticatedApiDeliveryAudience(runtime, message, {
        kind: "owner_session",
        principalId: ownerId,
      });
      return composeResponseState(runtime, message);
    };
    let pin = await service.pin({
      artifactId: artifact.id,
      targetType: "chat",
      targetId: roomId,
      pinnedByEntityId: SELF_ENTITY_ID,
    });
    try {
      const state = await compose(roomId);
      expect(state.text).toContain(
        "Share school notices within twenty-four hours.",
      );
      expect(state.text).toContain("source pages 4-5");
      expect(state.text).not.toContain("An unsupported model interpretation.");
      expect((await compose(otherRoomId)).text).not.toContain(
        "Share school notices within twenty-four hours.",
      );

      await service.unpin({
        pinId: pin.id,
        unpinnedByEntityId: SELF_ENTITY_ID,
      });
      expect((await compose(roomId)).text).not.toContain(
        "Share school notices within twenty-four hours.",
      );
      pin = await service.pin({
        artifactId: artifact.id,
        targetType: "agent",
        targetId: runtime.agentId,
        pinnedByEntityId: SELF_ENTITY_ID,
      });
      expect((await compose(otherRoomId)).text).toContain(
        "Share school notices within twenty-four hours.",
      );

      const guestId = crypto.randomUUID() as UUID;
      await runtime.createEntity({
        id: guestId,
        names: ["Other participant"],
        agentId: runtime.agentId,
      });
      await runtime.addParticipant(guestId, roomId);
      expect((await compose(roomId)).text).not.toContain(
        "Share school notices within twenty-four hours.",
      );
    } finally {
      await service.unpin({
        pinId: pin.id,
        unpinnedByEntityId: SELF_ENTITY_ID,
      });
      runtime.setSetting(
        "ELIZA_ADMIN_ENTITY_ID",
        typeof previousOwner === "string" || typeof previousOwner === "boolean"
          ? previousOwner
          : null,
      );
    }
  });

  it("persists pin provenance atomically and rolls back when the audit ledger rejects it", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const targetId = crypto.randomUUID();
    const pin = await service.pin({
      artifactId: artifact.id,
      targetType: "chat",
      targetId,
      pinnedByEntityId: SELF_ENTITY_ID,
    });
    const events = await executeRawSql(
      runtime,
      `SELECT inputs_json, decision_json FROM app_lifeops.life_audit_events
       WHERE agent_id = ${sqlQuote(runtime.agentId)}
         AND owner_type = 'parenting_agreement'
         AND owner_id = ${sqlQuote(artifact.id)}
         AND event_type = 'agreement_pinned'
         AND decision_json::jsonb->>'id' = ${sqlQuote(pin.id)}`,
    );
    expect(events).toHaveLength(1);
    expect(JSON.parse(String(events[0].inputs_json))).toMatchObject({
      actorEntityId: SELF_ENTITY_ID,
      source: {
        id: artifact.id,
        version: artifact.version,
        content_sha256: artifact.contentSha256,
      },
    });
    expect(JSON.parse(String(events[0].decision_json))).toMatchObject({
      id: pin.id,
      target_id: targetId,
      unpinned_at: null,
    });
    await service.unpin({ pinId: pin.id, unpinnedByEntityId: SELF_ENTITY_ID });
    await executeRawSql(
      runtime,
      `CREATE FUNCTION app_lifeops.reject_agreement_audit_test()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'audit persistence unavailable';
      END $$`,
    );
    await executeRawSql(
      runtime,
      `CREATE TRIGGER reject_agreement_audit_test
      BEFORE INSERT ON app_lifeops.life_audit_events FOR EACH ROW
      WHEN (NEW.event_type = 'agreement_pinned')
      EXECUTE FUNCTION app_lifeops.reject_agreement_audit_test()`,
    );
    const rejectedTarget = crypto.randomUUID();
    try {
      await expect(
        service.pin({
          artifactId: artifact.id,
          targetType: "chat",
          targetId: rejectedTarget,
          pinnedByEntityId: SELF_ENTITY_ID,
        }),
      ).rejects.toThrow();
      const pins = await service.listPins({
        artifactId: artifact.id,
        ownerEntityId: SELF_ENTITY_ID,
      });
      expect(pins.some((item) => item.targetId === rejectedTarget)).toBe(false);
    } finally {
      await executeRawSql(
        runtime,
        "DROP TRIGGER reject_agreement_audit_test ON app_lifeops.life_audit_events",
      );
      await executeRawSql(
        runtime,
        "DROP FUNCTION app_lifeops.reject_agreement_audit_test()",
      );
    }
  });

  it("exports verified originals and complete persisted provenance without granting guest export access", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const original = await service.readOwnerPdf({
      artifactId: artifact.id,
      ownerEntityId: SELF_ENTITY_ID,
    });
    const exported = await service.exportOwnerAgreement({
      artifactId: artifact.id,
      ownerEntityId: SELF_ENTITY_ID,
    });
    const files = readStoredZip(exported.bytes);
    expect(files.get("original.pdf")).toEqual(original.bytes);
    const manifestBytes = files.get("manifest.json");
    if (!manifestBytes) throw new Error("Export manifest missing");
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    expect(manifest.artifact).toEqual(artifact);
    const agreement = (
      await service.listOwnerAgreements({ ownerEntityId: SELF_ENTITY_ID })
    ).find((item) => item.artifact.id === artifact.id);
    if (!agreement) throw new Error("Source agreement missing");
    expect(manifest.obligations).toEqual(
      expect.arrayContaining(agreement.obligations),
    );
    const extractionBytes = files.get("extraction.json");
    if (!extractionBytes) throw new Error("Saved extraction missing");
    const extraction = JSON.parse(extractionBytes.toString("utf8"));
    const ingestion = manifest.audit.find(
      (event: { event_type: string }) =>
        event.event_type === "agreement_ingested",
    );
    if (!ingestion) throw new Error("Ingestion audit missing");
    expect(
      crypto.createHash("sha256").update(extractionBytes).digest("hex"),
    ).toBe(JSON.parse(ingestion.inputs_json).extractionSha256);
    expect(
      extraction.pages.every(
        (page: { text: string }) =>
          page.text === original.bytes.toString("utf8"),
      ),
    ).toBe(true);
    expect(
      manifest.pins.some(
        (pin: { unpinnedAt: string | null }) => pin.unpinnedAt !== null,
      ),
    ).toBe(true);
    const sums = files.get("SHA256SUMS")?.toString("utf8");
    for (const name of ["original.pdf", "manifest.json", "extraction.json"]) {
      const file = files.get(name);
      if (!file) throw new Error(`Missing exported ${name}`);
      expect(sums).toContain(
        `${crypto.createHash("sha256").update(file).digest("hex")}  ${name}\n`,
      );
    }
    const events = await executeRawSql(
      runtime,
      `SELECT decision_json FROM app_lifeops.life_audit_events WHERE agent_id = ${sqlQuote(runtime.agentId)} AND id = ${sqlQuote(manifest.exportId)}`,
    );
    expect(events).toHaveLength(1);
    expect(JSON.parse(String(events[0].decision_json))).toEqual({
      manifestSha256: crypto
        .createHash("sha256")
        .update(manifestBytes)
        .digest("hex"),
      archiveSha256: crypto
        .createHash("sha256")
        .update(exported.bytes)
        .digest("hex"),
    });
    await expect(
      service.exportOwnerAgreement({
        artifactId: artifact.id,
        ownerEntityId: "verified-co-parent",
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_ACCESS_DENIED" });
  });

  it("refuses missing or corrupted originals without recording a prepared export", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const file = path.join(mediaStateDir, "media", artifact.mediaFileName);
    const original = fs.readFileSync(file);
    const countExports = () =>
      executeRawSql(
        runtime,
        `SELECT id FROM app_lifeops.life_audit_events WHERE agent_id = ${sqlQuote(runtime.agentId)} AND owner_id = ${sqlQuote(artifact.id)} AND event_type = 'agreement_export_prepared' ORDER BY id`,
      );
    const before = await countExports();
    try {
      fs.writeFileSync(file, Buffer.alloc(original.length, 0));
      await expect(
        service.exportOwnerAgreement({
          artifactId: artifact.id,
          ownerEntityId: SELF_ENTITY_ID,
        }),
      ).rejects.toMatchObject({ code: "AGREEMENT_INVALID_CONTRACT" });
      fs.unlinkSync(file);
      await expect(
        service.exportOwnerAgreement({
          artifactId: artifact.id,
          ownerEntityId: SELF_ENTITY_ID,
        }),
      ).rejects.toMatchObject({ code: "AGREEMENT_STORAGE_UNAVAILABLE" });
      expect(await countExports()).toEqual(before);
    } finally {
      fs.writeFileSync(file, original);
    }
  });

  it("detects altered extraction metadata and identifies legacy history explicitly", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const source = await service.createAgreementVersion({
      agreementKey: "export-provenance-test",
      title: "Export provenance",
      originalFilename: "provenance.pdf",
      mimeType: "application/pdf",
      bytes: pdf("export provenance"),
      uploadedByEntityId: SELF_ENTITY_ID,
    });
    await executeRawSql(
      runtime,
      `UPDATE memories SET metadata = metadata - 'agreementExtractionJson' WHERE id = ${sqlQuote(source.documentId)} AND agent_id = ${sqlQuote(runtime.agentId)}`,
    );
    await expect(
      service.exportOwnerAgreement({
        artifactId: source.id,
        ownerEntityId: SELF_ENTITY_ID,
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_INVALID_CONTRACT" });
    // Simulate the actual legacy schema state: no extraction map and no ingestion event.
    await executeRawSql(
      runtime,
      `DELETE FROM app_lifeops.life_audit_events WHERE agent_id = ${sqlQuote(runtime.agentId)} AND owner_id = ${sqlQuote(source.id)} AND event_type = 'agreement_ingested'`,
    );
    const exported = await service.exportOwnerAgreement({
      artifactId: source.id,
      ownerEntityId: SELF_ENTITY_ID,
    });
    const bytes = readStoredZip(exported.bytes).get("manifest.json");
    if (!bytes) throw new Error("Export manifest missing");
    const manifest = JSON.parse(bytes.toString("utf8"));
    expect(manifest.extraction).toMatchObject({ status: "unavailable" });
    expect(manifest.auditCoverage.status).toBe("partial_legacy_history");
    expect(manifest.audit).toEqual([]);
    expect(manifest.obligations).toEqual([]);
  });

  it("keeps concurrent pin transitions and their audit evidence in the same export snapshot", async () => {
    const service = createAgreementKnowledgeService(runtime);
    const repository = new AgreementKnowledgeRepository(
      runtime,
      runtime.agentId,
    );
    const targetId = crypto.randomUUID();
    const mutate = async () => {
      for (let iteration = 0; iteration < 8; iteration += 1) {
        const pin = await service.pin({
          artifactId: artifact.id,
          targetType: "chat",
          targetId,
          pinnedByEntityId: SELF_ENTITY_ID,
        });
        await service.unpin({
          pinId: pin.id,
          unpinnedByEntityId: SELF_ENTITY_ID,
        });
      }
    };
    const observe = async () => {
      for (let iteration = 0; iteration < 16; iteration += 1) {
        const snapshot = await repository.readExportSnapshot(artifact.id);
        const pin = snapshot.pins.find((item) => item.targetId === targetId);
        if (!pin) continue;
        const transitions = snapshot.audit
          .filter(
            (event) =>
              event.event_type ===
              (pin.unpinnedAt ? "agreement_unpinned" : "agreement_pinned"),
          )
          .map((event) => JSON.parse(String(event.decision_json)));
        expect(transitions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: pin.id,
              pinned_at: pin.pinnedAt,
              unpinned_at: pin.unpinnedAt,
            }),
          ]),
        );
      }
    };
    await Promise.all([mutate(), observe()]);
    const final = await repository.readExportSnapshot(artifact.id);
    expect(
      final.pins.find((item) => item.targetId === targetId)?.unpinnedAt,
    ).toBeTruthy();
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
