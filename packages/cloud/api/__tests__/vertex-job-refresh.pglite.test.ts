/** Real registry/route reads with controlled, read-only provider responses. */
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { testOutputPath } from "../../../scripts/lib/test-output";
import { createTuningJob } from "../../shared/src/lib/services/vertex-tuning";
import { requireVertexObservation } from "../../shared/src/lib/services/vertex-tuning-observation";
import {
  type RuntimeR2Bucket,
  setRuntimeR2Bucket,
} from "../../shared/src/lib/storage/r2-runtime-binding";
import { VERTEX_TUNING_JOB_STATES } from "../../shared/src/types/vertex-tuning";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.GOOGLE_ACCESS_TOKEN = "controlled-vertex-test-token";

const user = { id: randomUUID(), organization_id: randomUUID() };
mock.module("@elizaos/cloud-shared/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: async () => ({ user }),
}));

const { dbWrite, closeDatabaseConnectionsForTests } = await import(
  "../../shared/src/db/client"
);
const {
  organizations,
  users,
  vertexTuningJobs,
  vertexTunedModels,
  vertexModelAssignments,
  vertexTuningScopeEnum,
  vertexTuningSlotEnum,
  vertexTuningJobStateEnum,
} = await import("../../shared/src/db/schemas");
const { vertexModelRegistryService: registry } = await import(
  "../../shared/src/lib/services/vertex-model-registry"
);
const { default: route } = await import("../training/vertex/jobs/route");
const app = new Hono().route("/jobs", route);
const jobName = "projects/controlled/locations/us-central1/tuningJobs/original";
const epoch = Date.parse("2026-11-01T00:00:00Z");
let jobId = "";
let provider: () => Promise<Response>;
const fetchSpy = spyOn(globalThis, "fetch");

function setControlledFetch(
  implementation: (...args: Parameters<typeof fetch>) => Promise<Response>,
) {
  fetchSpy.mockImplementation(
    Object.assign(implementation, {
      preconnect: () => {
        throw new Error("NETWORK_FORBIDDEN");
      },
    }),
  );
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON record");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected a JSON array");
  return value;
}

function response(state: string, tick: number): Response {
  return Response.json({
    name: jobName,
    state,
    tunedModelDisplayName: "controlled-model",
    ...(state === "JOB_STATE_SUCCEEDED"
      ? {
          tunedModelEndpointName:
            "projects/controlled/locations/us-central1/endpoints/controlled-endpoint",
        }
      : {}),
    createTime: new Date(epoch).toISOString(),
    updateTime: new Date(epoch + tick * 1_000).toISOString(),
  });
}

beforeAll(async () => {
  const { apply } = await pushSchema(
    {
      organizations,
      users,
      vertexTuningJobs,
      vertexTunedModels,
      vertexModelAssignments,
      vertexTuningScopeEnum,
      vertexTuningSlotEnum,
      vertexTuningJobStateEnum,
    } as never,
    dbWrite as never,
  );
  await apply();
  await dbWrite.insert(organizations).values({
    id: user.organization_id,
    name: "Controlled",
    slug: randomUUID(),
  });
  await dbWrite.insert(users).values({
    id: user.id,
    organization_id: user.organization_id,
    steward_user_id: randomUUID(),
  });
}, 120_000);

beforeEach(async () => {
  setRuntimeR2Bucket(null);
  delete process.env.SQL_HEAVY_PAYLOAD_STORAGE;
  await dbWrite.execute(
    sql`DROP TRIGGER IF EXISTS controlled_vertex_failure ON vertex_tuned_models`,
  );
  await dbWrite.execute(sql`DROP FUNCTION IF EXISTS reject_vertex_model()`);
  await dbWrite.delete(vertexModelAssignments);
  await dbWrite.delete(vertexTunedModels);
  await dbWrite.delete(vertexTuningJobs);
  const [job] = await dbWrite
    .insert(vertexTuningJobs)
    .values({
      vertex_job_name: jobName,
      project_id: "controlled",
      region: "us-central1",
      display_name: "controlled-model",
      base_model: "controlled-base-model",
      slot: "response",
      scope: "organization",
      organization_id: user.organization_id,
      created_by_user_id: user.id,
      training_data_path: "controlled-training.jsonl",
      status: "JOB_STATE_RUNNING",
      last_remote_payload: await response("JOB_STATE_RUNNING", 0).json(),
      created_at: new Date(epoch),
      updated_at: new Date(epoch),
    })
    .returning();
  jobId = job.id;
  provider = async () => response("JOB_STATE_RUNNING", 1);
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        expect(url).toBe(`https://aiplatform.googleapis.com/v1/${jobName}`);
        return provider();
      },
      {
        preconnect: () => {
          throw new Error("NETWORK_FORBIDDEN");
        },
      },
    ),
  );
});

