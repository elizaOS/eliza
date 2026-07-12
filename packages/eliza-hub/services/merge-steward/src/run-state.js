const TERMINAL_STATE_MAP = Object.freeze({
  merged: "succeeded",
  closed: "cancelled",
  cancelled: "cancelled",
  failed: "failed",
  integration_failed: "failed",
});

const AGENT_RUN_STATES = new Set([
  "running",
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "paused",
  "recovering",
  "stale",
  "orphaned",
  "failed",
  "cancelled",
  "succeeded",
  "unknown",
]);

export function deriveQueueItemRunState(
  item,
  { now = Date.now(), staleAfterMs = 30 * 60 * 1000 } = {},
) {
  if (!item) return null;

  const computedAt = new Date(now).toISOString();
  const base = {
    queueItemId: item.id ?? null,
    repo: item.repo ?? null,
    pullRequestId: item.pullRequestId ?? null,
    computedAt,
  };

  const agentState = deriveAgentRunState(item.agentRun, base);
  if (agentState) return agentState;

  const queueState = normalizeQueueState(item.queueState);
  if (TERMINAL_STATE_MAP[queueState]) {
    return {
      ...base,
      state: TERMINAL_STATE_MAP[queueState],
      ...(item.lastError
        ? { unhealthy: { kind: "queue-error", message: item.lastError } }
        : {}),
    };
  }

  if (queueState === "running" || queueState === "building_integration") {
    return runningState({ base, item, now, staleAfterMs });
  }

  if (queueState === "waiting_for_review") {
    return {
      ...base,
      state: "waiting-approval",
      blocked: {
        kind: "approval",
        nodeId: "review",
        requestedAt: item.updatedAt ?? item.createdAt ?? computedAt,
      },
    };
  }

  if (queueState === "waiting_for_checks") {
    return {
      ...base,
      state: "waiting-event",
      blocked: {
        kind: "event",
        nodeId: "required_checks",
        correlationKey: item.headSha ?? item.id ?? "checks",
      },
    };
  }

  if (queueState === "blocked_stale") {
    return {
      ...base,
      state: "stale",
      unhealthy: {
        kind: "branch-stale",
        targetBranch: item.targetBranch ?? null,
      },
    };
  }

  if (queueState?.startsWith("blocked") || queueState === "quarantined") {
    return {
      ...base,
      state: "waiting-event",
      blocked: { kind: "policy", queueState },
    };
  }

  if (queueState === "queued" || queueState === "ready") {
    return {
      ...base,
      state: "waiting-event",
      blocked: { kind: "queue-lane", targetBranch: item.targetBranch ?? null },
    };
  }

  return {
    ...base,
    state: "unknown",
  };
}

export function deriveStewardRunState(
  run,
  { nodes = [], now = Date.now(), staleAfterMs = 30 * 1000 } = {},
) {
  if (!run) return null;

  const computedAt = new Date(now).toISOString();
  const state = normalizeAgentState(run.status);
  const base = {
    runId: run.id ?? run.runId ?? null,
    queueItemId: run.queueItemId ?? null,
    repo: run.repo ?? null,
    pullRequestId: run.pullRequestId ?? null,
    computedAt,
  };

  if (state === "finished" || state === "continued" || state === "succeeded") {
    return { ...base, state: "succeeded" };
  }
  if (state === "failed" || state === "cancelled" || state === "paused") {
    return { ...base, state };
  }
  if (state === "waiting-approval") {
    const node =
      firstNodeWithStatus(nodes, "waiting-approval") ??
      firstNodeWithStatus(nodes, "approval-requested");
    return {
      ...base,
      state: "waiting-approval",
      ...(node
        ? {
            blocked: {
              kind: "approval",
              nodeId: node.nodeId,
              requestedAt: node.updatedAt ?? node.createdAt ?? computedAt,
            },
          }
        : {}),
    };
  }
  if (state === "waiting-event") {
    const node = firstNodeWithStatus(nodes, "waiting-event");
    return {
      ...base,
      state: "waiting-event",
      blocked: {
        kind: "event",
        nodeId: node?.nodeId ?? "external_event",
        correlationKey:
          node?.correlationKey ??
          run.correlationKey ??
          run.queueItemId ??
          run.id ??
          "event",
      },
    };
  }
  if (state === "waiting-timer") {
    const node = firstNodeWithStatus(nodes, "waiting-timer");
    return {
      ...base,
      state: "waiting-timer",
      blocked: {
        kind: "timer",
        nodeId: node?.nodeId ?? "timer",
        wakeAt: node?.wakeAt ?? run.wakeAt ?? null,
      },
    };
  }
  if (state === "recovering") {
    return { ...base, state: "recovering" };
  }
  if (state === "running") {
    const lastAliveMs = Date.parse(
      run.heartbeatAt ?? run.startedAt ?? run.updatedAt ?? run.createdAt ?? "",
    );
    if (Number.isFinite(lastAliveMs) && now - lastAliveMs > staleAfterMs) {
      return {
        ...base,
        state: run.runtimeOwnerId ? "stale" : "orphaned",
        unhealthy: {
          kind: "engine-heartbeat-stale",
          lastHeartbeatAt: new Date(lastAliveMs).toISOString(),
        },
      };
    }
    return { ...base, state: "running" };
  }

  return { ...base, state: "unknown" };
}

function deriveAgentRunState(agentRun, base) {
  if (!agentRun || typeof agentRun !== "object") return null;
  const state = normalizeAgentState(agentRun.state ?? agentRun.status);
  if (!AGENT_RUN_STATES.has(state)) return null;

  return {
    ...base,
    runId: agentRun.runId ?? agentRun.id ?? null,
    state,
    ...(agentRun.blocked ? { blocked: agentRun.blocked } : {}),
    ...(agentRun.unhealthy ? { unhealthy: agentRun.unhealthy } : {}),
    ...(agentRun.failedChildren > 0
      ? {
          unhealthy: {
            kind: "failed-children",
            failedChildren: agentRun.failedChildren,
            failedChildKeys: agentRun.failedChildKeys ?? [],
          },
        }
      : {}),
  };
}

function runningState({ base, item, now, staleAfterMs }) {
  const lastAliveMs = Date.parse(
    item.heartbeatAt ??
      item.claimedAt ??
      item.updatedAt ??
      item.createdAt ??
      "",
  );
  if (Number.isFinite(lastAliveMs) && now - lastAliveMs > staleAfterMs) {
    return {
      ...base,
      state: "stale",
      unhealthy: {
        kind: "engine-heartbeat-stale",
        lastHeartbeatAt: new Date(lastAliveMs).toISOString(),
      },
    };
  }

  return {
    ...base,
    state: "running",
  };
}

function normalizeQueueState(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

function normalizeAgentState(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
}

function firstNodeWithStatus(nodes, status) {
  return (
    nodes.find((node) => normalizeAgentState(node.status) === status) ?? null
  );
}
