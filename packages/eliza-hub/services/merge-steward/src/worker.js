import { loadConfig } from "./config.js";

export async function runQueueWorker({
  steward,
  config = loadConfig(),
  logger = console,
  signal,
  sleep = delay,
  maxIterations = Number.POSITIVE_INFINITY,
} = {}) {
  if (!steward || typeof steward.runQueueOnce !== "function") {
    throw new TypeError("runQueueWorker requires a steward with runQueueOnce");
  }

  if (config.worker?.enabled !== true) {
    return workerSummary({ started: false, stopReason: "worker_disabled" });
  }

  const summary = workerSummary({ started: true });
  const maxErrors = Math.max(1, config.worker.maxConsecutiveErrors ?? 5);
  const intervalMs = Math.max(1000, config.worker.pollIntervalMs ?? 5000);

  while (!signal?.aborted && summary.iterations < maxIterations) {
    summary.iterations += 1;
    let leaseHeartbeat = null;
    try {
      const lease = await claimWorkerLease({ steward, config, logger });
      if (lease && lease.claimed !== true) {
        summary.leaseMisses += 1;
        summary.lastLease = summarizeLeaseResult(lease);
        summary.consecutiveErrors = 0;
        logger.info?.(
          "[MergeStewardWorker] lease held by another worker",
          summary.lastLease,
        );
      } else {
        if (lease) {
          summary.leaseAcquired += 1;
          summary.lastLease = summarizeLeaseResult(lease);
          leaseHeartbeat = startWorkerLeaseHeartbeat({
            steward,
            config,
            logger,
            lease: lease.lease,
          });
        }

        if (typeof steward.recoverStaleQueueItems === "function") {
          const recovery = await steward.recoverStaleQueueItems({
            workerId: config.worker.workerId,
            staleAfterMs: config.worker.staleQueueItemMs,
          });
          summary.recovered +=
            recovery.count ?? recovery.recovered?.length ?? 0;
          summary.lastRecovery = summarizeRecoveryResult(recovery);
        }

        const result = await steward.runQueueOnce({
          workerId: config.worker.workerId,
          confirmed: config.worker.confirmLiveExecution === true,
          beforeIntegrationAction: leaseHeartbeat?.assertActive,
        });
        summary.lastResult = summarizeWorkerResult(result);
        summary.consecutiveErrors = 0;

        if (result.claimed === true) {
          const itemCounts = queueItemOutcomeCounts(result);
          summary.claimed += 1;
          summary.processedItems += itemCounts.total;
          summary.failed += itemCounts.failed;
          summary.succeeded += itemCounts.succeeded;
          summary.requeued += itemCounts.requeued;
          logger.info?.(
            "[MergeStewardWorker] processed queue item",
            summary.lastResult,
          );
        } else {
          summary.idle += 1;
          logger.info?.(
            "[MergeStewardWorker] no queue item claimed",
            summary.lastResult,
          );
        }
      }
    } catch (error) {
      // error-policy:J1 worker-loop iteration boundary: the failure is counted
      // and logged, and the loop stops with a structured stopReason after
      // maxErrors
      summary.errors += 1;
      summary.consecutiveErrors += 1;
      summary.lastError = serializeWorkerError(error);
      logger.error?.(
        "[MergeStewardWorker] queue iteration failed",
        summary.lastError,
      );
      if (summary.consecutiveErrors >= maxErrors) {
        summary.stopReason = "too_many_consecutive_errors";
        break;
      }
    } finally {
      if (leaseHeartbeat) {
        const release = await leaseHeartbeat.stop({
          reason: "iteration_complete",
        });
        summary.lastLease = summarizeLeaseResult(release) ?? summary.lastLease;
      }
    }

    if (signal?.aborted || summary.iterations >= maxIterations) break;
    await sleep(intervalMs, signal);
  }

  if (!summary.stopReason) {
    summary.stopReason = signal?.aborted ? "aborted" : "max_iterations";
  }
  return summary;
}