afterAll(async () => {
  setRuntimeR2Bucket(null);
  delete process.env.SQL_HEAVY_PAYLOAD_STORAGE;
  fetchSpy.mockRestore();
  mock.restore();
  delete process.env.GOOGLE_ACCESS_TOKEN;
  await closeDatabaseConnectionsForTests();
});

test("job-name GET uses one provider observation for its response and stored receipt", async () => {
  let calls = 0;
  provider = async () => response("JOB_STATE_RUNNING", ++calls);
  const result = await app.request(`/jobs?name=${encodeURIComponent(jobName)}`);
  expect(result.status).toBe(200);
  const body = record(await result.json());
  expect(calls).toBe(1);
  expect(body.job).toEqual(record(body.jobRecord).last_remote_payload);
});

test("a delayed running observation cannot overwrite a newer successful job", async () => {
  const entered = Promise.withResolvers<void>();
  const delayed = Promise.withResolvers<Response>();
  let calls = 0;
  provider = () => {
    if (++calls === 1) {
      entered.resolve();
      return delayed.promise;
    }
    return Promise.resolve(response("JOB_STATE_SUCCEEDED", 2));
  };
  const stale = registry.syncJobStatus({
    jobId,
    viewer: { organizationId: user.organization_id, userId: user.id },
  });
  await entered.promise;
  const current = await registry.syncJobStatus({
    jobId,
    viewer: { organizationId: user.organization_id, userId: user.id },
  });
  expect(current?.job.status).toBe("JOB_STATE_SUCCEEDED");
  delayed.resolve(response("JOB_STATE_RUNNING", 1));
  await stale;
  const [stored] = await dbWrite
    .select()
    .from(vertexTuningJobs)
    .where(eq(vertexTuningJobs.id, jobId));
  expect(stored.status).toBe("JOB_STATE_SUCCEEDED");
  expect(stored.updated_at).toEqual(new Date(epoch + 2_000));
  expect(stored.completed_at).not.toBeNull();
});

test("a job deleted during the provider read returns absence without publishing a model", async () => {
  const entered = Promise.withResolvers<void>();
  const delayed = Promise.withResolvers<Response>();
  provider = () => {
    entered.resolve();
    return delayed.promise;
  };
  const reading = registry.syncJobStatus({
    jobId,
    viewer: { organizationId: user.organization_id, userId: user.id },
  });
  await entered.promise;
  await dbWrite.delete(vertexTuningJobs).where(eq(vertexTuningJobs.id, jobId));
  delayed.resolve(response("JOB_STATE_SUCCEEDED", 1));
  await expect(reading).resolves.toBeNull();
  expect(await dbWrite.select().from(vertexTunedModels)).toEqual([]);
});

const viewer = { organizationId: user.organization_id, userId: user.id };
const endpoint =
  "projects/controlled/locations/us-central1/endpoints/canonical";
const model = "projects/controlled/locations/us-central1/models/canonical@1";
async function raw(
  state: string,
  tick: number,
  extra: Record<string, unknown> = {},
) {
  const value = record(await response(state, tick).json());
  delete value.tunedModelEndpointName;
  return {
    ...value,
    ...(state === "JOB_STATE_SUCCEEDED"
      ? { tunedModel: { endpoint, model } }
      : {}),
    ...extra,
  };
}

