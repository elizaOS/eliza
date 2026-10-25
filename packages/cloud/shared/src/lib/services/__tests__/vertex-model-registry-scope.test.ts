/**
 * Vertex model registry — cross-org isolation (#10852 sweep). Real Drizzle
 * schema, in-process PGlite (never a silent skip: the `pgliteReady` guard fails
 * loudly if pushSchema can't initialize).
 *
 * Two confirmed IDOR gaps, both proven here against the REAL SQL:
 *
 *   syncJobStatus (GET /api/training/vertex/jobs by id/name): resolved the
 *   tuning job by id/name with NO visibility predicate, then RE-SYNCED it (a
 *   write). One org could read AND mutate another org's tuning job. Fixed by
 *   scoping the lookup with buildVisibilityCondition(viewer) — a cross-org id
 *   now returns null (404 at the route) and never reaches the write.
 *
 *   activateAssignment (POST /api/training/vertex/assignments): resolved the
 *   tuned model by id alone, letting one org bind another org's private
 *   fine-tuned model into its own inference slot. Fixed by scoping the lookup
 *   with buildModelVisibilityCondition({org,user}) — a non-visible model id is
 *   now indistinguishable from a missing one ("Tuned model not found").
 */

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../../db/client";
import { organizations } from "../../../db/schemas/organizations";
import { users } from "../../../db/schemas/users";
import { vertexModelAssignments } from "../../../db/schemas/vertex-model-assignments";
import { vertexTunedModels } from "../../../db/schemas/vertex-tuned-models";
import {
  vertexTuningJobStateEnum,
  vertexTuningJobs,
  vertexTuningScopeEnum,
  vertexTuningSlotEnum,
} from "../../../db/schemas/vertex-tuning-jobs";

const PGLITE_TIMEOUT = 120_000;
let pgliteReady = true;
let service: typeof import("../vertex-model-registry").vertexModelRegistryService;

let orgA = "";
let userA = "";
let orgB = "";
let userB = "";
let jobB = "";
let modelA = "";
let modelB = "";
let modelGlobal = "";

async function seedOrgUser(name: string) {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name, slug: `${name}-${Date.now()}-${Math.random()}` })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({
      steward_user_id: `${name}-u-${Date.now()}-${Math.random()}`,
      organization_id: org.id,
    })
    .returning();
  return { orgId: org.id, userId: user.id };
}

