/**
 * Generic background-job poller for agent provisioning / suspend / delete jobs.
 *
 * Tracks jobs by an arbitrary key (the agent id), polls `GET /api/v1/jobs/:id`
 * until each reaches a terminal state, and fires `onComplete` / `onFailed`.
 * When `autoRefresh` is set it does a hard `window.location.reload()` after a
 * successful job. Failures remain in memory so the detail page can show the
 * authoritative error and recovery guidance instead of erasing it immediately.
 * The agents *table* passes its own `onComplete`/`onFailed` and re-fetches via
 * react-query-style local merge instead, so it never triggers the reload.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api-client";

export type JobStatus = "pending" | "in_progress" | "completed" | "failed";

export interface TrackedJob {
  jobId: string;
  key: string;
  status: JobStatus;
  error?: string | null;
  startedAt: number;
  attempts?: number;
  maxAttempts?: number;
  estimatedCompletionAt?: string | null;
}

interface UseJobPollerOptions {
  intervalMs?: number;
  maxDurationMs?: number;
  onComplete?: (job: TrackedJob) => void;
  onFailed?: (job: TrackedJob) => void;
  autoRefresh?: boolean;
}

function isActiveStatus(status: JobStatus) {
  return status === "pending" || status === "in_progress";
}

function isJobStatus(value: unknown): value is JobStatus {
  return (
    value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "failed"
  );
}

export function useJobPoller(options: UseJobPollerOptions = {}) {
  const {
    intervalMs = 5_000,
    // Agent provisioning can take multiple attempts with backoff, plus cron
    // pickup lag. Keep the default local timeout above the server retry window.
    maxDurationMs = 10 * 60_000,
    onComplete,
    onFailed,
    autoRefresh = true,
  } = options;

  const [jobMap, setJobMap] = useState<Map<string, TrackedJob>>(new Map());
  const jobMapRef = useRef(jobMap);
  const callbacksRef = useRef({ onComplete, onFailed });
  const pollInFlightRef = useRef(false);

  useEffect(() => {
    jobMapRef.current = jobMap;
  }, [jobMap]);

  useEffect(() => {
    callbacksRef.current = { onComplete, onFailed };
  }, [onComplete, onFailed]);

  const activeJobs = useMemo(
    () =>
      Array.from(jobMap.values()).filter((job) => isActiveStatus(job.status)),
    [jobMap],
  );
  const hasActiveJobs = activeJobs.length > 0;

  const track = useCallback(
    (
      key: string,
      jobId: string,
      initial?: Pick<
        TrackedJob,
        | "status"
        | "startedAt"
        | "attempts"
        | "maxAttempts"
        | "estimatedCompletionAt"
      >,
    ) => {
      setJobMap((prev) => {
        const existing = prev.get(key);
        if (existing?.jobId === jobId) return prev;
        const next = new Map(prev);
        next.set(key, {
          key,
          jobId,
          status: initial?.status ?? "pending",
          error: null,
          startedAt: initial?.startedAt ?? Date.now(),
          attempts: initial?.attempts,
          maxAttempts: initial?.maxAttempts,
          estimatedCompletionAt: initial?.estimatedCompletionAt,
        });
        return next;
      });
    },
    [],
  );

  const getStatus = useCallback((key: string) => jobMap.get(key), [jobMap]);

  const isActive = useCallback(
    (key: string) => {
      const job = jobMap.get(key);
      return !!job && isActiveStatus(job.status);
    },
    [jobMap],
  );

  useEffect(() => {
    if (!hasActiveJobs) {
      return;
    }

    let cancelled = false;

    const pollOnce = async () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        return;
      }
      if (pollInFlightRef.current) {
        return;
      }
      pollInFlightRef.current = true;

      try {
        const currentActive = Array.from(jobMapRef.current.values()).filter(
          (job) => isActiveStatus(job.status),
        );

        if (currentActive.length === 0 || cancelled) {
          return;
        }

        let needsRefresh = false;

        for (const job of currentActive) {
          if (Date.now() - job.startedAt > maxDurationMs) {
            const timedOutJob: TrackedJob = {
              ...job,
              status: "failed",
              error: "Timed out waiting for job to complete",
            };

            setJobMap((prev) => {
              const next = new Map(prev);
              next.set(job.key, timedOutJob);
              return next;
            });

            callbacksRef.current.onFailed?.(timedOutJob);
            continue;
          }

          try {
            // Bound each poll hop so a hung job endpoint cannot pin
            // pollInFlightRef forever and silently kill the poller.
            const data = await api<{
              data?: {
                status?: JobStatus;
                error?: string | { message?: string } | null;
                attempts?: number;
                maxAttempts?: number;
                estimatedCompletionAt?: string | null;
              };
            }>(`/api/v1/jobs/${job.jobId}`, {
              signal: AbortSignal.timeout(10_000),
            });
            const nextStatus = data?.data?.status;
            const nextError = data?.data?.error;

            if (!isJobStatus(nextStatus)) {
              continue;
            }

            const updatedJob: TrackedJob = {
              ...job,
              status: nextStatus,
              error:
                typeof nextError === "string"
                  ? nextError
                  : (nextError?.message ?? null),
              attempts:
                typeof data?.data?.attempts === "number"
                  ? data.data.attempts
                  : job.attempts,
              maxAttempts:
                typeof data?.data?.maxAttempts === "number"
                  ? data.data.maxAttempts
                  : job.maxAttempts,
              estimatedCompletionAt:
                typeof data?.data?.estimatedCompletionAt === "string" ||
                data?.data?.estimatedCompletionAt === null
                  ? data.data.estimatedCompletionAt
                  : job.estimatedCompletionAt,
            };

            setJobMap((prev) => {
              const next = new Map(prev);
              next.set(job.key, updatedJob);
              return next;
            });

            if (nextStatus === "completed") {
              callbacksRef.current.onComplete?.(updatedJob);
              needsRefresh = true;
            } else if (nextStatus === "failed") {
              callbacksRef.current.onFailed?.(updatedJob);
            }
          } catch {
            // error-policy:J4 transient status-read failure preserves the
            // visible in-progress state and retries on the next poll tick.
          }
        }

        if (needsRefresh && autoRefresh && !cancelled) {
          window.location.reload();
        }
      } finally {
        pollInFlightRef.current = false;
      }
    };

    const intervalId = window.setInterval(() => {
      void pollOnce();
    }, intervalMs);

    void pollOnce();

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [hasActiveJobs, autoRefresh, intervalMs, maxDurationMs]);

  return {
    track,
    getStatus,
    isActive,
    activeJobs,
  };
}