function workerSummary({ started, stopReason = null } = {}) {
  return {
    started,
    stopReason,
    iterations: 0,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    requeued: 0,
    recovered: 0,
    processedItems: 0,
    idle: 0,
    errors: 0,
    consecutiveErrors: 0,
    leaseAcquired: 0,
    leaseMisses: 0,
    lastResult: null,
    lastRecovery: null,
    lastLease: null,
    lastError: null,
  };
}

function summarizeWorkerResult(result = {}) {
  const counts = queueItemOutcomeCounts(result);
  return {
    claimed: result.claimed === true,
    reason: result.reason ?? null,
    queueItemId: result.item?.id ?? null,
    queueItemIds: (result.items ?? (result.item ? [result.item] : [])).map(
      (item) => item.id,
    ),
    queueState: result.item?.queueState ?? null,
    itemCount: counts.total,
    succeededCount: counts.succeeded,
    failedCount: counts.failed,
    requeuedCount: counts.requeued,
    runId: result.run?.id ?? null,
    runStatus: result.run?.status ?? null,
    attemptId: result.attempt?.id ?? null,
    attemptStatus: result.attempt?.status ?? null,
  };
}

function summarizeRecoveryResult(result = {}) {
  return {
    count: result.count ?? result.recovered?.length ?? 0,
    recoveredItemIds: (result.recovered ?? [])
      .map((entry) => entry.item?.id ?? entry.id)
      .filter(Boolean),
  };
}

function queueItemOutcomeCounts(result = {}) {
  const items = result.items ?? (result.item ? [result.item] : []);
  const runs = result.runs ?? (result.run ? [result.run] : []);
  const total = Math.max(
    items.length,
    runs.length,
    result.claimed === true ? 1 : 0,
  );
  let failed = 0;
  let requeued = 0;
  let succeeded = 0;

  for (let index = 0; index < total; index += 1) {
    const item = items[index] ?? null;
    const run = runs[index] ?? null;
    if (item?.queueState === "queued" && run?.status === "failed") {
      requeued += 1;
    } else if (run?.status === "failed" || item?.queueState === "failed") {
      failed += 1;
    } else {
      succeeded += 1;
    }
  }

  return { total, succeeded, failed, requeued };
}

async function claimWorkerLease({ steward, config, logger }) {
  if (config.worker?.leaseEnabled !== true) return null;
  const store = steward.store;
  if (!store || typeof store.claimWorkerLease !== "function") {
    throw new TypeError(
      "merge worker lease requires a store with claimWorkerLease",
    );
  }

  const result = await store.claimWorkerLease(
    {
      id: config.worker.leaseId,
      ownerId: config.worker.workerId,
      metadata: {
        service: "merge-steward",
        purpose: "merge-queue-worker",
      },
    },
    {
      ttlMs: config.worker.leaseTtlMs,
    },
  );
  logger.debug?.(
    "[MergeStewardWorker] lease claim result",
    summarizeLeaseResult(result),
  );
  return result;
}

