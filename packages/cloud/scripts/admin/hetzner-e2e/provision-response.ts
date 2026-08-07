type JsonObject = Record<string, unknown>;

/**
 * Normalize the two successful provisioning contracts exposed by staging.
 * Dedicated provisioning is asynchronous (202 + jobId); an agent already on
 * the shared runtime is immediately available (200 + running) and has no job.
 */
export function provisionJobId(
  status: number,
  body: JsonObject,
): string | null {
  const data = body.data as JsonObject | undefined;
  if (status === 202 && typeof data?.jobId === "string") {
    return data.jobId;
  }
  if (
    status === 200 &&
    body.source === "shared_runtime" &&
    data?.status === "running"
  ) {
    return null;
  }
  throw new Error(
    status === 202
      ? "Provision response missing jobId"
      : "Immediate provision response was not a running shared-runtime agent",
  );
}
