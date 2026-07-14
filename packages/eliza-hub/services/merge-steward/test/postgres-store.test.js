import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.js";
import { PostgresQueueStore } from "../src/postgres-store.js";
import { createQueueStore } from "../src/server.js";

describe("Postgres queue store", () => {
  it("hydrates queue rows from indexed columns and payload JSON", async () => {
    const store = new PostgresQueueStore({
      pool: {
        async query(sql) {
          assert.match(sql, /FROM steward_queue_items/);
          return {
            rows: [
              {
                id: "elizaos/eliza#12",
                repo: "elizaos/eliza",
                pull_request_id: 12,
                source_branch: "agent/fix",
                target_branch: "develop",
                head_sha: "abc123",
                queue_state: "observed",
                priority: 2,
                risk_score: 5,
                conflict_score: 1,
                author_kind: "agent",
                owner_agent_id: "agent-one",
                task_id: "task-one",
                labels: ["agent:codex"],
                changed_files: ["README.md"],
                affected_paths: [],
                affected_packages: ["docs"],
                required_checks: ["smoke"],
                check_results: { smoke: "success" },
                policy_snapshot: {},
                claim_owner_id: null,
                claimed_at: null,
                attempt_count: 0,
                available_at: null,
                finished_at: null,
                last_error: null,
                payload_json: {
                  changedLines: 10,
                  agentRun: { id: "run-one", state: "succeeded" },
                },
                created_at: new Date("2026-07-06T00:00:00.000Z"),
                updated_at: new Date("2026-07-06T00:01:00.000Z"),
              },
            ],
          };
        },
      },
    });

    const [item] = await store.listQueueItems();

    assert.equal(item.id, "elizaos/eliza#12");
    assert.equal(item.pullRequestId, 12);
    assert.deepEqual(item.changedFiles, ["README.md"]);
    assert.deepEqual(item.requiredChecks, ["smoke"]);
    assert.equal(item.agentRun.state, "succeeded");
    assert.equal(item.createdAt, "2026-07-06T00:00:00.000Z");
  });

  it("preserves scalar human responses", async () => {
    const store = new PostgresQueueStore({
      pool: {
        async query(sql, values) {
          assert.match(sql, /FROM steward_human_requests/);
          assert.deepEqual(values, ["human:run-one:plan_review:0"]);
          return {
            rows: [
              {
                id: "human:run-one:plan_review:0",
                run_id: "run-one",
                node_id: "plan_review",
                iteration: 0,
                kind: "select",
                status: "answered",
                prompt: "Merge or hold?",
                options_json: ["merge", "hold"],
                response_json: "merge",
                requested_by: "steward",
                responded_by: "operator-one",
                requested_at: "2026-07-06T00:00:00.000Z",
                responded_at: "2026-07-06T00:01:00.000Z",
                payload_json: {},
                created_at: "2026-07-06T00:00:00.000Z",
                updated_at: "2026-07-06T00:01:00.000Z",
              },
            ],
          };
        },
      },
    });

    const request = await store.getHumanRequest("human:run-one:plan_review:0");

    assert.equal(request.response, "merge");
    assert.deepEqual(request.options, ["merge", "hold"]);
  });

  it("hydrates work items from Postgres rows", async () => {
    const store = new PostgresQueueStore({
      pool: {
        async query(sql, values) {
          assert.match(sql, /FROM steward_work_items/);
          assert.deepEqual(values, ["elizaos/eliza", "blocked"]);
          return {
            rows: [
              {
                id: "work:elizaos/eliza:task:docs-intake",
                repo: "elizaos/eliza",
                kind: "task",
                state: "blocked",
                title: "Document agent intake",
                summary: "Waiting on docs review",
                priority: 4,
                owner_agent_id: "agent-docs",
                task_id: "docs-intake",
                issue_id: null,
                pull_request_id: null,
                cycle_id: "cycle:elizaos/eliza:july",
                module_id: "module:elizaos/eliza:docs",
                source_url: null,
                target_branch: "develop",
                paths_json: ["docs/steward-runtime-model.md"],
                packages_json: ["docs"],
                labels_json: ["docs", "blocked"],
                metadata_json: { reason: "review" },
                created_by: "agent-docs",
                updated_by: "agent-docs",
                claimed_at: null,
                completed_at: null,
                payload_json: {},
                created_at: "2026-07-07T00:00:00.000Z",
                updated_at: "2026-07-07T00:01:00.000Z",
              },
            ],
          };
        },
      },
    });

    const workItems = await store.listWorkItems({
      repo: "elizaos/eliza",
      state: "blocked",
    });

    assert.equal(workItems.length, 1);
    assert.equal(workItems[0].id, "work:elizaos/eliza:task:docs-intake");
    assert.equal(workItems[0].ownerAgentId, "agent-docs");
    assert.equal(workItems[0].cycleId, "cycle:elizaos/eliza:july");
    assert.equal(workItems[0].moduleId, "module:elizaos/eliza:docs");
    assert.deepEqual(workItems[0].packages, ["docs"]);
    assert.equal(workItems[0].metadata.reason, "review");
  });

  it("hydrates work cycles and modules from Postgres rows", async () => {
    const store = new PostgresQueueStore({
      pool: {
        async query(sql, values) {
          if (sql.includes("FROM steward_work_cycles")) {
            assert.deepEqual(values, ["elizaos/eliza", "active"]);
            return {
              rows: [
                {
                  id: "cycle:elizaos/eliza:july",
                  repo: "elizaos/eliza",
                  state: "active",
                  title: "July",
                  summary: "July agent work",
                  owner_agent_id: "agent-lead",
                  start_at: "2026-07-01T00:00:00.000Z",
                  end_at: "2026-07-31T00:00:00.000Z",
                  metadata_json: { focus: "hardening" },
                  created_by: "agent-lead",
                  updated_by: "agent-lead",
                  payload_json: {},
                  created_at: "2026-07-07T00:00:00.000Z",
                  updated_at: "2026-07-07T00:01:00.000Z",
                },
              ],
            };
          }

          assert.match(sql, /FROM steward_work_modules/);
          assert.deepEqual(values, ["elizaos/eliza", "agent-runtime"]);
          return {
            rows: [
              {
                id: "module:elizaos/eliza:runtime",
                repo: "elizaos/eliza",
                state: "active",
                title: "Runtime",
                summary: "Runtime ownership",
                owner_agent_id: "agent-runtime",
                paths_json: ["packages/core"],
                packages_json: ["core"],
                labels_json: ["runtime"],
                metadata_json: { area: "core" },
                created_by: "agent-runtime",
                updated_by: "agent-runtime",
                payload_json: {},
                created_at: "2026-07-07T00:00:00.000Z",
                updated_at: "2026-07-07T00:01:00.000Z",
              },
            ],
          };
        },
      },
    });

    const cycles = await store.listWorkCycles({
      repo: "elizaos/eliza",
      state: "active",
    });
    const modules = await store.listWorkModules({
      repo: "elizaos/eliza",
      ownerAgentId: "agent-runtime",
    });

    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].id, "cycle:elizaos/eliza:july");
    assert.equal(cycles[0].metadata.focus, "hardening");
    assert.equal(modules.length, 1);
    assert.equal(modules[0].id, "module:elizaos/eliza:runtime");
    assert.deepEqual(modules[0].packages, ["core"]);
  });

  it("hydrates work views from Postgres rows", async () => {
    const store = new PostgresQueueStore({
      pool: {
        async query(sql, values) {
          assert.match(sql, /FROM steward_work_views/);
          assert.deepEqual(values, ["elizaos/eliza", "dashboard"]);
          return {
            rows: [
              {
                id: "view:elizaos/eliza:blocked-docs",
                repo: "elizaos/eliza",
                kind: "dashboard",
                state: "active",
                title: "Blocked docs",
                summary: "Docs blockers",
                owner_agent_id: "agent-docs",
                query_text: "docs blocked",
                filters_json: { state: ["blocked"], packages: ["docs"] },
                layout_json: { groupBy: "state" },
                columns_json: ["blocked", "ready"],
                visibility: "private",
                metadata_json: { source: "test" },
                created_by: "agent-docs",
                updated_by: "agent-docs",
                payload_json: {},
                created_at: "2026-07-07T00:00:00.000Z",
                updated_at: "2026-07-07T00:01:00.000Z",
              },
            ],
          };
        },
      },
    });

    const views = await store.listWorkViews({
      repo: "elizaos/eliza",
      kind: "dashboard",
    });

    assert.equal(views.length, 1);
    assert.equal(views[0].id, "view:elizaos/eliza:blocked-docs");
    assert.deepEqual(views[0].filters.state, ["blocked"]);
    assert.deepEqual(views[0].columns, ["blocked", "ready"]);
  });

  it("hydrates work pages from Postgres rows", async () => {
    const store = new PostgresQueueStore({
      pool: {
        async query(sql, values) {
          assert.match(sql, /FROM steward_work_pages/);
          assert.deepEqual(values, [
            "elizaos/eliza",
            "agent_plan",
            "work:elizaos/eliza:task:docs-intake",
          ]);
          return {
            rows: [
              {
                id: "page:elizaos/eliza:work:work-elizaos-eliza-task-docs-intake:agent_plan",
                repo: "elizaos/eliza",
                kind: "agent_plan",
                state: "active",
                title: "Docs intake plan",
                summary: "Plan for docs intake",
                body_text: "## Plan\n\n- Update docs.",
                body_format: "markdown",
                owner_agent_id: "agent-docs",
                work_item_id: "work:elizaos/eliza:task:docs-intake",
                cycle_id: "cycle:elizaos/eliza:july",
                module_id: "module:elizaos/eliza:docs",
                task_id: "docs-intake",
                issue_id: null,
                pull_request_id: null,
                source_url: null,
                tags_json: ["docs", "plan"],
                visibility: "private",
                metadata_json: { source: "test" },
                created_by: "agent-docs",
                updated_by: "agent-docs",
                payload_json: {},
                created_at: "2026-07-07T00:00:00.000Z",
                updated_at: "2026-07-07T00:01:00.000Z",
              },
            ],
          };
        },
      },
    });

    const pages = await store.listWorkPages({
      repo: "elizaos/eliza",
      kind: "agent_plan",
      workItemId: "work:elizaos/eliza:task:docs-intake",
    });

    assert.equal(pages.length, 1);
    assert.equal(
      pages[0].id,
      "page:elizaos/eliza:work:work-elizaos-eliza-task-docs-intake:agent_plan",
    );
    assert.equal(pages[0].body, "## Plan\n\n- Update docs.");
    assert.deepEqual(pages[0].tags, ["docs", "plan"]);
    assert.equal(pages[0].workItemId, "work:elizaos/eliza:task:docs-intake");
  });

  it("hydrates agent claims from Postgres rows", async () => {
    const store = new PostgresQueueStore({
      pool: {
        async query(sql, values) {
          assert.match(sql, /FROM steward_agent_claims/);
          assert.deepEqual(values, ["agent-one"]);
          return {
            rows: [
              {
                id: "claim:elizaos/eliza:path:src/core.ts",
                repo: "elizaos/eliza",
                resource_kind: "path",
                resource_id: "src/core.ts",
                owner_agent_id: "agent-one",
                task_id: "task-one",
                run_id: "run-one",
                branch: "agent/agent-one/task-one",
                paths_json: ["src/core.ts"],
                status: "active",
                claimed_at: "2026-07-06T00:00:00.000Z",
                renewed_at: "2026-07-06T00:05:00.000Z",
                expires_at: "2026-07-06T00:35:00.000Z",
                released_at: null,
                release_reason: null,
                metadata_json: { reason: "editing" },
                payload_json: {},
                created_at: "2026-07-06T00:00:00.000Z",
                updated_at: "2026-07-06T00:05:00.000Z",
              },
            ],
          };
        },
      },
    });

    const claims = await store.listAgentClaims({ ownerAgentId: "agent-one" });

    assert.equal(claims.length, 1);
    assert.equal(claims[0].resourceKind, "path");
    assert.equal(claims[0].ownerAgentId, "agent-one");
    assert.deepEqual(claims[0].paths, ["src/core.ts"]);
    assert.equal(claims[0].metadata.reason, "editing");
  });

  it("hydrates repository policies from Postgres rows", async () => {
    const store = new PostgresQueueStore({
      pool: {
        async query(sql) {
          assert.match(sql, /FROM steward_repo_policies/);
          return {
            rows: [
              {
                repo: "elizaos/eliza",
                queue_mode: "serialized",
                protected_branches: ["main", "develop"],
                required_checks: ["test", "lint"],
                trusted_actors: ["operator-one", "agent-one"],
                allow_forks: false,
                policy_json: { maxBatchSize: 1 },
                created_at: "2026-07-06T00:00:00.000Z",
                updated_at: "2026-07-06T00:01:00.000Z",
              },
            ],
          };
        },
      },
    });

    const policies = await store.listRepoPolicies();

    assert.equal(policies.length, 1);
    assert.equal(policies[0].repo, "elizaos/eliza");
    assert.equal(policies[0].queueMode, "serialized");
    assert.deepEqual(policies[0].protectedBranches, ["main", "develop"]);
    assert.deepEqual(policies[0].requiredChecks, ["test", "lint"]);
    assert.equal(policies[0].policy.maxBatchSize, 1);
  });

  it("hydrates registered agent identities from Postgres rows", async () => {
    const store = new PostgresQueueStore({
      pool: {
        async query(sql, values) {
          assert.match(sql, /FROM steward_registered_agents/);
          assert.deepEqual(values, ["active"]);
          return {
            rows: [
              {
                id: "agent-docs",
                status: "active",
                display_name: "Docs Agent",
                forgejo_username: "eliza-agent-docs",
                eliza_cloud_subject: "agent-subject-one",
                tenant_id: "tenant-one",
                source: "eliza-cloud",
                registered_by: "admin-one",
                registered_at: "2026-07-07T00:00:00.000Z",
                disabled_by: null,
                disabled_at: null,
                disable_reason: null,
                metadata_json: { model: "codex" },
                payload_json: {},
                created_at: "2026-07-07T00:00:00.000Z",
                updated_at: "2026-07-07T00:01:00.000Z",
              },
            ],
          };
        },
      },
    });

    const agents = await store.listRegisteredAgents({ status: "active" });

    assert.equal(agents.length, 1);
    assert.equal(agents[0].id, "agent-docs");
    assert.equal(agents[0].forgejoUsername, "eliza-agent-docs");
    assert.equal(agents[0].elizaCloudSubject, "agent-subject-one");
    assert.equal(agents[0].tenantId, "tenant-one");
    assert.equal(agents[0].metadata.model, "codex");
  });

  it("upserts registered agent identities into Postgres", async () => {
    const queries = [];
    const store = new PostgresQueueStore({
      pool: {
        async query(sql, values) {
          queries.push({ sql, values });
          if (
            /SELECT \* FROM steward_registered_agents WHERE id = \$1/.test(sql)
          ) {
            assert.deepEqual(values, ["agent-docs"]);
            return { rows: [] };
          }
          if (/INSERT INTO steward_registered_agents/.test(sql)) {
            assert.equal(values[0], "agent-docs");
            assert.equal(values[1], "active");
            assert.equal(values[2], "Docs Agent");
            assert.equal(values[7], "admin-one");
            return {
              rows: [
                {
                  id: values[0],
                  status: values[1],
                  display_name: values[2],
                  forgejo_username: values[3],
                  eliza_cloud_subject: values[4],
                  tenant_id: values[5],
                  source: values[6],
                  registered_by: values[7],
                  registered_at: values[8],
                  disabled_by: values[9],
                  disabled_at: values[10],
                  disable_reason: values[11],
                  metadata_json: JSON.parse(values[12]),
                  payload_json: JSON.parse(values[13]),
                  created_at: values[14],
                  updated_at: values[15],
                },
              ],
            };
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      },
    });

    const agent = await store.upsertRegisteredAgent(
      {
        id: "agent-docs",
        displayName: "Docs Agent",
        source: "eliza-cloud",
        metadata: { lane: "docs" },
      },
      {
        registeredBy: "admin-one",
        now: "2026-07-07T00:00:00.000Z",
      },
    );

    assert.equal(agent.id, "agent-docs");
    assert.equal(agent.displayName, "Docs Agent");
    assert.equal(agent.source, "eliza-cloud");
    assert.equal(agent.registeredBy, "admin-one");
    assert.equal(agent.metadata.lane, "docs");
    assert.equal(queries.length, 2);
  });

  it("claims worker leases in Postgres", async () => {
    const queries = [];
    const store = new PostgresQueueStore({
      pool: {
        async query(sql, values) {
          queries.push({ sql, values });
          if (
            /SELECT \* FROM steward_worker_leases WHERE id = \$1 FOR UPDATE/.test(
              sql,
            )
          ) {
            assert.deepEqual(values, ["merge-queue"]);
            return { rows: [] };
          }
          if (/INSERT INTO steward_worker_leases/.test(sql)) {
            assert.equal(values[0], "merge-queue");
            assert.equal(values[1], "worker-a");
            assert.equal(values[2], "active");
            return {
              rows: [
                {
                  id: values[0],
                  owner_id: values[1],
                  status: values[2],
                  acquired_at: values[3],
                  renewed_at: values[4],
                  expires_at: values[5],
                  released_at: null,
                  release_reason: null,
                  metadata_json: JSON.parse(values[8]),
                  payload_json: JSON.parse(values[9]),
                  created_at: values[10],
                  updated_at: values[11],
                },
              ],
            };
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      },
    });

    const result = await store.claimWorkerLease(
      { id: "merge-queue", ownerId: "worker-a" },
      { now: "2026-07-06T00:00:00.000Z", ttlMs: 30000 },
    );

    assert.equal(result.claimed, true);
    assert.equal(result.lease.ownerId, "worker-a");
    assert.equal(result.lease.expiresAt, "2026-07-06T00:00:30.000Z");
    assert.equal(queries.length, 2);
  });

  it("claims same-lane Postgres queue item batches atomically", async () => {
    const now = "2026-07-06T00:00:00.000Z";
    const rows = new Map([
      ["elizaos/eliza#21", queueRow({ pullRequestId: 21 })],
      ["elizaos/eliza#22", queueRow({ pullRequestId: 22 })],
    ]);
    const queries = [];
    const store = new PostgresQueueStore({
      pool: {
        async query(sql, values) {
          queries.push({ sql, values });
          if (/pg_advisory_xact_lock/.test(sql)) {
            assert.deepEqual(values, ["elizaos/eliza", "develop"]);
            return { rows: [] };
          }
          if (
            /SELECT \* FROM steward_queue_items WHERE id = \$1 FOR UPDATE SKIP LOCKED/.test(
              sql,
            )
          ) {
            return { rows: [rows.get(values[0])] };
          }
          if (/SELECT \* FROM steward_queue_items WHERE id = \$1/.test(sql)) {
            return { rows: [rows.get(values[0])] };
          }
          if (/SELECT 1[\s\S]*FROM steward_queue_items/.test(sql)) {
            assert.deepEqual(values, [
              "elizaos/eliza",
              "develop",
              ["elizaos/eliza#21", "elizaos/eliza#22"],
            ]);
            return { rows: [] };
          }
          if (
            /UPDATE steward_queue_items[\s\S]*SET queue_state = 'running'/.test(
              sql,
            )
          ) {
            const existing = rows.get(values[0]);
            const payload = JSON.parse(values[3]);
            return {
              rows: [
                {
                  ...existing,
                  queue_state: "running",
                  claim_owner_id: values[1],
                  claimed_at: values[2],
                  attempt_count: existing.attempt_count + 1,
                  last_error: null,
                  payload_json: payload,
                  updated_at: values[2],
                },
              ],
            };
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      },
    });

    const result = await store.claimQueueItems(
      [
        { repo: "elizaos/eliza", pullRequestId: 21, targetBranch: "develop" },
        { repo: "elizaos/eliza", pullRequestId: 22, targetBranch: "develop" },
      ],
      { workerId: "worker-train", now },
    );

    assert.equal(result.claimed, true);
    assert.deepEqual(
      result.items.map((item) => item.id),
      ["elizaos/eliza#21", "elizaos/eliza#22"],
    );
    assert.deepEqual(
      result.items.map((item) => item.queueState),
      ["running", "running"],
    );
    assert.deepEqual(
      result.items.map((item) => item.claimedBy),
      ["worker-train", "worker-train"],
    );
    assert.equal(
      queries.filter((query) => /pg_advisory_xact_lock/.test(query.sql)).length,
      1,
    );
    assert.equal(
      queries.filter((query) => /UPDATE steward_queue_items/.test(query.sql))
        .length,
      2,
    );
  });

  it("does not partially claim Postgres queue item batches across lanes", async () => {
    const rows = new Map([
      [
        "elizaos/eliza#31",
        queueRow({ pullRequestId: 31, targetBranch: "develop" }),
      ],
      [
        "elizaos/eliza#32",
        queueRow({ pullRequestId: 32, targetBranch: "main" }),
      ],
    ]);
    const queries = [];
    const store = new PostgresQueueStore({
      pool: {
        async query(sql, values) {
          queries.push({ sql, values });
          if (
            /SELECT \* FROM steward_queue_items WHERE id = \$1 FOR UPDATE SKIP LOCKED/.test(
              sql,
            )
          ) {
            return { rows: [rows.get(values[0])] };
          }
          if (/SELECT \* FROM steward_queue_items WHERE id = \$1/.test(sql)) {
            return { rows: [rows.get(values[0])] };
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      },
    });

    const result = await store.claimQueueItems([
      { repo: "elizaos/eliza", pullRequestId: 31, targetBranch: "develop" },
      { repo: "elizaos/eliza", pullRequestId: 32, targetBranch: "main" },
    ]);

    assert.equal(result.claimed, false);
    assert.equal(result.reason, "different_queue_lane");
    assert.equal(queries.length, 0);
  });

  it("treats building integration rows as active Postgres lane work", async () => {
    const rows = new Map([
      [
        "elizaos/eliza#33",
        queueRow({ pullRequestId: 33, targetBranch: "develop" }),
      ],
    ]);
    const queries = [];
    const store = new PostgresQueueStore({
      pool: {
        async query(sql, values) {
          queries.push({ sql, values });
          if (/pg_advisory_xact_lock/.test(sql)) {
            assert.deepEqual(values, ["elizaos/eliza", "develop"]);
            return { rows: [] };
          }
          if (
            /SELECT \* FROM steward_queue_items WHERE id = \$1 FOR UPDATE SKIP LOCKED/.test(
              sql,
            )
          ) {
            return { rows: [rows.get(values[0])] };
          }
          if (/SELECT \* FROM steward_queue_items WHERE id = \$1/.test(sql)) {
            return { rows: [rows.get(values[0])] };
          }
          if (/SELECT 1[\s\S]*FROM steward_queue_items/.test(sql)) {
            assert.match(
              sql,
              /queue_state IN \('running', 'building_integration'\)/,
            );
            return { rows: [{ exists: 1 }] };
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      },
    });

    const result = await store.claimNextQueueItem([
      { repo: "elizaos/eliza", pullRequestId: 33, targetBranch: "develop" },
    ]);

    assert.equal(result.claimed, false);
    assert.equal(result.reason, "repo_or_target_busy");
    assert.equal(
      queries.some((query) => /UPDATE steward_queue_items/.test(query.sql)),
      false,
    );
  });

  it("does not claim a Postgres worker lease held by another active owner", async () => {
    const queries = [];
    const store = new PostgresQueueStore({
      pool: {
        async query(sql, values) {
          queries.push({ sql, values });
          if (
            /SELECT \* FROM steward_worker_leases WHERE id = \$1 FOR UPDATE/.test(
              sql,
            )
          ) {
            return {
              rows: [
                {
                  id: "merge-queue",
                  owner_id: "worker-a",
                  status: "active",
                  acquired_at: "2026-07-06T00:00:00.000Z",
                  renewed_at: "2026-07-06T00:00:00.000Z",
                  expires_at: "2026-07-06T00:00:30.000Z",
                  released_at: null,
                  release_reason: null,
                  metadata_json: {},
                  payload_json: {},
                  created_at: "2026-07-06T00:00:00.000Z",
                  updated_at: "2026-07-06T00:00:00.000Z",
                },
              ],
            };
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      },
    });

    const result = await store.claimWorkerLease(
      { id: "merge-queue", ownerId: "worker-b" },
      { now: "2026-07-06T00:00:10.000Z", ttlMs: 30000 },
    );

    assert.equal(result.claimed, false);
    assert.equal(result.reason, "lease_held");
    assert.equal(result.lease.ownerId, "worker-a");
    assert.equal(queries.length, 1);
  });

  it("heartbeats and releases Postgres worker leases by owner", async () => {
    const queries = [];
    const store = new PostgresQueueStore({
      pool: {
        async query(sql, values) {
          queries.push({ sql, values });
          if (/UPDATE steward_worker_leases[\s\S]*renewed_at/.test(sql)) {
            assert.match(sql, /owner_id = \$4/);
            assert.match(
              sql,
              /expires_at IS NULL OR expires_at > \$2::timestamptz/,
            );
            assert.deepEqual(values.slice(0, 4), [
              "merge-queue",
              "2026-07-06T00:00:10.000Z",
              "2026-07-06T00:00:40.000Z",
              "worker-a",
            ]);
            return {
              rows: [
                {
                  id: values[0],
                  owner_id: values[3],
                  status: "active",
                  acquired_at: "2026-07-06T00:00:00.000Z",
                  renewed_at: values[1],
                  expires_at: values[2],
                  released_at: null,
                  release_reason: null,
                  metadata_json: {},
                  payload_json: JSON.parse(values[4]),
                  created_at: "2026-07-06T00:00:00.000Z",
                  updated_at: values[1],
                },
              ],
            };
          }
          if (
            /UPDATE steward_worker_leases[\s\S]*status = 'released'/.test(sql)
          ) {
            assert.match(sql, /owner_id = \$4/);
            assert.deepEqual(values.slice(0, 4), [
              "merge-queue",
              "shutdown",
              "2026-07-06T00:00:12.000Z",
              "worker-a",
            ]);
            return {
              rows: [
                {
                  id: values[0],
                  owner_id: values[3],
                  status: "released",
                  acquired_at: "2026-07-06T00:00:00.000Z",
                  renewed_at: "2026-07-06T00:00:10.000Z",
                  expires_at: "2026-07-06T00:00:40.000Z",
                  released_at: values[2],
                  release_reason: values[1],
                  metadata_json: {},
                  payload_json: JSON.parse(values[4]),
                  created_at: "2026-07-06T00:00:00.000Z",
                  updated_at: values[2],
                },
              ],
            };
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      },
    });

    const heartbeat = await store.heartbeatWorkerLease("merge-queue", {
      ownerId: "worker-a",
      now: "2026-07-06T00:00:10.000Z",
      ttlMs: 30000,
    });
    const released = await store.releaseWorkerLease("merge-queue", {
      ownerId: "worker-a",
      reason: "shutdown",
      now: "2026-07-06T00:00:12.000Z",
    });

    assert.equal(heartbeat.renewedAt, "2026-07-06T00:00:10.000Z");
    assert.equal(released.status, "released");
    assert.equal(released.releaseReason, "shutdown");
    assert.equal(queries.length, 2);
  });

  it("upserts repository policies into Postgres", async () => {
    const queries = [];
    const store = new PostgresQueueStore({
      pool: {
        async query(sql, values) {
          queries.push({ sql, values });
          if (
            /SELECT \* FROM steward_repo_policies WHERE repo = \$1/.test(sql)
          ) {
            assert.deepEqual(values, ["elizaos/eliza"]);
            return {
              rows: [
                {
                  repo: "elizaos/eliza",
                  queue_mode: "serialized",
                  protected_branches: ["develop"],
                  required_checks: ["test"],
                  trusted_actors: ["agent-one"],
                  allow_forks: false,
                  policy_json: { maxBatchSize: 1 },
                  created_at: "2026-07-06T00:00:00.000Z",
                  updated_at: "2026-07-06T00:01:00.000Z",
                },
              ],
            };
          }
          if (/INSERT INTO steward_repo_policies/.test(sql)) {
            assert.equal(values[0], "elizaos/eliza");
            assert.equal(values[1], "batched");
            assert.deepEqual(JSON.parse(values[2]), ["main"]);
            assert.deepEqual(JSON.parse(values[3]), ["test", "lint"]);
            assert.deepEqual(JSON.parse(values[4]), [
              "operator-one",
              "agent-one",
            ]);
            assert.equal(values[5], true);
            assert.deepEqual(JSON.parse(values[6]), { maxBatchSize: 4 });
            return {
              rows: [
                {
                  repo: values[0],
                  queue_mode: values[1],
                  protected_branches: JSON.parse(values[2]),
                  required_checks: JSON.parse(values[3]),
                  trusted_actors: JSON.parse(values[4]),
                  allow_forks: values[5],
                  policy_json: JSON.parse(values[6]),
                  created_at: values[7],
                  updated_at: values[8],
                },
              ],
            };
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      },
    });

    const policy = await store.upsertRepoPolicy({
      repo: "elizaos/eliza",
      queueMode: "batched",
      protectedBranches: ["main"],
      requiredChecks: ["test", "lint"],
      trustedActors: ["operator-one", "agent-one"],
      allowForks: true,
      policy: { maxBatchSize: 4 },
    });

    assert.equal(policy.queueMode, "batched");
    assert.equal(policy.allowForks, true);
    assert.equal(policy.policy.maxBatchSize, 4);
    assert.equal(queries.length, 2);
  });

  it("claims agent work by repo resource when a custom id is supplied", async () => {
    const queries = [];
    const existingRow = {
      id: "custom-claim-one",
      repo: "elizaos/eliza",
      resource_kind: "path",
      resource_id: "src/core.ts",
      owner_agent_id: "agent-one",
      task_id: "task-one",
      run_id: null,
      branch: null,
      paths_json: ["src/core.ts"],
      status: "active",
      claimed_at: "2026-07-06T00:00:00.000Z",
      renewed_at: "2026-07-06T00:00:00.000Z",
      expires_at: "2026-07-06T01:00:00.000Z",
      released_at: null,
      release_reason: null,
      metadata_json: { reason: "editing" },
      payload_json: {},
      created_at: "2026-07-06T00:00:00.000Z",
      updated_at: "2026-07-06T00:00:00.000Z",
    };
    const store = new PostgresQueueStore({
      pool: {
        async query(sql, values) {
          queries.push({ sql, values });
          if (/SELECT \* FROM steward_agent_claims/.test(sql)) {
            assert.match(sql, /id = \$1/);
            assert.match(sql, /repo = \$2/);
            assert.match(sql, /resource_kind = \$3/);
            assert.match(sql, /resource_id = \$4/);
            assert.deepEqual(values, [
              "custom-claim-two",
              "elizaos/eliza",
              "path",
              "src/core.ts",
            ]);
            return { rows: [existingRow] };
          }
          if (/INSERT INTO steward_agent_claims/.test(sql)) {
            assert.equal(values[0], "custom-claim-one");
            return {
              rows: [
                {
                  ...existingRow,
                  renewed_at: "2026-07-06T00:10:00.000Z",
                  expires_at: "2026-07-06T00:40:00.000Z",
                  updated_at: "2026-07-06T00:10:00.000Z",
                },
              ],
            };
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      },
    });

    const result = await store.claimAgentWork(
      {
        id: "custom-claim-two",
        repo: "elizaos/eliza",
        resourceKind: "path",
        resourceId: "src/core.ts",
        ownerAgentId: "agent-one",
        taskId: "task-one",
        paths: ["src/core.ts"],
      },
      { now: "2026-07-06T00:10:00.000Z", ttlMs: 30 * 60 * 1000 },
    );

    assert.equal(result.claimed, true);
    assert.equal(result.claim.id, "custom-claim-one");
    assert.equal(result.claim.renewedAt, "2026-07-06T00:10:00.000Z");
    assert.equal(queries.length, 2);
  });

  it("rejects Postgres agent claim custom ids assigned to another resource", async () => {
    const store = new PostgresQueueStore({
      pool: {
        async query(sql, values) {
          assert.match(sql, /FROM steward_agent_claims/);
          assert.deepEqual(values, [
            "custom-claim-one",
            "elizaos/eliza",
            "path",
            "src/other.ts",
          ]);
          return {
            rows: [
              {
                id: "custom-claim-one",
                repo: "elizaos/eliza",
                resource_kind: "path",
                resource_id: "src/core.ts",
                owner_agent_id: "agent-one",
                task_id: "task-one",
                run_id: null,
                branch: null,
                paths_json: ["src/core.ts"],
                status: "active",
                claimed_at: "2026-07-06T00:00:00.000Z",
                renewed_at: "2026-07-06T00:00:00.000Z",
                expires_at: "2026-07-06T01:00:00.000Z",
                released_at: null,
                release_reason: null,
                metadata_json: {},
                payload_json: {},
                created_at: "2026-07-06T00:00:00.000Z",
                updated_at: "2026-07-06T00:00:00.000Z",
              },
            ],
          };
        },
      },
    });

    const result = await store.claimAgentWork({
      id: "custom-claim-one",
      repo: "elizaos/eliza",
      resourceKind: "path",
      resourceId: "src/other.ts",
      ownerAgentId: "agent-one",
    });

    assert.equal(result.claimed, false);
    assert.equal(result.reason, "claim_id_conflict");
    assert.equal(result.claim.resourceId, "src/core.ts");
  });

  it("transfers Postgres agent claims between owners", async () => {
    const queries = [];
    const store = new PostgresQueueStore({
      pool: {
        async query(sql, values) {
          queries.push({ sql, values });
          assert.match(sql, /UPDATE steward_agent_claims/);
          assert.match(sql, /owner_agent_id = \$3/);
          assert.match(sql, /jsonb_build_object/);
          assert.match(sql, /handoffs/);
          assert.deepEqual(values.slice(0, 6), [
            "claim:elizaos/eliza:path:src/core.ts",
            "agent-one",
            "agent-two",
            "2026-07-06T00:10:00.000Z",
            "2026-07-06T00:11:30.000Z",
            "handoff",
          ]);
          assert.equal(JSON.parse(values[6]).ownerAgentId, "agent-two");
          return {
            rows: [
              {
                id: "claim:elizaos/eliza:path:src/core.ts",
                repo: "elizaos/eliza",
                resource_kind: "path",
                resource_id: "src/core.ts",
                owner_agent_id: "agent-two",
                task_id: "task-one",
                run_id: null,
                branch: null,
                paths_json: ["src/core.ts"],
                status: "active",
                claimed_at: "2026-07-06T00:10:00.000Z",
                renewed_at: "2026-07-06T00:10:00.000Z",
                expires_at: "2026-07-06T00:11:30.000Z",
                released_at: null,
                release_reason: null,
                metadata_json: {
                  transferredFromAgentId: "agent-one",
                  transferredToAgentId: "agent-two",
                  transferReason: "handoff",
                  transferredAt: "2026-07-06T00:10:00.000Z",
                  handoffs: [
                    {
                      fromAgentId: "agent-one",
                      toAgentId: "agent-two",
                      reason: "handoff",
                      transferredAt: "2026-07-06T00:10:00.000Z",
                    },
                  ],
                },
                payload_json: {},
                created_at: "2026-07-06T00:00:00.000Z",
                updated_at: "2026-07-06T00:10:00.000Z",
              },
            ],
          };
        },
      },
    });

    const claim = await store.transferAgentClaim(
      "claim:elizaos/eliza:path:src/core.ts",
      {
        fromOwnerAgentId: "agent-one",
        toOwnerAgentId: "agent-two",
        reason: "handoff",
        ttlMs: 90_000,
        now: "2026-07-06T00:10:00.000Z",
      },
    );

    assert.equal(claim.ownerAgentId, "agent-two");
    assert.equal(claim.expiresAt, "2026-07-06T00:11:30.000Z");
    assert.equal(claim.metadata.transferredFromAgentId, "agent-one");
    assert.equal(claim.metadata.transferredToAgentId, "agent-two");
    assert.equal(claim.metadata.handoffs.length, 1);
    assert.equal(queries.length, 1);
  });

  it("persists durable run, attempt, event, and signal lifecycles", async () => {
    const { pool, state } = createLifecyclePool();
    const store = new PostgresQueueStore({ pool });
    const now = "2026-07-06T00:10:00.000Z";

    const run = await store.upsertRun({
      id: "run-one",
      repo: "elizaos/eliza",
      queueItemId: "elizaos/eliza#42",
      pullRequestId: 42,
      sourceBranch: "agent/run-one",
      targetBranch: "develop",
      ownerKind: "agent",
      ownerId: "agent-one",
      status: "running",
      summary: { phase: "build" },
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(run.id, "run-one");
    assert.equal(run.queueItemId, "elizaos/eliza#42");
    assert.deepEqual(run.summary, { phase: "build" });
    assert.equal((await store.getRun("run-one")).status, "running");
    assert.equal((await store.listRuns({ status: "running" })).length, 1);

    const node = await store.upsertRunNode({
      runId: "run-one",
      nodeId: "build",
      iteration: 0,
      status: "running",
      agentId: "agent-one",
      output: { command: "bun test" },
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(node.id, "run-one:build:0");
    assert.equal(node.agentId, "agent-one");
    assert.equal((await store.listRunNodes("run-one")).length, 1);

    const started = await store.startAttempt({
      runId: "run-one",
      nodeId: "build",
      ownerId: "worker-one",
      startedAt: now,
      heartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(started.attempt, 1);
    assert.equal(started.status, "running");
    assert.equal((await store.getAttempt(started.id)).ownerId, "worker-one");
    assert.equal(
      (await store.listAttempts({ runId: "run-one", status: "running" }))
        .length,
      1,
    );

    const heartbeat = await store.heartbeatAttempt(started.id, {
      ownerId: "worker-one",
      now: "2026-07-06T00:11:00.000Z",
    });
    assert.equal(heartbeat.heartbeatAt, "2026-07-06T00:11:00.000Z");

    const finished = await store.finishAttempt(started.id, {
      output: { passed: true },
      now: "2026-07-06T00:12:00.000Z",
    });
    assert.equal(finished.status, "succeeded");
    assert.deepEqual(finished.output, { passed: true });

    const failed = await store.failAttempt(started.id, {
      error: new Error("integration failed"),
      output: { passed: false },
      retryAfterMs: 60_000,
      now: "2026-07-06T00:13:00.000Z",
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastError.message, "integration failed");
    assert.equal(failed.availableAt, "2026-07-06T00:14:00.000Z");

    const cancelled = await store.cancelAttempt(started.id, {
      reason: "superseded",
      cancelledBy: "agent-one",
      now: "2026-07-06T00:14:00.000Z",
    });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.cancelReason, "superseded");

    state.attempt = attemptRow({
      ...started,
      status: "running",
      ownerId: "worker-old",
      heartbeatAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:00:00.000Z",
    });
    const recovered = await store.claimStaleAttempt({
      workerId: "worker-recovery",
      now: "2026-07-06T00:15:00.000Z",
      staleAfterMs: 30_000,
    });
    assert.equal(recovered.claimed, true);
    assert.equal(recovered.attempt.status, "recovering");
    assert.equal(recovered.attempt.recoveredFromOwnerId, "worker-old");

    const event = await store.appendRunEvent({
      runId: "run-one",
      type: "attempt_recovered",
      queueItemId: "elizaos/eliza#42",
      actorKind: "worker",
      actorId: "worker-recovery",
      createdAt: now,
    });
    assert.equal(event.seq, 1);
    assert.equal(event.type, "attempt_recovered");
    assert.equal(
      (await store.listRunEvents("run-one", { afterSeq: 0 })).length,
      1,
    );

    const signal = await store.appendSignal({
      runId: "run-one",
      correlationKey: "deploy:42",
      type: "approval",
      createdAt: now,
    });
    assert.equal(signal.status, "received");
    assert.equal((await store.listSignals({ runId: "run-one" })).length, 1);

    const consumed = await store.consumeSignal(signal.id, {
      consumerId: "worker-recovery",
      now: "2026-07-06T00:16:00.000Z",
    });
    assert.equal(consumed.status, "consumed");
    assert.equal(consumed.consumedBy, "worker-recovery");

    await assert.rejects(store.appendRunEvent({}), /requires runId/);
    await assert.rejects(
      store.appendSignal({}),
      /requires runId or correlationKey/,
    );
  });

  it("selects the Postgres store when DATABASE_URL is configured", async () => {
    const store = createQueueStore(
      loadConfig({
        DATABASE_URL: "postgres://user:pass@localhost:5432/steward",
      }),
    );

    assert.ok(store instanceof PostgresQueueStore);
    await store.close();
  });
});

function queueRow({ pullRequestId, targetBranch = "develop" } = {}) {
  return {
    id: `elizaos/eliza#${pullRequestId}`,
    repo: "elizaos/eliza",
    pull_request_id: pullRequestId,
    source_branch: `agent/pr-${pullRequestId}`,
    target_branch: targetBranch,
    head_sha: `head-sha-${pullRequestId}`,
    queue_state: "queued",
    priority: 1,
    risk_score: 1,
    conflict_score: 1,
    author_kind: "agent",
    owner_agent_id: "agent-one",
    task_id: null,
    labels: [],
    changed_files: [`packages/core/src/pr-${pullRequestId}.ts`],
    affected_paths: [],
    affected_packages: [],
    required_checks: ["test"],
    check_results: { test: "success" },
    policy_snapshot: {},
    claim_owner_id: null,
    claimed_at: null,
    attempt_count: 0,
    available_at: null,
    finished_at: null,
    last_error: null,
    payload_json: {},
    created_at: "2026-07-06T00:00:00.000Z",
    updated_at: "2026-07-06T00:00:00.000Z",
  };
}

function createLifecyclePool() {
  const state = {
    run: null,
    node: null,
    attempt: null,
    event: null,
    signal: null,
  };

  return {
    state,
    pool: {
      async query(sql, values = []) {
        if (sql.includes("SELECT COALESCE(MAX(attempt)")) {
          return { rows: [{ next_attempt: 1 }] };
        }
        if (sql.includes("SELECT COALESCE(MAX(seq)")) {
          return { rows: [{ next_seq: 1 }] };
        }
        if (sql.includes("SELECT COUNT(*) + 1 AS next_signal")) {
          return { rows: [{ next_signal: 1 }] };
        }
        if (sql.includes("INSERT INTO steward_queue_items")) {
          return { rows: [] };
        }

        if (sql.includes("INSERT INTO steward_runs")) {
          state.run = runRow(JSON.parse(values[18]));
          return { rows: [state.run] };
        }
        if (sql.includes("SELECT * FROM steward_runs WHERE id")) {
          return { rows: state.run ? [state.run] : [] };
        }
        if (sql.includes("SELECT * FROM steward_runs")) {
          return { rows: state.run ? [state.run] : [] };
        }

        if (sql.includes("INSERT INTO steward_run_nodes")) {
          if (!sql.includes("RETURNING *")) return { rows: [] };
          state.node = runNodeRow(JSON.parse(values[17]));
          return { rows: [state.node] };
        }
        if (sql.includes("SELECT * FROM steward_run_nodes WHERE id")) {
          return { rows: state.node ? [state.node] : [] };
        }
        if (sql.includes("SELECT * FROM steward_run_nodes")) {
          return { rows: state.node ? [state.node] : [] };
        }

        if (
          sql.includes("FROM steward_attempts") &&
          sql.includes("status IN")
        ) {
          return { rows: state.attempt ? [state.attempt] : [] };
        }
        if (sql.includes("INSERT INTO steward_attempts")) {
          state.attempt = attemptRow(JSON.parse(values[16]));
          return { rows: [state.attempt] };
        }
        if (sql.includes("UPDATE steward_attempts")) {
          const payloadIndex = sql.includes("SET status = 'failed'")
            ? 6
            : sql.includes("SET status = 'succeeded'") ||
                sql.includes("SET status = 'cancelled'")
              ? 3 - Number(sql.includes("SET status = 'cancelled'"))
              : sql.includes("SET status = 'recovering'")
                ? 4
                : 3;
          const payload = JSON.parse(values[payloadIndex]);
          state.attempt = attemptRow({ ...state.attempt, ...payload });
          return { rows: [state.attempt] };
        }
        if (sql.includes("SELECT * FROM steward_attempts WHERE id")) {
          return { rows: state.attempt ? [state.attempt] : [] };
        }
        if (sql.includes("SELECT * FROM steward_attempts")) {
          return { rows: state.attempt ? [state.attempt] : [] };
        }

        if (sql.includes("INSERT INTO steward_run_events")) {
          state.event = runEventRow({
            ...JSON.parse(values[7]),
            id: values[0],
            runId: values[1],
            seq: values[2],
            type: values[3],
            createdAt: values[8],
          });
          return { rows: [state.event] };
        }
        if (sql.includes("SELECT * FROM steward_run_events")) {
          return { rows: state.event ? [state.event] : [] };
        }

        if (sql.includes("INSERT INTO steward_signals")) {
          state.signal = signalRow(JSON.parse(values[5]));
          return { rows: [state.signal] };
        }
        if (sql.includes("UPDATE steward_signals")) {
          state.signal = signalRow({
            ...state.signal.payload_json,
            ...JSON.parse(values[3]),
            id: values[0],
          });
          return { rows: [state.signal] };
        }
        if (sql.includes("SELECT * FROM steward_signals")) {
          return { rows: state.signal ? [state.signal] : [] };
        }

        throw new Error(`Unexpected lifecycle SQL: ${sql}`);
      },
    },
  };
}

function runRow(run = {}) {
  return {
    id: run.id,
    repo: run.repo,
    queue_item_id: run.queueItemId,
    pull_request_id: run.pullRequestId,
    source_branch: run.sourceBranch,
    target_branch: run.targetBranch,
    owner_kind: run.ownerKind,
    owner_id: run.ownerId,
    status: run.status,
    runtime_owner_id: run.runtimeOwnerId,
    heartbeat_at: run.heartbeatAt,
    correlation_key: run.correlationKey,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    resumed_by_signal_id: run.resumedBySignalId,
    resumed_by_approval_id: run.resumedByApprovalId,
    last_error: run.lastError,
    summary_json: run.summary ?? {},
    payload_json: run,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
  };
}

function runNodeRow(node = {}) {
  return {
    id: node.id,
    run_id: node.runId,
    node_id: node.nodeId,
    iteration: node.iteration,
    status: node.status,
    agent_id: node.agentId,
    model_id: node.modelId,
    approval_id: node.approvalId,
    correlation_key: node.correlationKey,
    signal_type: node.signalType,
    wake_at: node.wakeAt,
    started_at: node.startedAt,
    completed_at: node.completedAt,
    completed_by_signal_id: node.completedBySignalId,
    completed_by_approval_id: node.completedByApprovalId,
    output_json: node.output ?? {},
    error_json: node.error ?? {},
    payload_json: node,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
  };
}

function attemptRow(attempt = {}) {
  return {
    id: attempt.id,
    run_id: attempt.runId,
    node_id: attempt.nodeId,
    iteration: attempt.iteration,
    attempt: attempt.attempt,
    status: attempt.status,
    owner_id: attempt.ownerId,
    heartbeat_at: attempt.heartbeatAt,
    started_at: attempt.startedAt,
    finished_at: attempt.finishedAt,
    available_at: attempt.availableAt,
    recovered_from_owner_id: attempt.recoveredFromOwnerId,
    recovered_at: attempt.recoveredAt,
    output_json: attempt.output ?? {},
    error_json:
      attempt.lastError && typeof attempt.lastError === "object"
        ? attempt.lastError
        : {},
    last_error:
      typeof attempt.lastError === "string" ? attempt.lastError : null,
    payload_json: attempt,
    created_at: attempt.createdAt,
    updated_at: attempt.updatedAt,
  };
}

function runEventRow(event = {}) {
  return {
    id: event.id,
    run_id: event.runId,
    seq: event.seq,
    type: event.type,
    queue_item_id: event.queueItemId,
    actor_kind: event.actorKind,
    actor_id: event.actorId,
    payload_json: event,
    created_at: event.createdAt,
  };
}

function signalRow(signal = {}) {
  return {
    id: signal.id,
    run_id: signal.runId,
    correlation_key: signal.correlationKey,
    type: signal.type,
    status: signal.status,
    consumed_by: signal.consumedBy,
    consumed_at: signal.consumedAt,
    payload_json: signal,
    created_at: signal.createdAt,
    updated_at: signal.updatedAt ?? signal.createdAt,
  };
}
