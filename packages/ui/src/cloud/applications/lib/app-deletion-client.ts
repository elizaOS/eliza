/** Observe the original deletion job; stopping observation never cancels teardown. */
import { apiWithStatus } from "../../lib/api-client";

type Request = (
  path: string,
  init: { method?: string; signal: AbortSignal },
) => Promise<{ status: number; data: unknown }>;
interface WaitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
  request?: Request;
}

/** An accepted operation survives loss of its observer and must retain its identity. */
export class AppDeletionPendingError extends Error {
  constructor(
    readonly appId: string,
    readonly jobId: string,
    readonly reason: "observation_unavailable" | "recovery_required",
    message: string,
  ) {
    super(message);
    this.name = "AppDeletionPendingError";
  }
}

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
function observer(options: WaitOptions) {
  const request = options.request ?? apiWithStatus;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  return {
    signal,
    send: (path: string, method?: string) =>
      request(path, {
        method,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      }),
  };
}

async function observeOriginal(
  appId: string,
  jobId: string,
  options: WaitOptions,
  client: ReturnType<typeof observer>,
): Promise<void> {
  try {
    for (;;) {
      client.signal.throwIfAborted();
      const polled = await client.send(
        `/api/v1/jobs/${encodeURIComponent(jobId)}`,
      );
      const envelope = record(polled.data);
      const job = record(envelope.data);
      if (
        polled.status !== 200 ||
        envelope.success !== true ||
        job.id !== jobId ||
        job.type !== "app_delete"
      )
        throw new Error("App deletion job could not be verified");
      if (job.status === "completed") {
        const result = record(job.result);
        if (
          result.appDeleted !== true ||
          result.appId !== appId ||
          result.deletionJobId !== jobId ||
          result.cleanupConfirmed !== true
        )
          throw new Error("App deletion completion receipt is missing");
        return;
      }
      if (job.status === "failed" || job.status === "cancelled")
        throw new AppDeletionPendingError(
          appId,
          jobId,
          "recovery_required",
          "App deletion requires recovery; the original job is retained",
        );
      if (job.status !== "pending" && job.status !== "in_progress")
        throw new Error("App deletion job status could not be verified");
      await pause(options.pollIntervalMs ?? 2_000, client.signal);
    }
  } catch (error) {
    if (error instanceof AppDeletionPendingError) throw error;
    throw new AppDeletionPendingError(
      appId,
      jobId,
      "observation_unavailable",
      error instanceof Error
        ? error.message
        : "App deletion status could not be confirmed",
    );
  }
}

/** Read-only retry of an already accepted original job, never another DELETE. */
export async function resumeAppDeletionAndWait(
  appId: string,
  jobId: string,
  options: WaitOptions = {},
): Promise<void> {
  if (!appId || !jobId)
    throw new Error("Original app deletion identity is required");
  return observeOriginal(appId, jobId, options, observer(options));
}

export async function deleteAppAndWait(
  appId: string,
  options: WaitOptions = {},
): Promise<void> {
  const client = observer(options);
  const initial = await client.send(
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
    throw new AppDeletionPendingError(
      appId,
      data.jobId,
      "recovery_required",
      "App deletion requires recovery; the original job is retained",
    );
  return observeOriginal(appId, data.jobId, options, client);
}
