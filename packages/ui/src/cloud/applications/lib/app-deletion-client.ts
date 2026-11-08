/** Wait on the existing jobs endpoint; cancelling this wait never cancels teardown. */
import { apiWithStatus } from "../../lib/api-client";

type Request = (
  path: string,
  init: { method?: string; signal: AbortSignal },
) => Promise<{ status: number; data: unknown }>;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid app deletion response");
  return value as Record<string, unknown>;
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export async function deleteAppAndWait(
  appId: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    pollIntervalMs?: number;
    request?: Request;
  } = {},
): Promise<void> {
  const request = options.request ?? apiWithStatus;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  const send = (path: string, method?: string) =>
    request(path, {
      method,
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
  const initial = await send(
    `/api/v1/apps/${encodeURIComponent(appId)}`,
    "DELETE",
  );
  const data = record(initial.data);
  if (
    (initial.status !== 200 && initial.status !== 202) ||
    data.appId !== appId ||
    typeof data.jobId !== "string" ||
    !data.jobId
  )
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : "App deletion was not accepted",
    );
  if (initial.status === 200) {
    if (
      data.success !== true ||
      data.state !== "completed" ||
      data.status !== "completed"
    )
      throw new Error("App deletion completion is unconfirmed");
    return;
  }
  if (data.success !== false || data.state !== "pending")
    throw new Error("Invalid pending app deletion response");
  if (data.status === "failed" || data.status === "cancelled")
    throw new Error(
      "App deletion requires recovery; the original job is retained",
    );
  for (;;) {
    signal.throwIfAborted();
    const polled = await send(`/api/v1/jobs/${encodeURIComponent(data.jobId)}`);
    const envelope = record(polled.data);
    const job = record(envelope.data);
    if (
      polled.status !== 200 ||
      envelope.success !== true ||
      job.id !== data.jobId ||
      job.type !== "app_delete"
    )
      throw new Error("App deletion job could not be verified");
    if (job.status === "completed") {
      const result = record(job.result);
      if (
        result.appDeleted !== true ||
        result.appId !== appId ||
        result.deletionJobId !== data.jobId
      )
        throw new Error("App deletion completion receipt is missing");
      return;
    }
    if (job.status !== "pending" && job.status !== "in_progress")
      throw new Error(
        "App deletion requires recovery; the original job is retained",
      );
    await pause(options.pollIntervalMs ?? 2_000, signal);
  }
}