test("canonical nested tunedModel fields publish the original resource and retain unknown payload fields", async () => {
  const body = await raw("JOB_STATE_SUCCEEDED", 1, {
    tuningDataStats: { arbitrary: [1, { complete: "yes" }] },
    providerNewField: "retained",
  });
  provider = async () => Response.json(body);
  const result = await registry.syncJobStatus({ jobId, viewer });
  expect(result?.job.last_remote_payload).toEqual(body);
  expect(result?.job.tuned_model_endpoint_name).toBe(endpoint);
  expect(result?.tunedModel?.vertex_model_id).toBe(endpoint);
  expect(result?.job.provider_update_time).toBe(
    "2026-11-01T00:00:01.000000000Z",
  );
  expect(result?.job.observation_revision).toBe(1);
  expect(result?.job.completed_provider_time).toBeNull();
  expect(result?.job.completed_at).not.toBeNull();
  provider = async () =>
    Response.json({
      ...body,
      updateTime: "2026-11-01T00:00:02Z",
      endTime: "2026-11-01T00:00:00.123456789Z",
    });
  const later = await registry.syncJobStatus({ jobId, viewer });
  expect(later?.job.completed_provider_time).toBe(
    "2026-11-01T00:00:00.123456789Z",
  );
  expect(later?.job.completed_at).toEqual(result?.job.completed_at);
  expect(later?.tunedModel).toEqual(result?.tunedModel);
});

test("nanosecond observations are ordered without Date rounding and timezone equivalents conflict exactly", async () => {
  const newer = await raw("JOB_STATE_RUNNING", 1, {
    updateTime: "2026-11-01T00:00:00.000000002Z",
  });
  provider = async () => Response.json(newer);
  expect(
    (await registry.syncJobStatus({ jobId, viewer }))?.job.provider_update_time,
  ).toBe("2026-11-01T00:00:00.000000002Z");
  provider = async () =>
    Response.json(
      await raw("JOB_STATE_RUNNING", 1, {
        updateTime: "2026-11-01T00:00:00.000000001Z",
      }),
    );
  const stale = await registry.syncJobStatus({ jobId, viewer });
  expect(stale?.job.last_remote_payload).toEqual(newer);
  expect(stale?.job.observation_revision).toBe(1);
  provider = async () =>
    Response.json(
      await raw("JOB_STATE_RUNNING", 1, {
        updateTime: "2026-11-01T01:00:00.000000002+01:00",
      }),
    );
  await expect(registry.syncJobStatus({ jobId, viewer })).rejects.toMatchObject(
    { code: "VERTEX_OBSERVATION_CONFLICT" },
  );
  expect(
    (await dbWrite.select().from(vertexTuningJobs))[0].provider_update_time,
  ).toBe("2026-11-01T00:00:00.000000002Z");
});

test("same-terminal updates retain original completion and model ownership while refreshing full metadata", async () => {
  provider = async () =>
    Response.json(
      await raw("JOB_STATE_SUCCEEDED", 1, {
        endTime: "2026-11-01T00:00:00.987654321Z",
      }),
    );
  const first = await registry.syncJobStatus({ jobId, viewer });
  const originalCompletion = await dbWrite.execute(
    sql`SELECT completed_at::text AS value FROM vertex_tuning_jobs WHERE id=${jobId}`,
  );
  const body = await raw("JOB_STATE_SUCCEEDED", 2, {
    extraMetrics: { retained: true },
    endTime: "2026-11-01T00:00:02Z",
  });
  provider = async () => Response.json(body);
  const next = await registry.syncJobStatus({ jobId, viewer });
  expect(next?.job.last_remote_payload).toEqual(body);
  expect(next?.job.completed_at).toEqual(first?.job.completed_at);
  expect(
    (
      await dbWrite.execute(
        sql`SELECT completed_at::text AS value FROM vertex_tuning_jobs WHERE id=${jobId}`,
      )
    ).rows,
  ).toEqual(originalCompletion.rows);
  expect(next?.job.completed_provider_time).toEqual(
    first?.job.completed_provider_time,
  );
  expect(next?.job.completed_provider_time).toBe(
    "2026-11-01T00:00:00.987654321Z",
  );
  expect(next?.tunedModel).toEqual(first?.tunedModel);
  expect(next?.job.observation_revision).toBe(2);
  provider = async () => Response.json(await raw("JOB_STATE_FAILED", 3));
  await expect(registry.syncJobStatus({ jobId, viewer })).rejects.toMatchObject(
    { code: "VERTEX_TERMINAL_CONFLICT" },
  );
  provider = async () =>
    Response.json(
      await raw("JOB_STATE_SUCCEEDED", 3, {
        tunedModel: { endpoint: `${endpoint}-changed`, model },
      }),
    );
  await expect(registry.syncJobStatus({ jobId, viewer })).rejects.toMatchObject(
    { code: "VERTEX_TERMINAL_CONFLICT" },
  );
});

