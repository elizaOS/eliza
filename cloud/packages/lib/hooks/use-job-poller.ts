"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type JobStatus = "pending" | "in_progress" | "completed" | "failed";

export interface TrackedJob {
  jobId: string;
  key: string;
  status: JobStatus;
  error?: string | null;
  startedAt: number;
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

export function useJobPoller(options: UseJobPollerOptions = {}) {
  const {
    intervalMs = 5_000,
    // Agent provisioning can take multiple attempts with backoff, plus cron pickup lag.
    // Keep the default local timeout comfortably above the server-side retry window.
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
    () => Array.from(jobMap.values()).filter((job) => isActiveStatus(job.status)),
    [jobMap],
  );
  const hasActiveJobs = activeJobs.length > 0;

  const track = useCallback((key: string, jobId: string) => {
    setJobMap((prev) => {
      const next = new Map(prev);
      next.set(key, {
        key,
        jobId,
        status: "pending",
        error: null,
        startedAt: Date.now(),
      });
      return next;
    });
  }, []);

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
      if (pollInFlightRef.current) {
        return;
      }
      pollInFlightRef.current = true;

      try {
        const currentActive = Array.from(jobMapRef.current.values()).filter((job) =>
          isActiveStatus(job.status),
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
              error: "Timed out waiting for provisioning to complete",
            };

            setJobMap((prev) => {
              const next = new Map(prev);
              next.set(job.key, timedOutJob);
              return next;
            });

            callbacksRef.current.onFailed?.(timedOutJob);
            needsRefresh = true;
            continue;
          }

          try {
            const res = await fetch(`/api/v1/jobs/${job.jobId}`);
            if (!res.ok) {
              continue;
            }

            const data = await res.json().catch(() => null);
            const nextStatus = data?.data?.status as JobStatus | undefined;
            const nextError = data?.data?.error;

            if (!nextStatus) {
              continue;
            }

            const updatedJob: TrackedJob = {
              ...job,
              status: nextStatus,
              error: typeof nextError === "string" ? nextError : (nextError?.message ?? null),
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
              needsRefresh = true;
            }
          } catch {}
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
