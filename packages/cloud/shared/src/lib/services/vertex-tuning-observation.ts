/** Complete provider observations with exact nanosecond ordering and original resource binding. */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { VERTEX_TUNING_JOB_STATES } from "../../types/vertex-tuning";

const jobName =
  /^projects\/([A-Za-z0-9_-]+)\/locations\/([A-Za-z0-9_-]+)\/tuningJobs\/([A-Za-z0-9_-]+)$/;
const timestamp = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const observationSchema = z
  .object({
    name: z.string().regex(jobName),
    state: z.enum(VERTEX_TUNING_JOB_STATES),
    createTime: z.string(),
    updateTime: z.string(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
    tunedModelDisplayName: z.string().optional(),
    // Retain the legacy field, but prefer the documented TunedModel resource.
    tunedModelEndpointName: z.string().optional(),
    tunedModel: z
      .object({ model: z.string().optional(), endpoint: z.string().optional() })
      .passthrough()
      .optional(),
    error: z
      .object({ code: z.number().int().optional(), message: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type TuningJob = z.infer<typeof observationSchema>;

export function vertexObservationError(code: string, message: string): never {
  throw new ElizaError(message, { code });
}

/** Keep the fractional part out of Date: Date has only millisecond precision. */
export function vertexTimestampVersion(value: string): string {
  const match = timestamp.exec(value);
  if (!match)
    return vertexObservationError("VERTEX_OBSERVATION_INVALID", "Invalid provider timestamp");
  const [, date, time, fraction = "", offset] = match;
  const base = Date.parse(`${date}T${time}${offset}`);
  if (!Number.isFinite(base) || !date || !time || !offset || Number(time.slice(6, 8)) > 59)
    return vertexObservationError("VERTEX_OBSERVATION_INVALID", "Invalid provider timestamp");
  // Reject Date's normalization of impossible calendar dates and offsets.
  const local = Date.parse(`${date}T${time}Z`);
  if (!Number.isFinite(local) || new Date(local).toISOString().slice(0, 19) !== `${date}T${time}`)
    return vertexObservationError("VERTEX_OBSERVATION_INVALID", "Invalid provider calendar date");
  const utc = new Date(base).toISOString();
  if (!/^[0-9]{4}-/.test(utc) || utc.startsWith("0000-") || date.startsWith("0000-"))
    return vertexObservationError(
      "VERTEX_OBSERVATION_INVALID",
      "Provider timestamp is outside the supported calendar",
    );
  return `${utc.slice(0, 19)}.${fraction.padEnd(9, "0")}Z`;
}

export function requireVertexJobName(value: string): { project: string; region: string } {
  const match = jobName.exec(value);
  if (!match)
    return vertexObservationError("VERTEX_OBSERVATION_INVALID", "Invalid Vertex job resource name");
  return { project: match[1]!, region: match[2]! };
}

// TuningJob documents completion for these four states. Partial success keeps
// its own state and can receive a newer definitive outcome.
export function isTerminalVertexState(state: TuningJob["state"]): boolean {
  return [
    "JOB_STATE_SUCCEEDED",
    "JOB_STATE_FAILED",
    "JOB_STATE_CANCELLED",
    "JOB_STATE_EXPIRED",
  ].includes(state);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export function vertexPayloadDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function vertexTunedResources(job: TuningJob): {
  endpoint: string | null;
  model: string | null;
} {
  requireVertexJobName(job.name);
  const endpoint = job.tunedModel?.endpoint ?? job.tunedModelEndpointName ?? null;
  const model = job.tunedModel?.model ?? null;
  if (
    job.tunedModel?.endpoint &&
    job.tunedModelEndpointName &&
    job.tunedModel.endpoint !== job.tunedModelEndpointName
  )
    return vertexObservationError(
      "VERTEX_OBSERVATION_INVALID",
      "Conflicting Vertex endpoint identities",
    );
  // The authenticated exact-job response establishes resource association.
  // Neither project ID/number spelling nor the default upload region proves
  // that association. Retain the full names without guessing or rewriting.
  if (
    endpoint !== null &&
    !/^projects\/[A-Za-z0-9_-]+\/locations\/[A-Za-z0-9_-]+\/endpoints\/[A-Za-z0-9_-]+$/.test(
      endpoint,
    )
  )
    return vertexObservationError("VERTEX_OBSERVATION_INVALID", "Invalid Vertex endpoint identity");
  if (
    model !== null &&
    !/^projects\/[A-Za-z0-9_-]+\/locations\/[A-Za-z0-9_-]+\/models\/[A-Za-z0-9_-]+(?:@[A-Za-z0-9_-]+)?$/.test(
      model,
    )
  )
    return vertexObservationError("VERTEX_OBSERVATION_INVALID", "Invalid Vertex model identity");
  return { endpoint, model };
}

export function requireVertexObservation(value: unknown, expectedName: string): TuningJob {
  requireVertexJobName(expectedName);
  const parsed = observationSchema.safeParse(value);
  if (!parsed.success)
    return vertexObservationError("VERTEX_OBSERVATION_INVALID", "Invalid Vertex job observation");
  const job = parsed.data;
  if (job.name !== expectedName)
    return vertexObservationError(
      "VERTEX_OBSERVATION_IDENTITY",
      "Provider returned a different Vertex job",
    );
  const created = vertexTimestampVersion(job.createTime);
  const updated = vertexTimestampVersion(job.updateTime);
  if (created > updated)
    return vertexObservationError(
      "VERTEX_OBSERVATION_INVALID",
      "Provider update precedes job creation",
    );
  for (const optional of [job.startTime, job.endTime])
    if (optional !== undefined) vertexTimestampVersion(optional);
  const resources = vertexTunedResources(job);
  if (job.state === "JOB_STATE_SUCCEEDED" && !resources.endpoint && !resources.model)
    return vertexObservationError(
      "VERTEX_OBSERVATION_INVALID",
      "Successful Vertex job has no model resource",
    );
  return job;
}