beforeAll(async () => {
  try {
    const schema = {
      organizations,
      users,
      vertexTuningJobs,
      vertexTunedModels,
      vertexModelAssignments,
      vertexTuningScopeEnum,
      vertexTuningSlotEnum,
      vertexTuningJobStateEnum,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();

    ({ orgId: orgA, userId: userA } = await seedOrgUser("orga"));
    ({ orgId: orgB, userId: userB } = await seedOrgUser("orgb"));

    // Org B's tuning job (the cross-org read/mutate target).
    const [job] = await dbWrite
      .insert(vertexTuningJobs)
      .values({
        vertex_job_name: "projects/p/locations/us-central1/tuningJobs/b1",
        project_id: "p",
        region: "us-central1",
        display_name: "Org B Job",
        base_model: "gemini-1.5",
        slot: "response",
        scope: "organization",
        organization_id: orgB,
        training_data_path: "gs://bucket/b/train.jsonl",
        status: "JOB_STATE_RUNNING",
      })
      .returning();
    jobB = job.id;

    const [ma] = await dbWrite
      .insert(vertexTunedModels)
      .values({
        vertex_model_id: "orga-model",
        display_name: "Org A Model",
        base_model: "gemini-1.5",
        project_id: "p",
        region: "us-central1",
        slot: "response",
        source_scope: "organization",
        organization_id: orgA,
      })
      .returning();
    modelA = ma.id;

    const [mb] = await dbWrite
      .insert(vertexTunedModels)
      .values({
        vertex_model_id: "orgb-model",
        display_name: "Org B Model",
        base_model: "gemini-1.5",
        project_id: "p",
        region: "us-central1",
        slot: "response",
        source_scope: "organization",
        organization_id: orgB,
      })
      .returning();
    modelB = mb.id;

    const [mg] = await dbWrite
      .insert(vertexTunedModels)
      .values({
        vertex_model_id: "global-model",
        display_name: "Global Model",
        base_model: "gemini-1.5",
        project_id: "p",
        region: "us-central1",
        slot: "response",
        source_scope: "global",
      })
      .returning();
    modelGlobal = mg.id;

    ({ vertexModelRegistryService: service } = await import("../vertex-model-registry"));
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[vertex-model-registry-scope.test] PGlite/pushSchema unavailable — failing loud.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("vertex model registry — cross-org isolation (#10852)", () => {
  beforeEach(async () => {
    if (pgliteReady) await dbWrite.delete(vertexModelAssignments);
  });

  test("pglite applied (loud)", () => {
    expect(pgliteReady).toBe(true);
  });

  // --- finding 7: syncJobStatus cross-org read+mutate ---

  test("syncJobStatus: org A viewer canNOT read org B's job by id (null, no write)", async () => {
    const result = await service.syncJobStatus({
      jobId: jobB,
      viewer: { organizationId: orgA, userId: userA },
    });
    expect(result).toBeNull();

    // The row must be UNTOUCHED — the old code re-synced (wrote) it cross-org.
    const row = await dbWrite.query.vertexTuningJobs.findFirst({
      where: eq(vertexTuningJobs.id, jobB),
    });
    expect(row?.status).toBe("JOB_STATE_RUNNING");
  });

  test("syncJobStatus: org A viewer canNOT read org B's job by name (null)", async () => {
    const result = await service.syncJobStatus({
      vertexJobName: "projects/p/locations/us-central1/tuningJobs/b1",
      viewer: { organizationId: orgA, userId: userA },
    });
    expect(result).toBeNull();
  });

  test("job visibility predicate admits the owner (org B) and denies org A", async () => {
    // syncJobStatus reuses buildVisibilityCondition; listVisibleJobs proves it
    // both ways with no external Vertex call.
    const bJobs = await service.listVisibleJobs({
      organizationId: orgB,
      userId: userB,
    });
    expect(bJobs.map((j) => j.id)).toContain(jobB);

    const aJobs = await service.listVisibleJobs({
      organizationId: orgA,
      userId: userA,
    });
    expect(aJobs.map((j) => j.id)).not.toContain(jobB);
  });

  // --- finding 8: activateAssignment cross-org model bind ---

  test("activateAssignment: org A canNOT activate org B's private model", async () => {
    await expect(
      service.activateAssignment({
        scope: "organization",
        slot: "response",
        tunedModelId: modelB,
        organizationId: orgA,
        assignedByUserId: userA,
      }),
    ).rejects.toThrow(/not found/i);

    const rows = await dbWrite
      .select()
      .from(vertexModelAssignments)
      .where(eq(vertexModelAssignments.tuned_model_id, modelB));
    expect(rows).toHaveLength(0);
  });

  test("activateAssignment: org A CAN activate its own model", async () => {
    const { assignment, tunedModel } = await service.activateAssignment({
      scope: "organization",
      slot: "response",
      tunedModelId: modelA,
      organizationId: orgA,
      assignedByUserId: userA,
    });
    expect(tunedModel.id).toBe(modelA);
    expect(assignment.organization_id).toBe(orgA);
    expect(assignment.is_active).toBe(true);
  });

  test("activateAssignment: org A CAN activate a global model", async () => {
    const { tunedModel } = await service.activateAssignment({
      scope: "organization",
      slot: "response",
      tunedModelId: modelGlobal,
      organizationId: orgA,
      assignedByUserId: userA,
    });
    expect(tunedModel.id).toBe(modelGlobal);
  });
});