function startWorkerLeaseHeartbeat({ steward, config, logger, lease }) {
  const store = steward.store;
  const ownerId = config.worker.workerId;
  const leaseId = lease.id;
  const ttlMs = config.worker.leaseTtlMs;
  const intervalMs = config.worker.leaseHeartbeatIntervalMs;
  let lastLease = lease;
  let lastError = null;
  let lostReason = null;
  let heartbeatRunning = false;

  const interval = setInterval(async () => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      const renewed = await store.heartbeatWorkerLease(leaseId, {
        ownerId,
        ttlMs,
      });
      if (!renewed) {
        lostReason = "worker_lease_lost";
        lastError = {
          name: "Error",
          message: "worker lease heartbeat lost ownership",
        };
        logger.error?.(
          "[MergeStewardWorker] lease heartbeat lost ownership",
          summarizeLease(lease),
        );
      } else {
        lastLease = renewed;
        logger.debug?.(
          "[MergeStewardWorker] lease heartbeat renewed",
          summarizeLease(renewed),
        );
      }
    } catch (error) {
      // error-policy:J7 a heartbeat tick must not kill the interval; the
      // failure is recorded in lastError and surfaced by assertActive/release
      lastError = serializeWorkerError(error);
      logger.error?.("[MergeStewardWorker] lease heartbeat failed", lastError);
    } finally {
      heartbeatRunning = false;
    }
  }, intervalMs);
  interval.unref?.();

  return {
    async assertActive({ action, itemPlan } = {}) {
      const active = await checkWorkerLease({
        store,
        leaseId,
        ownerId,
        lastLease,
      });
      if (!active.ok) {
        lostReason = active.reason;
        lastLease = active.lease ?? lastLease;
        lastError = {
          name: "Error",
          message: active.reason,
        };
        logger.error?.(
          "[MergeStewardWorker] lease guard blocked integration action",
          {
            reason: active.reason,
            lease: summarizeLease(lastLease),
            actionType: action?.type ?? null,
            queueItemId: itemPlan?.queueItemId ?? null,
            pullRequestId: itemPlan?.pullRequestId ?? null,
          },
        );
        return {
          ok: false,
          reason: active.reason,
          lease: summarizeLease(lastLease),
          lastError,
        };
      }

      lastLease = active.lease;
      return {
        ok: true,
        lease: summarizeLease(lastLease),
      };
    },
    async stop({ reason }) {
      clearInterval(interval);
      try {
        const release = await store.releaseWorkerLease(leaseId, {
          ownerId,
          reason,
        });
        return {
          claimed: true,
          released: release != null,
          reason: release ? "released" : "release_failed",
          lease: release ?? lastLease,
          lostReason,
          lastError,
        };
      } catch (error) {
        // error-policy:J6 lease release is teardown: the failure is logged and
        // returned as an explicit release_failed result
        lastError = serializeWorkerError(error);
        logger.error?.("[MergeStewardWorker] lease release failed", lastError);
        return {
          claimed: true,
          released: false,
          reason: "release_failed",
          lease: lastLease,
          lostReason,
          lastError,
        };
      }
    },
  };
}

async function checkWorkerLease({ store, leaseId, ownerId, lastLease }) {
  const lease =
    typeof store.getWorkerLease === "function"
      ? await store.getWorkerLease(leaseId)
      : lastLease;
  if (!lease) {
    return { ok: false, reason: "worker_lease_missing", lease: null };
  }
  if (lease.status !== "active") {
    return { ok: false, reason: "worker_lease_inactive", lease };
  }
  if (lease.ownerId !== ownerId) {
    return { ok: false, reason: "worker_lease_lost", lease };
  }
  if (isLeaseExpired(lease.expiresAt, new Date().toISOString())) {
    return { ok: false, reason: "worker_lease_expired", lease };
  }
  return { ok: true, lease };
}

function summarizeLeaseResult(result = {}) {
  return {
    claimed: result.claimed === true,
    released: result.released === true,
    reason: result.reason ?? null,
    lostReason: result.lostReason ?? null,
    lastError: result.lastError ?? null,
    lease: summarizeLease(result.lease),
  };
}

function summarizeLease(lease = null) {
  if (!lease) return null;
  return {
    id: lease.id ?? null,
    ownerId: lease.ownerId ?? null,
    status: lease.status ?? null,
    acquiredAt: lease.acquiredAt ?? null,
    renewedAt: lease.renewedAt ?? null,
    expiresAt: lease.expiresAt ?? null,
    releasedAt: lease.releasedAt ?? null,
  };
}

function serializeWorkerError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return {
    name: "Error",
    message: String(error ?? "worker_error"),
  };
}

function isLeaseExpired(expiresAt, now) {
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) return false;
  return expiresAtMs <= nowMs;
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timeout = setTimeout(cleanup, ms);
    signal?.addEventListener("abort", cleanup, { once: true });

    function cleanup() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cleanup);
      resolve();
    }
  });
}
