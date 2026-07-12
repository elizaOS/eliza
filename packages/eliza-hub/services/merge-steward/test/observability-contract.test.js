import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.js";
import { renderMergeStewardMetrics } from "../src/metrics.js";
import { MergeSteward } from "../src/steward.js";
import { InMemoryQueueStore } from "../src/store.js";

const ALERT_RULES_PATH = new URL(
  "../../../deployment/hetzner-staging/observability/merge-steward-alerts.yml",
  import.meta.url,
);
const PROMETHEUS_CONFIG_PATH = new URL(
  "../../../deployment/hetzner-staging/observability/prometheus.yml",
  import.meta.url,
);

describe("observability contract", () => {
  it("keeps alert rules aligned with exported Merge Steward metrics", async () => {
    const [rules, exportedMetrics] = await Promise.all([
      readFile(ALERT_RULES_PATH, "utf8"),
      renderRepresentativeMetrics(),
    ]);

    const exportedNames = new Set(extractMetricNames(exportedMetrics));
    const referencedNames = extractMetricNames(rules).filter((name) =>
      name.startsWith("eliza_merge_steward_"),
    );

    assert.ok(
      referencedNames.length > 0,
      "expected alert rules to reference Merge Steward metrics",
    );
    for (const name of referencedNames) {
      assert.ok(
        exportedNames.has(name),
        `alert references non-exported metric ${name}`,
      );
    }
  });

  it("keeps Prometheus scrape config private and authenticated", async () => {
    const config = await readFile(PROMETHEUS_CONFIG_PATH, "utf8");

    assert.match(config, /job_name:\s+eliza-merge-steward/);
    assert.match(config, /metrics_path:\s+\/metrics/);
    assert.match(
      config,
      /credentials_file:\s+\/etc\/prometheus\/secrets\/merge-steward-token/,
    );
    assert.match(config, /merge-steward-alerts\.yml/);
    assert.doesNotMatch(config, /credentials:\s*[A-Za-z0-9_-]+/);
  });

  it("keeps alert runbook links staging-owned and free of personal GitHub URLs", async () => {
    const rules = await readFile(ALERT_RULES_PATH, "utf8");
    const urls = [...rules.matchAll(/runbook_url:\s*(\S+)/g)].map(
      (match) => match[1],
    );

    assert.ok(
      urls.length > 0,
      "expected alert rules to include runbook_url annotations",
    );
    assert.ok(
      urls.every(
        (url) =>
          url ===
          "https://git.staging.example.invalid/eliza-hub/runbooks/observability",
      ),
    );
    assert.doesNotMatch(rules, /github\.com/);
  });
});

async function renderRepresentativeMetrics() {
  const config = loadConfig({
    MERGE_STEWARD_DEPLOYMENT_MODE: "production",
    DATABASE_URL: "postgres://forgejo:secret@postgres:5432/forgejo",
    MERGE_STEWARD_WORKER_ENABLED: "true",
    MERGE_STEWARD_WORKER_LEASE_ENABLED: "true",
    MERGE_STEWARD_INTEGRATION_ENABLED: "true",
    MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
    MERGE_STEWARD_API_AUTH_REQUIRED: "true",
    MERGE_STEWARD_API_TOKEN: "secret",
    FORGEJO_WEBHOOK_SECRET: "secret",
    MERGE_STEWARD_WEBHOOK_REQUIRE_DELIVERY_ID: "true",
    MERGE_STEWARD_EVENT_GATE_ENABLED: "true",
    MERGE_STEWARD_EVENT_GATE_REPOSITORIES: "elizaos/eliza",
    MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
    MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
    MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
  });
  const store = new InMemoryQueueStore();
  await store.upsertQueueItem({
    repo: "elizaos/eliza",
    pullRequestId: 12,
    queueState: "ready",
    targetBranch: "develop",
    ownerAgentId: "agent-one",
  });
  await store.upsertQueueItem({
    repo: "elizaos/eliza",
    pullRequestId: 13,
    queueState: "ready",
    targetBranch: "develop",
    priority: 10,
  });
  await store.upsertRun({
    id: "run:elizaos/eliza#12",
    status: "failed",
    queueItemId: "elizaos/eliza#12",
    repo: "elizaos/eliza",
    ownerKind: "agent",
    ownerId: "agent-one",
  });
  await store.startAttempt({
    runId: "run:elizaos/eliza#12",
    nodeId: "integration",
    ownerId: "worker-a",
  });
  await store.failAttempt("attempt:run:elizaos/eliza#12:integration", {
    error: "integration failed",
  });
  await store.claimAgentWork(
    {
      repo: "elizaos/eliza",
      resourceKind: "path",
      resourceId: "src/index.ts",
      ownerAgentId: "agent-one",
    },
    {
      now: "2026-07-06T00:00:00.000Z",
      ttlMs: 1000,
    },
  );
  await store.claimWorkerLease(
    {
      id: "merge-queue",
      ownerId: "worker-a",
    },
    {
      now: "2026-07-06T00:00:00.000Z",
      ttlMs: 30000,
    },
  );

  return renderMergeStewardMetrics({
    config,
    steward: new MergeSteward({ config, store }),
    readiness: {
      ok: false,
      checks: [
        { name: "runtime_preflight", ok: true },
        { name: "worker_lease", ok: false },
      ],
    },
    now: "2026-07-06T00:00:10.000Z",
  });
}

function extractMetricNames(text) {
  return [...text.matchAll(/\b(?:eliza_merge_steward_[a-z_]+|up)\b/g)].map(
    (match) => match[0],
  );
}