for (const state of VERTEX_TUNING_JOB_STATES) {
  test(`provider state ${state} is retained without collapsing its meaning`, async () => {
    provider = async () => Response.json(await raw(state, 1));
    const result = await registry.syncJobStatus({ jobId, viewer });
    expect(result?.job.status).toBe(state);
    expect(result?.job.last_remote_payload.state).toBe(state);
    expect(Boolean(result?.tunedModel)).toBe(state === "JOB_STATE_SUCCEEDED");
  });
}

test("cancelling observations cannot return to running but can reach terminal failure", async () => {
  provider = async () => Response.json(await raw("JOB_STATE_CANCELLING", 1));
  await registry.syncJobStatus({ jobId, viewer });
  provider = async () => Response.json(await raw("JOB_STATE_RUNNING", 2));
  await expect(registry.syncJobStatus({ jobId, viewer })).rejects.toMatchObject(
    { code: "VERTEX_OBSERVATION_CONFLICT" },
  );
  expect((await dbWrite.select().from(vertexTuningJobs))[0].status).toBe(
    "JOB_STATE_CANCELLING",
  );
  provider = async () => Response.json(await raw("JOB_STATE_FAILED", 2));
  expect((await registry.syncJobStatus({ jobId, viewer }))?.job.status).toBe(
    "JOB_STATE_FAILED",
  );
});

test("partial success permits definitive success and a delayed older partial cannot regress it", async () => {
  provider = async () =>
    Response.json(await raw("JOB_STATE_PARTIALLY_SUCCEEDED", 1));
  const partial = await registry.syncJobStatus({ jobId, viewer });
  expect(partial?.job.status).toBe("JOB_STATE_PARTIALLY_SUCCEEDED");
  expect(partial?.job.completed_at).toBeNull();
  provider = async () => Response.json(await raw("JOB_STATE_SUCCEEDED", 2));
  const succeeded = await registry.syncJobStatus({ jobId, viewer });
  expect(succeeded?.job.status).toBe("JOB_STATE_SUCCEEDED");
  expect(succeeded?.tunedModel?.vertex_model_id).toBe(endpoint);
  provider = async () =>
    Response.json(await raw("JOB_STATE_PARTIALLY_SUCCEEDED", 1));
  const delayed = await registry.syncJobStatus({ jobId, viewer });
  expect(delayed?.job).toEqual(succeeded?.job);
  expect(delayed?.tunedModel).toEqual(succeeded?.tunedModel);
});

test("invalid provider identity, timestamp and unknown state leave the stored job untouched", async () => {
  const [before] = await dbWrite.select().from(vertexTuningJobs);
  for (const extra of [
    { name: "projects/controlled/locations/us-central1/tuningJobs/other" },
    { updateTime: "2026-02-31T00:00:00Z" },
    { updateTime: "2026-11-01T00:00:01.1234567890Z" },
    { state: "JOB_STATE_FUTURE" },
    { endTime: "" },
    { state: "JOB_STATE_SUCCEEDED", tunedModel: {} },
    {
      tunedModel: {
        endpoint:
          "projects/controlled/locations/us-central1/endpoints/wrong/extra",
      },
    },
    { tunedModel: { endpoint: "https://unrelated.invalid/endpoint" } },
  ]) {
    provider = async () =>
      Response.json(await raw("JOB_STATE_RUNNING", 1, extra));
    await expect(
      registry.syncJobStatus({ jobId, viewer }),
    ).rejects.toBeDefined();
    expect((await dbWrite.select().from(vertexTuningJobs))[0]).toEqual(before);
  }
});

function objectFixture() {
  const bodies = new Map<string, string>();
  let beforeGet: ((key: string) => Promise<void>) | undefined;
  const creates: Array<{ key: string; createOnly: boolean }> = [];
  const bucket: RuntimeR2Bucket = {
    async get(key) {
      await beforeGet?.(key);
      const body = bodies.get(key);
      return body === undefined ? null : { text: async () => body };
    },
    async put(key, body, options) {
      if (typeof body !== "string")
        throw new Error("Expected complete JSON body");
      const createOnly =
        options?.onlyIf instanceof Headers &&
        options.onlyIf.get("if-none-match") === "*";
      creates.push({ key, createOnly });
      if (createOnly && bodies.has(key)) return null;
      bodies.set(key, body);
      return {};
    },
    async delete(key) {
      bodies.delete(key);
    },
  };
  setRuntimeR2Bucket(bucket);
  process.env.SQL_HEAVY_PAYLOAD_STORAGE = "r2";
  return {
    bodies,
    creates,
    beforeGet: (hook: (key: string) => Promise<void>) => {
      beforeGet = hook;
    },
  };
}

