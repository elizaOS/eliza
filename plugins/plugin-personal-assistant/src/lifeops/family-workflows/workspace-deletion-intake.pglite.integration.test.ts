/**
 * Real-runtime proof that a reviewed family workspace deletion covers selected
 * correspondence: the review lists and the purge removes every intake revision
 * and the documents intake imported, including segmented sources, while a
 * library document the owner only selected stays in the document library.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SELF_ENTITY_ID } from "@elizaos/contracts";
import type { AgentRuntime, Plugin, UUID } from "@elizaos/core";
import {
  createDocumentsPlugin,
  DocumentService,
} from "@elizaos/plugin-assistant";
import { resolveKnowledgeGraphService } from "@elizaos/plugin-relationships";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFileStorageService } from "../../../../../packages/agent/src/services/file-storage.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import { CalendarCardAccessStore } from "../calendar-card.js";
import { importFamilyCorrespondence } from "../family-coordination/intake-import.js";
import { FamilyIntakeReviewStore } from "../family-coordination/intake-review.js";
import { getFamilyIntakeService } from "../family-coordination/intake-service.js";
import { MonthlyFamilyPacketService } from "../family-coordination/monthly-packet.js";
import { SchoolCalendarWorkflow } from "../school/calendar-workflow.js";
import { executeRawSql, sqlQuote } from "../sql.js";
import { previewFamilyDeletionDatabase } from "./deletion-database-snapshot.js";
import { beginFamilyWorkspaceDeletion } from "./workspace-deletion.js";

const fileStoragePlugin: Plugin = {
  name: "family-deletion-intake-file-storage",
  description: "Production content-addressed file storage for deletion tests.",
  services: [LocalFileStorageService],
};

describe("family workspace deletion of selected correspondence", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let stateDir: string;

  beforeEach(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "family-delete-intake-"));
    vi.stubEnv("ELIZA_STATE_DIR", stateDir);
    vi.stubEnv("PGLITE_DATA_DIR", path.join(stateDir, "pglite"));
    runtimeResult = await createLifeOpsTestRuntime({
      plugins: [
        fileStoragePlugin,
        createDocumentsPlugin({ enableActions: false }),
      ],
    });
    runtime = runtimeResult.runtime;
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    await graph.getEntityStore(runtime.agentId).ensureSelf();
    await new CalendarCardAccessStore(runtime).ensureSchema();
    await new SchoolCalendarWorkflow(runtime).ensureSchema();
    await new MonthlyFamilyPacketService(runtime).list();
  }, 180_000);

  afterEach(async () => {
    try {
      await runtimeResult?.cleanup();
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  const storedRows = async (documentIds: readonly string[]) => {
    const ids = documentIds.map(sqlQuote).join(",");
    const [documents, reviews] = await Promise.all([
      executeRawSql(
        runtime,
        `SELECT id FROM memories WHERE agent_id::text=${sqlQuote(runtime.agentId)}
         AND (id::text IN (${ids}) OR metadata->>'documentId' IN (${ids}))`,
      ),
      executeRawSql(
        runtime,
        `SELECT id FROM app_lifeops.life_family_intake_reviews WHERE agent_id=${sqlQuote(runtime.agentId)}`,
      ),
    ]);
    return { documents: documents.length, reviews: reviews.length };
  };

  it("removes imported correspondence, its segments and every review revision", async () => {
    const documents = runtime.getService<DocumentService>(
      DocumentService.serviceType,
    );
    if (!documents) throw new Error("documents service unavailable");
    const short = await importFamilyCorrespondence(runtime, {
      id: randomUUID(),
      periodKey: "2026-12",
      title: "Co-parent message",
      text: "Private message from the co-parent: the therapy appointment moved to Thursday.",
    });
    const proposed = await new FamilyIntakeReviewStore(runtime).propose({
      id: short.id,
      expectedRevision: short.revision,
      sourceSha256: short.source.contentSha256,
      facts: [
        {
          id: randomUUID(),
          section: "unanswered",
          statement: "The appointment time is unconfirmed.",
          sourceQuote: "the therapy appointment moved to Thursday",
          dates: [],
          requests: [],
          commitments: [],
          accountability: [],
          urgency: null,
          unanswered: true,
          recipientEntityIds: [],
        },
      ],
    });
    expect(proposed.revision).toBe(2);
    // Above the 64 KiB inline limit the document service stores source segments.
    const segmented = await importFamilyCorrespondence(runtime, {
      id: randomUUID(),
      periodKey: "2026-12",
      title: "Long school thread",
      text: "Pickup moves to the north gate next week.\n".repeat(2_000),
    });
    const owner = {
      requesterEntityId: short.selectedByEntityId,
      role: "OWNER" as const,
      isOwner: true,
    };
    const library = await documents.addDocument({
      agentId: runtime.agentId,
      worldId: runtime.agentId,
      roomId: runtime.agentId,
      entityId: runtime.agentId,
      clientDocumentId: randomUUID(),
      contentType: "text/plain",
      originalFilename: "library-note.txt",
      content: "Library note the owner keeps outside the family workspace.",
      metadata: { title: "Library note" },
      scope: "owner-private",
      scopedToEntityId: short.selectedByEntityId,
      addedBy: short.selectedByEntityId,
      addedByRole: "OWNER",
      addedFrom: "lifeops",
    });
    await getFamilyIntakeService(runtime).select({
      id: randomUUID(),
      periodKey: "2026-12",
      documentId: library.storedDocumentMemoryId,
    });
    const imported = [short.source.documentId, segmented.source.documentId];
    const before = await storedRows(imported);
    expect(before.reviews).toBe(4);
    expect(before.documents).toBeGreaterThan(3);

    const preview = await previewFamilyDeletionDatabase(
      runtime,
      SELF_ENTITY_ID,
    );
    expect(preview.unavailable).toEqual([]);
    expect(
      preview.records.filter((record) => record.kind === "intakeReviews"),
    ).toHaveLength(4);
    const reviewedDocuments = preview.records
      .filter((record) => record.kind === "documents")
      .map((record) => record.identity.id);
    expect(reviewedDocuments).toEqual(expect.arrayContaining(imported));
    expect(reviewedDocuments).not.toContain(library.storedDocumentMemoryId);

    const job = await beginFamilyWorkspaceDeletion(runtime, {
      ownerEntityId: SELF_ENTITY_ID,
      expectedSha256: preview.sha256,
      backupRetention: "immediate",
    });
    expect(job.state).toBe("purge_pending");
    expect(await storedRows(imported)).toEqual({ documents: 0, reviews: 0 });
    expect(
      await documents.getDocumentByIdWithAccessContext(
        library.storedDocumentMemoryId as UUID,
        owner,
      ),
    ).toEqual(expect.objectContaining({ id: library.storedDocumentMemoryId }));
  }, 180_000);

  it("reviews and deletes a workspace that never selected correspondence", async () => {
    const preview = await previewFamilyDeletionDatabase(
      runtime,
      SELF_ENTITY_ID,
    );
    expect(preview.unavailable).toEqual([]);
    const job = await beginFamilyWorkspaceDeletion(runtime, {
      ownerEntityId: SELF_ENTITY_ID,
      expectedSha256: preview.sha256,
      backupRetention: "immediate",
    });
    expect(job.state).toBe("purge_pending");
  }, 180_000);
});
