interface MinimalLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface CronServiceJobInput {
  name: string;
  description?: string;
  enabled?: boolean;
  schedule:
    | { kind: "cron"; expr: string; tz?: string }
    | { kind: "every"; everyMs: number };
  payload:
    | { kind: "event"; eventName: string; payload?: Record<string, unknown> }
    | { kind: "prompt"; text: string }
    | {
        kind: "action";
        actionName: string;
        params?: Record<string, unknown>;
      };
  metadata?: Record<string, unknown>;
}

interface CronJobLike {
  id: string;
  name: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CronServiceLike {
  createJob: (input: CronServiceJobInput) => Promise<unknown>;
  listJobs?: (filter?: { includeDisabled?: boolean }) => Promise<CronJobLike[]>;
  deleteJob?: (jobId: string) => Promise<boolean>;
}

const registeredRuntimeEvents = new WeakMap<object, Set<string>>();

export async function ensureNamedCronJob(
  cronService: CronServiceLike,
  job: CronServiceJobInput,
  options?: {
    log?: MinimalLogger;
    logPrefix?: string;
  },
): Promise<"created" | "existing"> {
  const logPrefix = options?.logPrefix ?? "[CronRegistration]";
  const matchingJobs =
    typeof cronService.listJobs === "function"
      ? (await cronService.listJobs({ includeDisabled: true }))
          .filter((entry) => entry.name === job.name)
          .sort((left, right) => {
            if (right.updatedAtMs !== left.updatedAtMs) {
              return right.updatedAtMs - left.updatedAtMs;
            }
            return right.createdAtMs - left.createdAtMs;
          })
      : [];

  if (matchingJobs.length > 1 && typeof cronService.deleteJob === "function") {
    for (const duplicate of matchingJobs.slice(1)) {
      const deleted = await cronService.deleteJob(duplicate.id);
      if (!deleted) {
        options?.log?.warn(
          `${logPrefix} could not remove duplicate cron "${job.name}" (${duplicate.id})`,
        );
      }
    }
    options?.log?.info(
      `${logPrefix} removed ${matchingJobs.length - 1} duplicate cron registration${matchingJobs.length === 2 ? "" : "s"} for "${job.name}"`,
    );
    return "existing";
  }

  if (matchingJobs.length > 0) {
    return "existing";
  }

  await cronService.createJob(job);
  return "created";
}

export function registerRuntimeEventOnce(
  runtime: {
    registerEvent?: (
      name: string,
      handler: (payload: unknown) => Promise<void>,
    ) => void;
  },
  eventName: string,
  handler: (payload: unknown) => Promise<void>,
): boolean {
  if (typeof runtime.registerEvent !== "function") {
    return false;
  }

  const runtimeKey = runtime as object;
  let registeredEvents = registeredRuntimeEvents.get(runtimeKey);
  if (!registeredEvents) {
    registeredEvents = new Set<string>();
    registeredRuntimeEvents.set(runtimeKey, registeredEvents);
  }
  if (registeredEvents.has(eventName)) {
    return false;
  }

  runtime.registerEvent(eventName, handler);
  registeredEvents.add(eventName);
  return true;
}