test("immutable payload generations survive SQL rollback and exact replay verifies the retained object", async () => {
  const objects = objectFixture();
  const firstBody = await raw("JOB_STATE_RUNNING", 1, {
    completePayload: "first".repeat(1000),
  });
  provider = async () => Response.json(firstBody);
  const first = await registry.syncJobStatus({ jobId, viewer });
  const firstKey = first!.job.last_remote_payload_key!;
  const firstBytes = objects.bodies.get(firstKey);
  await dbWrite.execute(
    sql`CREATE FUNCTION reject_vertex_model() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled model publication failure'; END $$`,
  );
  await dbWrite.execute(
    sql`CREATE TRIGGER controlled_vertex_failure BEFORE INSERT ON vertex_tuned_models FOR EACH ROW EXECUTE FUNCTION reject_vertex_model()`,
  );
  const nextBody = await raw("JOB_STATE_SUCCEEDED", 2, {
    completePayload: "second".repeat(1000),
  });
  provider = async () => Response.json(nextBody);
  await expect(registry.syncJobStatus({ jobId, viewer })).rejects.toBeDefined();
  const [unchanged] = await dbWrite.select().from(vertexTuningJobs);
  expect(unchanged.last_remote_payload_key).toBe(firstKey);
  expect(unchanged.status).toBe("JOB_STATE_RUNNING");
  expect(objects.bodies.get(firstKey)).toBe(firstBytes);
  expect(objects.bodies.size).toBe(2);
  expect(await dbWrite.select().from(vertexTunedModels)).toEqual([]);
  await dbWrite.execute(
    sql`DROP TRIGGER controlled_vertex_failure ON vertex_tuned_models`,
  );
  const recovered = await registry.syncJobStatus({ jobId, viewer });
  expect(recovered?.job.last_remote_payload).toEqual(nextBody);
  expect(recovered?.job.last_remote_payload_key).not.toBe(firstKey);
  expect(objects.bodies.get(firstKey)).toBe(firstBytes);
  expect(objects.creates.every((item) => item.createOnly)).toBe(true);
  expect(objects.bodies.size).toBe(2);
  const replay = await registry.syncJobStatus({ jobId, viewer });
  expect(replay).toEqual(recovered);
});

test("offloaded list reads return complete payloads and reject missing or malformed retained objects", async () => {
  const objects = objectFixture();
  const body = await raw("JOB_STATE_RUNNING", 1, {
    entirePayload: "complete".repeat(1000),
  });
  provider = async () => Response.json(body);
  const stored = await registry.syncJobStatus({ jobId, viewer });
  expect(
    record(
      array(
        record(await (await app.request("/jobs?persisted=true")).json())
          .persistedJobs,
      )[0],
    ).last_remote_payload,
  ).toEqual(body);
  expect(
    array(record(await (await app.request("/jobs")).json()).jobs)[0],
  ).toEqual(body);
  const key = stored!.job.last_remote_payload_key!;
  objects.bodies.delete(key);
  expect((await app.request("/jobs?persisted=true")).status).toBe(500);
  objects.bodies.set(key, "not JSON");
  expect((await app.request("/jobs")).status).toBe(500);
  objects.bodies.set(
    key,
    JSON.stringify({ ...body, entirePayload: "changed" }),
  );
  expect((await app.request("/jobs")).status).toBe(500);
  await dbWrite
    .update(vertexTuningJobs)
    .set({
      last_remote_payload_storage: "inline",
      last_remote_payload_key: null,
      last_remote_payload: {},
    })
    .where(eq(vertexTuningJobs.id, jobId));
  expect((await app.request("/jobs")).status).toBe(500);
});

test("model identity collision cannot transfer another owner's model or partially commit success", async () => {
  await dbWrite.insert(vertexTunedModels).values({
    vertex_model_id: endpoint,
    display_name: "original global",
    base_model: "original",
    project_id: "controlled",
    region: "us-central1",
    slot: "response",
    source_scope: "global",
  });
  const [before] = await dbWrite.select().from(vertexTunedModels);
  provider = async () => Response.json(await raw("JOB_STATE_SUCCEEDED", 1));
  await expect(registry.syncJobStatus({ jobId, viewer })).rejects.toMatchObject(
    { code: "VERTEX_MODEL_IDENTITY_CONFLICT" },
  );
  expect((await dbWrite.select().from(vertexTunedModels))[0]).toEqual(before);
  expect((await dbWrite.select().from(vertexTuningJobs))[0].status).toBe(
    "JOB_STATE_RUNNING",
  );
});

