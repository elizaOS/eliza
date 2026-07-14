export async function renderMergeStewardMetrics({
  config = {},
  steward,
  readiness,
  now = new Date().toISOString(),
} = {}) {
  const metrics = new MetricsWriter();
  const scrapeErrors = [];
  const storeBackend = queueStoreBackend(config);

  metrics.add(
    "eliza_merge_steward_info",
    "Static service information.",
    "gauge",
    1,
    {
      service: "eliza-merge-steward",
      deployment_mode: config.deployment?.mode ?? "local",
      store: storeBackend,
    },
  );

  if (readiness) {
    metrics.add(
      "eliza_merge_steward_ready",
      "Readiness status.",
      "gauge",
      readiness.ok ? 1 : 0,
    );
    for (const check of readiness.checks ?? []) {
      metrics.add(
        "eliza_merge_steward_check_ok",
        "Readiness check status by check name.",
        "gauge",
        check.ok ? 1 : 0,
        { name: check.name ?? "unknown" },
      );
    }
  }

  metrics.add(
    "eliza_merge_steward_worker_enabled",
    "Merge worker enabled flag.",
    "gauge",
    config.worker?.enabled === true ? 1 : 0,
  );
  metrics.add(
    "eliza_merge_steward_worker_lease_enabled",
    "Merge worker durable lease enabled flag.",
    "gauge",
    config.worker?.leaseEnabled === true ? 1 : 0,
  );
  metrics.add(
    "eliza_merge_steward_integration_live_enabled",
    "Live integration execution enabled flag.",
    "gauge",
    config.integration?.enabled === true && config.integration?.dryRun === false
      ? 1
      : 0,
  );
  metrics.add(
    "eliza_merge_steward_work_reservation_required",
    "Strict agent work reservation policy enabled flag.",
    "gauge",
    config.policy?.requireWorkReservationForAgentPrs === true ? 1 : 0,
  );
  metrics.add(
    "eliza_merge_steward_work_item_required",
    "Strict durable agent Work item policy enabled flag.",
    "gauge",
    config.policy?.requireWorkItemForAgentPrs === true ? 1 : 0,
  );
  metrics.add(
    "eliza_merge_steward_agent_branch_namespace_required",
    "Strict agent source branch namespace policy enabled flag.",
    "gauge",
    config.policy?.requireAgentBranchNamespaceForAgentPrs === true ? 1 : 0,
  );
  metrics.add(
    "eliza_merge_steward_verified_agent_run_receipt_required",
    "Strict signed agent run receipt policy enabled flag.",
    "gauge",
    config.policy?.requireVerifiedAgentRunReceiptForAgentPrs === true ? 1 : 0,
  );
  metrics.add(
    "eliza_merge_steward_agent_identity_registry_required",
    "Strict allowed agent identity registry policy enabled flag.",
    "gauge",
    config.policy?.requireAgentIdentityRegistryForAgentPrs === true ? 1 : 0,
  );
  metrics.add(
    "eliza_merge_steward_known_agent_id_count",
    "Effective allowed agent identity count.",
    "gauge",
    readiness?.configuration?.knownAgentIdCount ??
      config.policy?.knownAgentIds?.length ??
      0,
  );

  const queue = await safeCollect("queue", scrapeErrors, () =>
    steward.listQueue(),
  );
  if (queue) {
    const items = queue.items ?? [];
    metrics.add(
      "eliza_merge_steward_queue_items",
      "Queue item count by state.",
      "gauge",
      items.length,
      { state: "all" },
    );
    for (const [state, count] of countBy(
      items,
      (item) => item.queueState ?? "unknown",
    )) {
      metrics.add(
        "eliza_merge_steward_queue_items",
        "Queue item count by state.",
        "gauge",
        count,
        { state },
      );
    }
    metrics.add(
      "eliza_merge_steward_queue_scheduled_items",
      "Scheduled queue item count.",
      "gauge",
      queue.scheduled?.length ?? 0,
    );
    metrics.add(
      "eliza_merge_steward_queue_running_items",
      "Running queue item count.",
      "gauge",
      queue.running?.length ?? 0,
    );
  }

  const runs = await safeCollect(
    "runs",
    scrapeErrors,
    () => steward.listRuns?.() ?? [],
  );
  if (runs) {
    metrics.add(
      "eliza_merge_steward_runs",
      "Steward run count by status.",
      "gauge",
      runs.length,
      { status: "all" },
    );
    for (const [status, count] of countBy(
      runs,
      (run) => run.status ?? "unknown",
    )) {
      metrics.add(
        "eliza_merge_steward_runs",
        "Steward run count by status.",
        "gauge",
        count,
        { status },
      );
    }
  }

  const attempts = await safeCollect(
    "attempts",
    scrapeErrors,
    () => steward.listAttempts?.() ?? [],
  );
  if (attempts) {
    metrics.add(
      "eliza_merge_steward_attempts",
      "Steward attempt count by status.",
      "gauge",
      attempts.length,
      { status: "all" },
    );
    for (const [status, count] of countBy(
      attempts,
      (attempt) => attempt.status ?? "unknown",
    )) {
      metrics.add(
        "eliza_merge_steward_attempts",
        "Steward attempt count by status.",
        "gauge",
        count,
        { status },
      );
    }
  }

  const claims = await safeCollect(
    "agent_claims",
    scrapeErrors,
    () => steward.listAgentClaims?.() ?? [],
  );
  if (claims) {
    metrics.add(
      "eliza_merge_steward_agent_claims",
      "Agent work claim count by status.",
      "gauge",
      claims.length,
      { status: "all" },
    );
    for (const [status, count] of countBy(
      claims,
      (claim) => claim.status ?? "unknown",
    )) {
      metrics.add(
        "eliza_merge_steward_agent_claims",
        "Agent work claim count by status.",
        "gauge",
        count,
        { status },
      );
    }
    metrics.add(
      "eliza_merge_steward_agent_claims_expired_active",
      "Active agent work claims whose lease expiry is in the past.",
      "gauge",
      claims.filter(
        (claim) => claim.status === "active" && isExpired(claim.expiresAt, now),
      ).length,
    );
  }

  const policies = await safeCollect(
    "repo_policies",
    scrapeErrors,
    () => steward.listRepoPolicies?.() ?? [],
  );
  if (policies) {
    metrics.add(
      "eliza_merge_steward_repo_policies",
      "Repository policy count.",
      "gauge",
      policies.length,
    );
  }

  const performance = await safeCollect(
    "agent_performance",
    scrapeErrors,
    () => steward.getAgentPerformance?.({ now }) ?? null,
  );
  if (performance) {
    metrics.add(
      "eliza_merge_steward_agent_performance_agents",
      "Agent performance agent count by health.",
      "gauge",
      performance.counts?.agents ?? 0,
      { health: "all" },
    );
    for (const [health, count] of countBy(
      performance.agents ?? [],
      (agent) => agent.health ?? "unknown",
    )) {
      metrics.add(
        "eliza_merge_steward_agent_performance_agents",
        "Agent performance agent count by health.",
        "gauge",
        count,
        { health },
      );
    }
    metrics.add(
      "eliza_merge_steward_agent_performance_failed_runs",
      "Recent failed agent run count.",
      "gauge",
      performance.counts?.failedRuns ?? 0,
    );
    metrics.add(
      "eliza_merge_steward_agent_performance_stale_claims",
      "Stale agent claim count.",
      "gauge",
      performance.counts?.staleClaims ?? 0,
    );
    metrics.add(
      "eliza_merge_steward_agent_performance_handoffs",
      "Recent agent handoff count.",
      "gauge",
      performance.counts?.handoffs ?? 0,
    );
    metrics.add(
      "eliza_merge_steward_agent_performance_active_runs",
      "Active agent run count.",
      "gauge",
      performance.counts?.activeRuns ?? 0,
    );
    metrics.add(
      "eliza_merge_steward_agent_performance_waiting_runs",
      "Waiting agent run count.",
      "gauge",
      performance.counts?.waitingRuns ?? 0,
    );
  }

  const routing = await safeCollect(
    "agent_routing",
    scrapeErrors,
    () => steward.getAgentRouting?.({ now }) ?? null,
  );
  if (routing) {
    metrics.add(
      "eliza_merge_steward_agent_routing_recommendations",
      "Agent routing recommendation count.",
      "gauge",
      routing.counts?.recommendations ?? 0,
    );
    metrics.add(
      "eliza_merge_steward_agent_routing_unassigned_items",
      "Agent routing unassigned item count.",
      "gauge",
      routing.counts?.unassignedItems ?? 0,
    );
    metrics.add(
      "eliza_merge_steward_agent_routing_agents",
      "Agent routing agent count by state.",
      "gauge",
      routing.counts?.routableAgents ?? 0,
      { state: "routable" },
    );
    metrics.add(
      "eliza_merge_steward_agent_routing_agents",
      "Agent routing agent count by state.",
      "gauge",
      routing.counts?.blockedAgents ?? 0,
      { state: "blocked" },
    );
    for (const [reason, count] of countBy(
      routing.blockedAgents?.flatMap((agent) => agent.reasons ?? []) ?? [],
      (reason) => reason,
    )) {
      metrics.add(
        "eliza_merge_steward_agent_routing_blocked_agents",
        "Agent routing blocked agent count by reason.",
        "gauge",
        count,
        { reason },
      );
    }
  }

  const leases = await safeCollect(
    "worker_leases",
    scrapeErrors,
    () => steward.store?.listWorkerLeases?.() ?? [],
  );
  if (leases) {
    metrics.add(
      "eliza_merge_steward_worker_leases",
      "Worker lease count by status.",
      "gauge",
      leases.length,
      { status: "all" },
    );
    for (const [status, count] of countBy(
      leases,
      (lease) => lease.status ?? "unknown",
    )) {
      metrics.add(
        "eliza_merge_steward_worker_leases",
        "Worker lease count by status.",
        "gauge",
        count,
        { status },
      );
    }
    for (const lease of leases) {
      const labels = {
        lease_id: lease.id ?? "unknown",
        owner_id: lease.ownerId ?? "",
        status: lease.status ?? "unknown",
      };
      metrics.add(
        "eliza_merge_steward_worker_lease_active",
        "Worker lease active ownership by lease id.",
        "gauge",
        lease.status === "active" && !isExpired(lease.expiresAt, now) ? 1 : 0,
        labels,
      );
      const expiresAt = epochSeconds(lease.expiresAt);
      if (expiresAt != null) {
        metrics.add(
          "eliza_merge_steward_worker_lease_expires_at_seconds",
          "Worker lease expiry Unix timestamp.",
          "gauge",
          expiresAt,
          labels,
        );
      }
    }
  }

  for (const error of scrapeErrors) {
    metrics.add(
      "eliza_merge_steward_scrape_errors",
      "Metric scrape collection errors by source.",
      "gauge",
      1,
      { source: error.source },
    );
  }
  if (!scrapeErrors.length) {
    metrics.add(
      "eliza_merge_steward_scrape_errors",
      "Metric scrape collection errors by source.",
      "gauge",
      0,
      { source: "none" },
    );
  }

  return metrics.render();
}

