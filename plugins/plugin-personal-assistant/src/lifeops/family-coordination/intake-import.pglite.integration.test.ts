/**
 * Real-runtime proof that correspondence import honors the family workspace
 * deletion fence: an import settles its admission claim, so the workspace stays
 * deletable, and an import after a reviewed deletion writes no document.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SELF_ENTITY_ID } from "@elizaos/contracts";
import type { AgentRuntime, Plugin } from "@elizaos/core";
import { createDocumentsPlugin } from "@elizaos/plugin-assistant";
import { resolveKnowledgeGraphService } from "@elizaos/plugin-relationships";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFileStorageService } from "../../../../../packages/agent/src/services/file-storage.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import { CalendarCardAccessStore } from "../calendar-card.js";
import { previewFamilyDeletionDatabase } from "../family-workflows/deletion-database-snapshot.js";
import { beginFamilyWorkspaceDeletion } from "../family-workflows/workspace-deletion.js";
import { SchoolCalendarWorkflow } from "../school/calendar-workflow.js";
import { executeRawSql, sqlQuote } from "../sql.js";
import { importFamilyCorrespondence } from "./intake-import.js";
import { FamilyIntakeReviewStore } from "./intake-review.js";
import { MonthlyFamilyPacketService } from "./monthly-packet.js";

const fileStoragePlugin: Plugin = {
  name: "family-intake-import-file-storage",
  description: "Production content-addressed file storage for intake tests.",
  services: [LocalFileStorageService],
};

describe("family correspondence import and workspace deletion", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let stateDir: string;

  beforeEach(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "family-intake-fence-"));
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

  const correspondenceRows = async () =>
    (
      await executeRawSql(
        runtime,
        `SELECT id FROM memories WHERE agent_id::text=${sqlQuote(runtime.agentId)}
         AND metadata->>'source'='selected-correspondence'`,
      )
    ).length;

  it("keeps the workspace deletable after an import and refuses imports once deletion starts", async () => {
    await importFamilyCorrespondence(runtime, {
      id: randomUUID(),
      periodKey: "2026-12",
      title: "Co-parent message",
      text: "Private message from the co-parent: the therapy appointment moved to Thursday.",
    });
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

    const before = await correspondenceRows();
    const late = randomUUID();
    await expect(
      importFamilyCorrespondence(runtime, {
        id: late,
        periodKey: "2026-12",
        title: "Written after deletion",
        text: "New private correspondence sent after the workspace was deleted.",
      }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    expect(await correspondenceRows()).toBe(before);
    expect(await new FamilyIntakeReviewStore(runtime).read(late)).toBeNull();
  }, 180_000);
});