test("a job deleted while its stored object is loading returns absence before provider work", async () => {
  const objects = objectFixture();
  provider = async () => Response.json(await raw("JOB_STATE_RUNNING", 1));
  const first = await registry.syncJobStatus({ jobId, viewer });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  objects.beforeGet(async () => {
    entered.resolve();
    await release.promise;
  });
  provider = async () => {
    throw new Error("PROVIDER_MUST_NOT_BE_CALLED");
  };
  const pending = registry.syncJobStatus({ jobId, viewer });
  void pending.catch(() => undefined);
  await entered.promise;
  await dbWrite.delete(vertexTuningJobs).where(eq(vertexTuningJobs.id, jobId));
  objects.bodies.delete(first!.job.last_remote_payload_key!);
  release.resolve();
  await expect(pending).resolves.toBeNull();
  expect(await dbWrite.select().from(vertexTunedModels)).toEqual([]);
});

test("submitted job replay preserves original ownership and rejects replacement intent", async () => {
  const remoteJob = await raw("JOB_STATE_RUNNING", 1);
  const submission = {
    vertexJobName: jobName,
    projectId: "controlled",
    region: "us-central1",
    displayName: "controlled-model",
    baseModel: "controlled-base-model",
    slot: "response" as const,
    scope: "organization" as const,
    organizationId: user.organization_id,
    createdByUserId: user.id,
    trainingDataPath: "controlled-training.jsonl",
    remoteJob: requireVertexObservation(remoteJob, jobName),
  };
  const first = await registry.recordSubmittedJob(submission);
  expect((await registry.recordSubmittedJob(submission)).job).toEqual(
    first.job,
  );
  await expect(
    registry.recordSubmittedJob({
      ...submission,
      scope: "global",
      organizationId: undefined,
    }),
  ).rejects.toMatchObject({ code: "VERTEX_SUBMISSION_CONFLICT" });
  await expect(
    registry.recordSubmittedJob({
      ...submission,
      trainingDataPath: "replacement.jsonl",
    }),
  ).rejects.toMatchObject({ code: "VERTEX_SUBMISSION_CONFLICT" });
  await expect(
    registry.recordSubmittedJob({
      ...submission,
      recommendedModelId: "unrelated-model",
    }),
  ).rejects.toMatchObject({ code: "VERTEX_SUBMISSION_CONFLICT" });
  expect(
    (await dbWrite.select().from(vertexTuningJobs))[0].organization_id,
  ).toBe(user.organization_id);
});

test("canonical job names retain configured project provenance during refresh", async () => {
  const canonicalName =
    "projects/123456789012/locations/us-central1/tuningJobs/original";
  const initial = await raw("JOB_STATE_RUNNING", 0, { name: canonicalName });
  await dbWrite
    .update(vertexTuningJobs)
    .set({
      vertex_job_name: canonicalName,
      last_remote_payload: initial,
    })
    .where(eq(vertexTuningJobs.id, jobId));
  const observation = await raw("JOB_STATE_RUNNING", 1, {
    name: canonicalName,
  });
  setControlledFetch(async (input) => {
    expect(String(input)).toBe(
      `https://aiplatform.googleapis.com/v1/${canonicalName}`,
    );
    return Response.json(observation);
  });

  const result = await app.request(`/jobs?jobId=${jobId}`);
  expect(result.status).toBe(200);
  const body = record(await result.json());
  expect(body.job).toEqual(observation);
  expect(record(body.jobRecord).project_id).toBe("controlled");
  expect(record(body.jobRecord).vertex_job_name).toBe(canonicalName);
});