class MetricsWriter {
  #metadata = new Map();
  #samples = [];

  add(name, help, type, value, labels = {}) {
    if (!this.#metadata.has(name)) {
      this.#metadata.set(name, { help, type });
    }
    this.#samples.push({ name, value: numericValue(value), labels });
  }

  render() {
    const lines = [];
    for (const [name, metadata] of this.#metadata.entries()) {
      lines.push(`# HELP ${name} ${escapeHelp(metadata.help)}`);
      lines.push(`# TYPE ${name} ${metadata.type}`);
      for (const sample of this.#samples.filter(
        (candidate) => candidate.name === name,
      )) {
        lines.push(`${name}${formatLabels(sample.labels)} ${sample.value}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }
}

async function safeCollect(source, errors, collect) {
  try {
    return await collect();
  } catch (error) {
    // error-policy:J7 metrics collection must not kill the endpoint; the
    // failure is surfaced in the response's errors array
    errors.push({
      source,
      message:
        error instanceof Error
          ? error.message
          : String(error ?? "collection_failed"),
    });
    return null;
  }
}

function countBy(items, keyFor) {
  const counts = new Map();
  for (const item of items ?? []) {
    const key = String(keyFor(item) ?? "unknown");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function formatLabels(labels = {}) {
  const entries = Object.entries(labels).filter(
    ([, value]) => value !== undefined && value !== null,
  );
  if (!entries.length) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
}

function escapeLabel(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
}

function escapeHelp(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "0";
}

function epochSeconds(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}

function isExpired(expiresAt, now) {
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) return false;
  return expiresAtMs <= nowMs;
}

function queueStoreBackend(config = {}) {
  if (config.databaseUrl) return "postgres";
  if (config.queueStorePath) return "json";
  return "memory";
}