test("provider-associated numeric resources bind once to the exact ID-form job", async () => {
  const resources = {
    endpoint:
      "projects/123456789012/locations/europe-west1/endpoints/provider-endpoint",
    model:
      "projects/123456789012/locations/europe-west1/models/provider-model@1",
  };
  const observation = await raw("JOB_STATE_SUCCEEDED", 1, {
    tunedModel: resources,
  });
  provider = async () => Response.json(observation);
  const first = await registry.syncJobStatus({ jobId, viewer });
  expect(first?.job.vertex_job_name).toBe(jobName);
  expect(first?.job.project_id).toBe("controlled");
  expect(first?.tunedModel?.vertex_model_id).toBe(resources.endpoint);
  expect(first?.job.last_remote_payload).toEqual(observation);

  provider = async () =>
    Response.json(
      await raw("JOB_STATE_SUCCEEDED", 2, {
        tunedModel: {
          ...resources,
          endpoint: `${resources.endpoint}-replacement`,
        },
      }),
    );
  await expect(registry.syncJobStatus({ jobId, viewer })).rejects.toMatchObject(
    {
      code: "VERTEX_TERMINAL_CONFLICT",
    },
  );
  expect(
    (await dbWrite.select().from(vertexTuningJobs))[0].last_remote_payload,
  ).toEqual(observation);
  expect(
    (await dbWrite.select().from(vertexTunedModels))[0].vertex_model_id,
  ).toBe(resources.endpoint);
});

test("submitted canonical names preserve immutable request project provenance", async () => {
  const canonicalName =
    "projects/123456789012/locations/us-central1/tuningJobs/canonical-submission";
  const submission = {
    vertexJobName: canonicalName,
    projectId: "controlled",
    region: "us-central1",
    displayName: "controlled-model",
    baseModel: "controlled-base-model",
    slot: "response" as const,
    scope: "organization" as const,
    organizationId: user.organization_id,
    createdByUserId: user.id,
    trainingDataPath: "controlled-training.jsonl",
    remoteJob: requireVertexObservation(
      await raw("JOB_STATE_RUNNING", 0, { name: canonicalName }),
      canonicalName,
    ),
  };
  const first = await registry.recordSubmittedJob(submission);
  expect(first.job.vertex_job_name).toBe(canonicalName);
  expect(first.job.project_id).toBe("controlled");
  expect((await registry.recordSubmittedJob(submission)).job.id).toBe(
    first.job.id,
  );
  await expect(
    registry.recordSubmittedJob({
      ...submission,
      projectId: "different-request-project",
    }),
  ).rejects.toMatchObject({ code: "VERTEX_SUBMISSION_CONFLICT" });
  await expect(
    registry.recordSubmittedJob({ ...submission, region: "europe-west1" }),
  ).rejects.toMatchObject({ code: "VERTEX_OBSERVATION_IDENTITY" });
});

test("creation retains the provider-assigned name from the configured project request", async () => {
  const directory = testOutputPath("vertex-create-boundary");
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(path.join(directory, "run-"));
  const trainingDataPath = path.join(temporary, "training.jsonl");
  const training =
    '{"contents":[{"role":"user","parts":[{"text":"complete training record"}]}]}\n';
  await writeFile(trainingDataPath, training);
  const canonicalName =
    "projects/123456789012/locations/us-central1/tuningJobs/created";
  let observation = await raw("JOB_STATE_PENDING", 0, {
    name: canonicalName,
  });
  const requests: string[] = [];
  setControlledFetch(async (input, init) => {
    const url = new URL(String(input));
    requests.push(url.href);
    expect(init?.method).toBe("POST");
    if (url.hostname === "storage.googleapis.com") {
      expect(url.pathname).toBe("/upload/storage/v1/b/controlled-bucket/o");
      expect(await new Response(init?.body).text()).toBe(training);
      return Response.json({});
    }
    expect(url.href).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/controlled/locations/us-central1/tuningJobs",
    );
    return Response.json(observation);
  });
  try {
    const config: Parameters<typeof createTuningJob>[0] = {
      projectId: "controlled",
      region: "us-central1",
      gcsBucket: "controlled-bucket",
      baseModel: "gemini-2.5-flash",
      trainingDataPath,
      displayName: "controlled-model",
      accessToken: "controlled-create-token",
    };
    const created = await createTuningJob(config);
    expect(created.job.name).toBe(canonicalName);
    expect(requests).toHaveLength(2);
    observation = await raw("JOB_STATE_PENDING", 0, {
      name: "projects/123456789012/locations/europe-west1/tuningJobs/created",
    });
    await expect(createTuningJob(config)).rejects.toMatchObject({
      code: "VERTEX_OBSERVATION_IDENTITY",
    });
    expect(requests).toHaveLength(4);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
