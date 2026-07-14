import { createHash } from "node:crypto";
import pg from "pg";

import {
  agentClaimId,
  approvalId,
  attemptId,
  humanRequestId,
  normalizeRegisteredAgent,
  normalizeRepoPolicy,
  normalizeWorkCycle,
  normalizeWorkItem,
  normalizeWorkModule,
  normalizeWorkPage,
  normalizeWorkView,
  queueItemId,
  registeredAgentId,
  repoPolicyId,
  runId,
  runNodeId,
  workCycleId,
  workerLeaseId,
  workItemId,
  workModuleId,
  workPageId,
  workViewId,
} from "./store.js";

const { Pool } = pg;

const TERMINAL_QUEUE_STATES = new Set([
  "closed",
  "merged",
  "failed",
  "cancelled",
]);
const ACTIVE_QUEUE_STATES = new Set(["running", "building_integration"]);

export class PostgresQueueStore {
  #pool;

  constructor({ connectionString, pool } = {}) {
    if (!pool && !connectionString) {
      throw new TypeError(
        "PostgresQueueStore requires connectionString or pool",
      );
    }
    this.#pool = pool ?? new Pool({ connectionString });
  }

  async close() {
    await this.#pool.end?.();
  }

  async getQueueItem(id) {
    const { rows } = await this.#query(
      "SELECT * FROM steward_queue_items WHERE id = $1",
      [String(id)],
    );
    return rows[0] ? rowToQueueItem(rows[0]) : null;
  }

  async listQueueItems() {
    const { rows } = await this.#query(
      `SELECT * FROM steward_queue_items
       ORDER BY pull_request_id ASC, id ASC`,
    );
    return rows.map(rowToQueueItem);
  }

  async findQueueItemByHeadSha(headSha) {
    if (!headSha) return null;
    const { rows } = await this.#query(
      `SELECT * FROM steward_queue_items
       WHERE head_sha = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [headSha],
    );
    return rows[0] ? rowToQueueItem(rows[0]) : null;
  }

  async upsertQueueItem(item) {
    const id = queueItemId(item);
    const existing = await this.getQueueItem(id);
    const now = new Date().toISOString();
    const next = {
      ...existing,
      ...item,
      id,
      createdAt: existing?.createdAt ?? item.createdAt ?? now,
      updatedAt: item.updatedAt ?? now,
    };
    const { rows } = await this.#query(
      `INSERT INTO steward_queue_items (
         id, repo, pull_request_id, source_branch, target_branch, head_sha,
         queue_state, priority, risk_score, conflict_score, author_kind,
         owner_agent_id, task_id, labels, changed_files, affected_paths,
         affected_packages, required_checks, check_results, policy_snapshot,
         claim_owner_id, claimed_at, attempt_count, available_at, finished_at,
         last_error, payload_json, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         $12, $13, $14::jsonb, $15::jsonb, $16::jsonb,
         $17::jsonb, $18::jsonb, $19::jsonb, $20::jsonb,
         $21, $22, $23, $24, $25,
         $26, $27::jsonb, $28, $29
       )
       ON CONFLICT (id) DO UPDATE SET
         repo = EXCLUDED.repo,
         pull_request_id = EXCLUDED.pull_request_id,
         source_branch = EXCLUDED.source_branch,
         target_branch = EXCLUDED.target_branch,
         head_sha = EXCLUDED.head_sha,
         queue_state = EXCLUDED.queue_state,
         priority = EXCLUDED.priority,
         risk_score = EXCLUDED.risk_score,
         conflict_score = EXCLUDED.conflict_score,
         author_kind = EXCLUDED.author_kind,
         owner_agent_id = EXCLUDED.owner_agent_id,
         task_id = EXCLUDED.task_id,
         labels = EXCLUDED.labels,
         changed_files = EXCLUDED.changed_files,
         affected_paths = EXCLUDED.affected_paths,
         affected_packages = EXCLUDED.affected_packages,
         required_checks = EXCLUDED.required_checks,
         check_results = EXCLUDED.check_results,
         policy_snapshot = EXCLUDED.policy_snapshot,
         claim_owner_id = EXCLUDED.claim_owner_id,
         claimed_at = EXCLUDED.claimed_at,
         attempt_count = EXCLUDED.attempt_count,
         available_at = EXCLUDED.available_at,
         finished_at = EXCLUDED.finished_at,
         last_error = EXCLUDED.last_error,
         payload_json = EXCLUDED.payload_json,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      queueItemParams(next),
    );
    return rowToQueueItem(rows[0]);
  }

  async claimNextQueueItem(
    candidates = [],
    { workerId = "merge-steward", now = new Date().toISOString() } = {},
  ) {
    return this.#transaction(async (client) => {
      let skippedBusy = false;
      let skippedTerminal = false;
      let skippedUnavailable = false;

      for (const candidate of candidates) {
        const id = queueItemId(candidate);
        await this.#lockQueueLane(client, candidate);
        if (!(await this.#getQueueItemRow(client, id))) {
          await this.#insertQueueCandidate(client, candidate);
        }

        const { rows } = await client.query(
          "SELECT * FROM steward_queue_items WHERE id = $1 FOR UPDATE SKIP LOCKED",
          [id],
        );
        const existing = rows[0] ? rowToQueueItem(rows[0]) : null;
        if (!existing) {
          skippedBusy = true;
          continue;
        }

        const effective = { ...existing, ...candidate, id };
        if (TERMINAL_QUEUE_STATES.has(existing.queueState)) {
          skippedTerminal = true;
          continue;
        }
        if (isFutureAvailableAt(effective.availableAt, now)) {
          skippedUnavailable = true;
          continue;
        }
        if (
          ACTIVE_QUEUE_STATES.has(existing.queueState) ||
          (await this.#laneHasActiveItem(client, effective))
        ) {
          skippedBusy = true;
          continue;
        }

        const claimed = await client.query(
          `UPDATE steward_queue_items
           SET queue_state = 'running',
               claim_owner_id = $2,
               claimed_at = $3,
               attempt_count = attempt_count + 1,
               last_error = NULL,
               payload_json = payload_json || $4::jsonb,
               updated_at = $3
           WHERE id = $1
           RETURNING *`,
          [
            id,
            workerId,
            now,
            jsonPayload({
              ...effective,
              queueState: "running",
              claimedBy: workerId,
              claimedAt: now,
              attemptCount: Number(existing.attemptCount ?? 0) + 1,
              lastError: null,
              updatedAt: now,
            }),
          ],
        );
        return { claimed: true, item: rowToQueueItem(claimed.rows[0]) };
      }

      return {
        claimed: false,
        reason: skippedBusy
          ? "repo_or_target_busy"
          : skippedUnavailable
            ? "no_available_items"
            : skippedTerminal
              ? "no_claimable_items"
              : "no_ready_items",
      };
    });
  }

  async claimQueueItems(
    candidates = [],
    { workerId = "merge-steward", now = new Date().toISOString() } = {},
  ) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return { claimed: false, reason: "no_ready_items" };
    }

    return this.#transaction(async (client) => {
      let skippedTerminal = false;
      let skippedUnavailable = false;
      const ids = candidates.map((candidate) => queueItemId(candidate));
      const candidateScope = queueItemScopeKey(candidates[0]);
      const locked = [];
      let scope = null;

      if (
        candidates.some(
          (candidate) => queueItemScopeKey(candidate) !== candidateScope,
        )
      ) {
        return { claimed: false, reason: "different_queue_lane" };
      }
      await this.#lockQueueLane(client, candidates[0]);

      for (const candidate of candidates) {
        const id = queueItemId(candidate);
        if (!(await this.#getQueueItemRow(client, id))) {
          await this.#insertQueueCandidate(client, candidate);
        }

        const { rows } = await client.query(
          "SELECT * FROM steward_queue_items WHERE id = $1 FOR UPDATE SKIP LOCKED",
          [id],
        );
        const existing = rows[0] ? rowToQueueItem(rows[0]) : null;
        if (!existing) {
          return { claimed: false, reason: "repo_or_target_busy" };
        }

        const effective = { ...existing, ...candidate, id };
        const nextScope = queueItemScopeKey(effective);
        if (TERMINAL_QUEUE_STATES.has(existing.queueState)) {
          skippedTerminal = true;
          continue;
        }
        if (isFutureAvailableAt(effective.availableAt, now)) {
          skippedUnavailable = true;
          continue;
        }
        if (ACTIVE_QUEUE_STATES.has(existing.queueState)) {
          return { claimed: false, reason: "repo_or_target_busy" };
        }
        if (scope && nextScope !== scope) {
          return { claimed: false, reason: "different_queue_lane" };
        }

        scope = nextScope;
        locked.push({ existing, effective });
      }

      if (locked.length !== candidates.length) {
        return {
          claimed: false,
          reason: skippedUnavailable
            ? "no_available_items"
            : skippedTerminal
              ? "no_claimable_items"
              : "no_ready_items",
        };
      }

      if (await this.#laneHasActiveItem(client, locked[0].effective, ids)) {
        return { claimed: false, reason: "repo_or_target_busy" };
      }

      const items = [];
      for (const { existing, effective } of locked) {
        const claimed = await client.query(
          `UPDATE steward_queue_items
           SET queue_state = 'running',
               claim_owner_id = $2,
               claimed_at = $3,
               attempt_count = attempt_count + 1,
               last_error = NULL,
               payload_json = payload_json || $4::jsonb,
               updated_at = $3
           WHERE id = $1
           RETURNING *`,
          [
            effective.id,
            workerId,
            now,
            jsonPayload({
              ...effective,
              queueState: "running",
              claimedBy: workerId,
              claimedAt: now,
              attemptCount: Number(existing.attemptCount ?? 0) + 1,
              lastError: null,
              updatedAt: now,
            }),
          ],
        );
        items.push(rowToQueueItem(claimed.rows[0]));
      }

      return {
        claimed: true,
        item: items[0],
        items,
      };
    });
  }

  async finishQueueItem(
    id,
    {
      state = "merged",
      now = new Date().toISOString(),
      activeRunId,
      claimedBy,
      queueState,
    } = {},
  ) {
    const { rows } = await this.#query(
      `UPDATE steward_queue_items
       SET queue_state = $2,
           finished_at = $3,
           last_error = NULL,
           payload_json = payload_json || $4::jsonb,
           updated_at = $3
       WHERE id = $1
         AND ($5::text IS NULL OR payload_json->>'activeRunId' = $5)
         AND ($6::text IS NULL OR claim_owner_id = $6 OR payload_json->>'claimedBy' = $6)
         AND ($7::text IS NULL OR queue_state = $7)
       RETURNING *`,
      [
        String(id),
        state,
        now,
        jsonPayload({
          queueState: state,
          finishedAt: now,
          lastError: null,
          updatedAt: now,
        }),
        activeRunId ?? null,
        claimedBy ?? null,
        queueState ?? null,
      ],
    );
    return rows[0] ? rowToQueueItem(rows[0]) : null;
  }

  async failQueueItem(
    id,
    {
      error,
      now = new Date().toISOString(),
      activeRunId,
      claimedBy,
      queueState,
    } = {},
  ) {
    const lastError =
      error instanceof Error
        ? error.message
        : String(error ?? "queue_item_failed");
    const { rows } = await this.#query(
      `UPDATE steward_queue_items
       SET queue_state = 'failed',
           finished_at = $2,
           last_error = $3,
           payload_json = payload_json || $4::jsonb,
           updated_at = $2
       WHERE id = $1
         AND ($5::text IS NULL OR payload_json->>'activeRunId' = $5)
         AND ($6::text IS NULL OR claim_owner_id = $6 OR payload_json->>'claimedBy' = $6)
         AND ($7::text IS NULL OR queue_state = $7)
       RETURNING *`,
      [
        String(id),
        now,
        lastError,
        jsonPayload({
          queueState: "failed",
          finishedAt: now,
          lastError,
          updatedAt: now,
        }),
        activeRunId ?? null,
        claimedBy ?? null,
        queueState ?? null,
      ],
    );
    return rows[0] ? rowToQueueItem(rows[0]) : null;
  }

  async upsertApproval(approval = {}) {
    const id = approvalId(approval);
    const existing = await this.getApproval(id);
    const now = new Date().toISOString();
    const iteration = normalizedIteration(
      approval.iteration,
      existing?.iteration ?? 0,
    );
    const next = {
      ...existing,
      ...approval,
      id,
      status: approval.status ?? existing?.status ?? "requested",
      nodeId: approval.nodeId ?? existing?.nodeId ?? "human_approval",
      iteration,
      requestedAt: existing?.requestedAt ?? approval.requestedAt ?? now,
      createdAt: existing?.createdAt ?? approval.createdAt ?? now,
      updatedAt: approval.updatedAt ?? now,
    };
    await this.#ensureQueueItemForId(next.queueItemId);
    const { rows } = await this.#query(
      `INSERT INTO steward_approvals (
         id, run_id, queue_item_id, node_id, iteration, status, request_json,
         allowed_actors_json, decision_json, requested_by, decided_by,
         requested_at, decided_at, payload_json, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::jsonb,
         $8::jsonb, $9::jsonb, $10, $11,
         $12, $13, $14::jsonb, $15, $16
       )
       ON CONFLICT (id) DO UPDATE SET
         run_id = EXCLUDED.run_id,
         queue_item_id = EXCLUDED.queue_item_id,
         node_id = EXCLUDED.node_id,
         iteration = EXCLUDED.iteration,
         status = EXCLUDED.status,
         request_json = EXCLUDED.request_json,
         allowed_actors_json = EXCLUDED.allowed_actors_json,
         decision_json = EXCLUDED.decision_json,
         requested_by = EXCLUDED.requested_by,
         decided_by = EXCLUDED.decided_by,
         requested_at = EXCLUDED.requested_at,
         decided_at = EXCLUDED.decided_at,
         payload_json = EXCLUDED.payload_json,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      approvalParams(next),
    );
    return rowToApproval(rows[0]);
  }

  async getApproval(id) {
    const { rows } = await this.#query(
      "SELECT * FROM steward_approvals WHERE id = $1",
      [String(id)],
    );
    return rows[0] ? rowToApproval(rows[0]) : null;
  }

  async listApprovals({ status } = {}) {
    const filters = buildFilters({ status });
    const { rows } = await this.#query(
      `SELECT * FROM steward_approvals ${filters.where}
       ORDER BY requested_at ASC, created_at ASC`,
      filters.values,
    );
    return rows.map(rowToApproval);
  }

  async decideApproval(
    id,
    {
      approved,
      decidedBy,
      note,
      decision,
      now = new Date().toISOString(),
    } = {},
  ) {
    const existing = await this.getApproval(id);
    if (!existing) return null;
    const nextDecision = {
      ...(existing.decision ?? {}),
      ...(decision ?? {}),
      approved: approved === true,
      note: note ?? decision?.note ?? null,
    };
    const next = {
      ...existing,
      status: approved === true ? "approved" : "denied",
      decision: nextDecision,
      decidedBy: decidedBy ?? decision?.decidedBy ?? null,
      decidedAt: now,
      updatedAt: now,
    };
    const { rows } = await this.#query(
      `UPDATE steward_approvals
       SET status = $2,
           decision_json = $3::jsonb,
           decided_by = $4,
           decided_at = $5,
           payload_json = $6::jsonb,
           updated_at = $5
       WHERE id = $1
       RETURNING *`,
      [
        String(id),
        next.status,
        jsonPayload(nextDecision),
        next.decidedBy,
        now,
        jsonPayload(next),
      ],
    );
    return rows[0] ? rowToApproval(rows[0]) : null;
  }

  async upsertHumanRequest(request = {}) {
    const id = humanRequestId(request);
    const existing = await this.getHumanRequest(id);
    const now = new Date().toISOString();
    const iteration = normalizedIteration(
      request.iteration,
      existing?.iteration ?? 0,
    );
    const next = {
      ...existing,
      ...request,
      id,
      status: request.status ?? existing?.status ?? "requested",
      kind: request.kind ?? existing?.kind ?? "confirm",
      nodeId: request.nodeId ?? existing?.nodeId ?? "human_input",
      iteration,
      requestedAt: existing?.requestedAt ?? request.requestedAt ?? now,
      createdAt: existing?.createdAt ?? request.createdAt ?? now,
      updatedAt: request.updatedAt ?? now,
    };
    const { rows } = await this.#query(
      `INSERT INTO steward_human_requests (
         id, run_id, node_id, iteration, kind, status, prompt, options_json,
         response_json, requested_by, responded_by, requested_at, responded_at,
         payload_json, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::jsonb,
         $9::jsonb, $10, $11, $12, $13,
         $14::jsonb, $15, $16
       )
       ON CONFLICT (id) DO UPDATE SET
         run_id = EXCLUDED.run_id,
         node_id = EXCLUDED.node_id,
         iteration = EXCLUDED.iteration,
         kind = EXCLUDED.kind,
         status = EXCLUDED.status,
         prompt = EXCLUDED.prompt,
         options_json = EXCLUDED.options_json,
         response_json = EXCLUDED.response_json,
         requested_by = EXCLUDED.requested_by,
         responded_by = EXCLUDED.responded_by,
         requested_at = EXCLUDED.requested_at,
         responded_at = EXCLUDED.responded_at,
         payload_json = EXCLUDED.payload_json,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      humanRequestParams(next),
    );
    return rowToHumanRequest(rows[0]);
  }

  async getHumanRequest(id) {
    const { rows } = await this.#query(
      "SELECT * FROM steward_human_requests WHERE id = $1",
      [String(id)],
    );
    return rows[0] ? rowToHumanRequest(rows[0]) : null;
  }

  async listHumanRequests({ status, runId } = {}) {
    const filters = buildFilters({ status, run_id: runId });
    const { rows } = await this.#query(
      `SELECT * FROM steward_human_requests ${filters.where}
       ORDER BY requested_at ASC, created_at ASC`,
      filters.values,
    );
    return rows.map(rowToHumanRequest);
  }

  async respondHumanRequest(
    id,
    {
      response,
      respondedBy,
      status = "answered",
      now = new Date().toISOString(),
    } = {},
  ) {
    const existing = await this.getHumanRequest(id);
    if (!existing) return null;
    const next = {
      ...existing,
      status,
      response: response ?? null,
      respondedBy: respondedBy ?? null,
      respondedAt: now,
      updatedAt: now,
    };
    const { rows } = await this.#query(
      `UPDATE steward_human_requests
       SET status = $2,
           response_json = $3::jsonb,
           responded_by = $4,
           responded_at = $5,
           payload_json = $6::jsonb,
           updated_at = $5
       WHERE id = $1
       RETURNING *`,
      [
        String(id),
        status,
        jsonPayload(next.response),
        next.respondedBy,
        now,
        jsonPayload(next),
      ],
    );
    return rows[0] ? rowToHumanRequest(rows[0]) : null;
  }

  async upsertWorkItem(
    item = {},
    { actorId, now = new Date().toISOString() } = {},
  ) {
    const id = workItemId(item);
    const existing = await this.getWorkItem(id);
    const next = normalizeWorkItem({ ...item, id }, existing, { actorId, now });
    const { rows } = await this.#query(
      `INSERT INTO steward_work_items (
         id, repo, kind, state, title, summary, priority, owner_agent_id,
         task_id, issue_id, pull_request_id, cycle_id, module_id, source_url, target_branch,
         paths_json, packages_json, labels_json, metadata_json,
         created_by, updated_by, claimed_at, completed_at,
         payload_json, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14, $15,
         $16::jsonb, $17::jsonb, $18::jsonb, $19::jsonb,
         $20, $21, $22, $23,
         $24::jsonb, $25, $26
       )
       ON CONFLICT (id) DO UPDATE SET
         repo = EXCLUDED.repo,
         kind = EXCLUDED.kind,
         state = EXCLUDED.state,
         title = EXCLUDED.title,
         summary = EXCLUDED.summary,
         priority = EXCLUDED.priority,
         owner_agent_id = EXCLUDED.owner_agent_id,
         task_id = EXCLUDED.task_id,
         issue_id = EXCLUDED.issue_id,
         pull_request_id = EXCLUDED.pull_request_id,
         cycle_id = EXCLUDED.cycle_id,
         module_id = EXCLUDED.module_id,
         source_url = EXCLUDED.source_url,
         target_branch = EXCLUDED.target_branch,
         paths_json = EXCLUDED.paths_json,
         packages_json = EXCLUDED.packages_json,
         labels_json = EXCLUDED.labels_json,
         metadata_json = EXCLUDED.metadata_json,
         created_by = EXCLUDED.created_by,
         updated_by = EXCLUDED.updated_by,
         claimed_at = EXCLUDED.claimed_at,
         completed_at = EXCLUDED.completed_at,
         payload_json = EXCLUDED.payload_json,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      workItemParams(next),
    );
    return rowToWorkItem(rows[0]);
  }

  async getWorkItem(id) {
    const { rows } = await this.#query(
      "SELECT * FROM steward_work_items WHERE id = $1",
      [String(id)],
    );
    return rows[0] ? rowToWorkItem(rows[0]) : null;
  }

  async listWorkItems({ repo, state, ownerAgentId, kind } = {}) {
    const filters = buildFilters({
      repo,
      state,
      owner_agent_id: ownerAgentId,
      kind,
    });
    const { rows } = await this.#query(
      `SELECT * FROM steward_work_items ${filters.where}
       ORDER BY priority DESC, updated_at DESC, id ASC`,
      filters.values,
    );
    return rows.map(rowToWorkItem);
  }

  async upsertWorkCycle(
    cycle = {},
    { actorId, now = new Date().toISOString() } = {},
  ) {
    const id = workCycleId(cycle);
    const existing = await this.getWorkCycle(id);
    const next = normalizeWorkCycle({ ...cycle, id }, existing, {
      actorId,
      now,
    });
    const { rows } = await this.#query(
      `INSERT INTO steward_work_cycles (
         id, repo, state, title, summary, owner_agent_id, start_at, end_at,
         metadata_json, created_by, updated_by, payload_json, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9::jsonb, $10, $11, $12::jsonb, $13, $14
       )
       ON CONFLICT (id) DO UPDATE SET
         repo = EXCLUDED.repo,
         state = EXCLUDED.state,
         title = EXCLUDED.title,
         summary = EXCLUDED.summary,
         owner_agent_id = EXCLUDED.owner_agent_id,
         start_at = EXCLUDED.start_at,
         end_at = EXCLUDED.end_at,
         metadata_json = EXCLUDED.metadata_json,
         updated_by = EXCLUDED.updated_by,
         payload_json = EXCLUDED.payload_json,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      workCycleParams(next),
    );
    return rowToWorkCycle(rows[0]);
  }

  async getWorkCycle(id) {
    const { rows } = await this.#query(
      "SELECT * FROM steward_work_cycles WHERE id = $1",
      [String(id)],
    );
    return rows[0] ? rowToWorkCycle(rows[0]) : null;
  }

  async listWorkCycles({ repo, state, ownerAgentId } = {}) {
    const filters = buildFilters({ repo, state, owner_agent_id: ownerAgentId });
    const { rows } = await this.#query(
      `SELECT * FROM steward_work_cycles ${filters.where}
       ORDER BY updated_at DESC, title ASC, id ASC`,
      filters.values,
    );
    return rows.map(rowToWorkCycle);
  }

  async upsertWorkModule(
    module = {},
    { actorId, now = new Date().toISOString() } = {},
  ) {
    const id = workModuleId(module);
    const existing = await this.getWorkModule(id);
    const next = normalizeWorkModule({ ...module, id }, existing, {
      actorId,
      now,
    });
    const { rows } = await this.#query(
      `INSERT INTO steward_work_modules (
         id, repo, state, title, summary, owner_agent_id,
         paths_json, packages_json, labels_json, metadata_json,
         created_by, updated_by, payload_json, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
         $11, $12, $13::jsonb, $14, $15
       )
       ON CONFLICT (id) DO UPDATE SET
         repo = EXCLUDED.repo,
         state = EXCLUDED.state,
         title = EXCLUDED.title,
         summary = EXCLUDED.summary,
         owner_agent_id = EXCLUDED.owner_agent_id,
         paths_json = EXCLUDED.paths_json,
         packages_json = EXCLUDED.packages_json,
         labels_json = EXCLUDED.labels_json,
         metadata_json = EXCLUDED.metadata_json,
         updated_by = EXCLUDED.updated_by,
         payload_json = EXCLUDED.payload_json,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      workModuleParams(next),
    );
    return rowToWorkModule(rows[0]);
  }

  async getWorkModule(id) {
    const { rows } = await this.#query(
      "SELECT * FROM steward_work_modules WHERE id = $1",
      [String(id)],
    );
    return rows[0] ? rowToWorkModule(rows[0]) : null;
  }

  async listWorkModules({ repo, state, ownerAgentId } = {}) {
    const filters = buildFilters({ repo, state, owner_agent_id: ownerAgentId });
    const { rows } = await this.#query(
      `SELECT * FROM steward_work_modules ${filters.where}
       ORDER BY updated_at DESC, title ASC, id ASC`,
      filters.values,
    );
    return rows.map(rowToWorkModule);
  }

  async upsertWorkView(
    view = {},
    { actorId, now = new Date().toISOString() } = {},
  ) {
    const id = workViewId(view);
    const existing = await this.getWorkView(id);
    const next = normalizeWorkView({ ...view, id }, existing, { actorId, now });
    const { rows } = await this.#query(
      `INSERT INTO steward_work_views (
         id, repo, kind, state, title, summary, owner_agent_id, query_text,
         filters_json, layout_json, columns_json, visibility, metadata_json,
         created_by, updated_by, payload_json, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9::jsonb, $10::jsonb, $11::jsonb, $12, $13::jsonb,
         $14, $15, $16::jsonb, $17, $18
       )
       ON CONFLICT (id) DO UPDATE SET
         repo = EXCLUDED.repo,
         kind = EXCLUDED.kind,
         state = EXCLUDED.state,
         title = EXCLUDED.title,
         summary = EXCLUDED.summary,
         owner_agent_id = EXCLUDED.owner_agent_id,
         query_text = EXCLUDED.query_text,
         filters_json = EXCLUDED.filters_json,
         layout_json = EXCLUDED.layout_json,
         columns_json = EXCLUDED.columns_json,
         visibility = EXCLUDED.visibility,
         metadata_json = EXCLUDED.metadata_json,
         updated_by = EXCLUDED.updated_by,
         payload_json = EXCLUDED.payload_json,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      workViewParams(next),
    );
    return rowToWorkView(rows[0]);
  }

  async getWorkView(id) {
    const { rows } = await this.#query(
      "SELECT * FROM steward_work_views WHERE id = $1",
      [String(id)],
    );
    return rows[0] ? rowToWorkView(rows[0]) : null;
  }

  async listWorkViews({ repo, state, ownerAgentId, kind } = {}) {
    const filters = buildFilters({
      repo,
      state,
      owner_agent_id: ownerAgentId,
      kind,
    });
    const { rows } = await this.#query(
      `SELECT * FROM steward_work_views ${filters.where}
       ORDER BY updated_at DESC, title ASC, id ASC`,
      filters.values,
    );
    return rows.map(rowToWorkView);
  }

  async upsertWorkPage(
    page = {},
    { actorId, now = new Date().toISOString() } = {},
  ) {
    const id = workPageId(page);
    const existing = await this.getWorkPage(id);
    const next = normalizeWorkPage({ ...page, id }, existing, { actorId, now });
    const { rows } = await this.#query(
      `INSERT INTO steward_work_pages (
         id, repo, kind, state, title, summary, body_text, body_format,
         owner_agent_id, work_item_id, cycle_id, module_id, task_id, issue_id,
         pull_request_id, source_url, tags_json, visibility, metadata_json,
         created_by, updated_by, payload_json, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14,
         $15, $16, $17::jsonb, $18, $19::jsonb,
         $20, $21, $22::jsonb, $23, $24
       )
       ON CONFLICT (id) DO UPDATE SET
         repo = EXCLUDED.repo,
         kind = EXCLUDED.kind,
         state = EXCLUDED.state,
         title = EXCLUDED.title,
         summary = EXCLUDED.summary,
         body_text = EXCLUDED.body_text,
         body_format = EXCLUDED.body_format,
         owner_agent_id = EXCLUDED.owner_agent_id,
         work_item_id = EXCLUDED.work_item_id,
         cycle_id = EXCLUDED.cycle_id,
         module_id = EXCLUDED.module_id,
         task_id = EXCLUDED.task_id,
         issue_id = EXCLUDED.issue_id,
         pull_request_id = EXCLUDED.pull_request_id,
         source_url = EXCLUDED.source_url,
         tags_json = EXCLUDED.tags_json,
         visibility = EXCLUDED.visibility,
         metadata_json = EXCLUDED.metadata_json,
         updated_by = EXCLUDED.updated_by,
         payload_json = EXCLUDED.payload_json,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      workPageParams(next),
    );
    return rowToWorkPage(rows[0]);
  }

  async getWorkPage(id) {
    const { rows } = await this.#query(
      "SELECT * FROM steward_work_pages WHERE id = $1",
      [String(id)],
    );
    return rows[0] ? rowToWorkPage(rows[0]) : null;
  }

  async listWorkPages({
    repo,
    state,
    ownerAgentId,
    kind,
    workItemId,
    cycleId,
    moduleId,
    taskId,
    issueId,
    pullRequestId,
  } = {}) {
    const filters = buildFilters({
      repo,
      state,
      owner_agent_id: ownerAgentId,
      kind,
      work_item_id: workItemId,
      cycle_id: cycleId,
      module_id: moduleId,
      task_id: taskId,
      issue_id: issueId,
      pull_request_id: pullRequestId,
    });
    const { rows } = await this.#query(
      `SELECT * FROM steward_work_pages ${filters.where}
       ORDER BY updated_at DESC, title ASC, id ASC`,
      filters.values,
    );
    return rows.map(rowToWorkPage);
  }

  async transitionWorkPage(
    id,
    {
      state,
      transitionedBy,
      actorId,
      reason,
      now = new Date().toISOString(),
    } = {},
  ) {
    const existing = await this.getWorkPage(id);
    if (!existing) return null;
    if (!["active", "archived"].includes(state)) {
      throw new TypeError(
        "Work page transition state must be one of active, archived",
      );
    }
    return this.upsertWorkPage(
      {
        ...existing,
        state,
        metadata: {
          ...(existing.metadata ?? {}),
          transitions: [
            ...arrayValue(existing.metadata?.transitions),
            {
              from: existing.state,
              to: state,
              actorId: transitionedBy ?? actorId ?? null,
              reason: reason == null ? null : String(reason),
              at: now,
            },
          ],
        },
        updatedBy: transitionedBy ?? actorId ?? existing.updatedBy,
        updatedAt: now,
      },
      { actorId: transitionedBy ?? actorId, now },
    );
  }

  async transitionWorkItem(
    id,
    {
      state,
      transitionedBy,
      actorId,
      reason,
      now = new Date().toISOString(),
    } = {},
  ) {
    const existing = await this.getWorkItem(id);
    if (!existing) return null;
    if (
      ![
        "backlog",
        "ready",
        "claimed",
        "in_progress",
        "needs_human_review",
        "merge_queue",
        "blocked",
        "done",
        "cancelled",
      ].includes(state)
    ) {
      throw new TypeError("Work item transition state must be valid");
    }
    const next = normalizeWorkItem(
      {
        ...existing,
        state,
        updatedBy: transitionedBy ?? actorId ?? existing.updatedBy,
        completedAt: ["done", "cancelled"].includes(state)
          ? (existing.completedAt ?? now)
          : null,
        metadata: {
          ...(existing.metadata ?? {}),
          transitions: [
            ...arrayValue(existing.metadata?.transitions),
            {
              from: existing.state,
              to: state,
              actorId: transitionedBy ?? actorId ?? null,
              reason: reason == null ? null : String(reason),
              at: now,
            },
          ],
        },
        updatedAt: now,
      },
      existing,
      { actorId: transitionedBy ?? actorId, now },
    );
    const { rows } = await this.#query(
      `UPDATE steward_work_items
       SET state = $2,
           metadata_json = $3::jsonb,
           updated_by = $4,
           completed_at = $5,
           payload_json = $6::jsonb,
           updated_at = $7
       WHERE id = $1
       RETURNING *`,
      [
        String(id),
        next.state,
        jsonPayload(next.metadata),
        next.updatedBy,
        next.completedAt,
        jsonPayload(next),
        now,
      ],
    );
    return rows[0] ? rowToWorkItem(rows[0]) : null;
  }

  async upsertRun(run = {}) {
    const id = runId(run);
    const existing = await this.getRun(id);
    const now = new Date().toISOString();
    const next = {
      ...existing,
      ...run,
      id,
      status: run.status ?? existing?.status ?? "running",
      createdAt: existing?.createdAt ?? run.createdAt ?? now,
      updatedAt: run.updatedAt ?? now,
    };
    await this.#ensureQueueItemForId(next.queueItemId);
    const { rows } = await this.#query(
      `INSERT INTO steward_runs (
         id, repo, queue_item_id, pull_request_id, source_branch, target_branch,
         owner_kind, owner_id, status, runtime_owner_id, heartbeat_at,
         correlation_key, started_at, finished_at, resumed_by_signal_id,
         resumed_by_approval_id, last_error, summary_json, payload_json,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         $12, $13, $14, $15,
         $16, $17, $18::jsonb, $19::jsonb,
         $20, $21
       )
       ON CONFLICT (id) DO UPDATE SET
         repo = EXCLUDED.repo,
         queue_item_id = EXCLUDED.queue_item_id,
         pull_request_id = EXCLUDED.pull_request_id,
         source_branch = EXCLUDED.source_branch,
         target_branch = EXCLUDED.target_branch,
         owner_kind = EXCLUDED.owner_kind,
         owner_id = EXCLUDED.owner_id,
         status = EXCLUDED.status,
         runtime_owner_id = EXCLUDED.runtime_owner_id,
         heartbeat_at = EXCLUDED.heartbeat_at,
         correlation_key = EXCLUDED.correlation_key,
         started_at = EXCLUDED.started_at,
         finished_at = EXCLUDED.finished_at,
         resumed_by_signal_id = EXCLUDED.resumed_by_signal_id,
         resumed_by_approval_id = EXCLUDED.resumed_by_approval_id,
         last_error = EXCLUDED.last_error,
         summary_json = EXCLUDED.summary_json,
         payload_json = EXCLUDED.payload_json,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      runParams(next),
    );
    return rowToRun(rows[0]);
  }

  async getRun(id) {
    const { rows } = await this.#query(
      "SELECT * FROM steward_runs WHERE id = $1",
      [String(id)],
    );
    return rows[0] ? rowToRun(rows[0]) : null;
  }

  async listRuns({ status, queueItemId } = {}) {
    const filters = buildFilters({ status, queue_item_id: queueItemId });
    const { rows } = await this.#query(
      `SELECT * FROM steward_runs ${filters.where}
       ORDER BY updated_at DESC, created_at DESC`,
      filters.values,
    );
    return rows.map(rowToRun);
  }

  async upsertRunNode(node = {}) {
    const id = runNodeId(node);
    const existing = await this.#getRunNode(id);
    const now = new Date().toISOString();
    const iteration = normalizedIteration(
      node.iteration,
      existing?.iteration ?? 0,
    );
    const next = {
      ...existing,
      ...node,
      id,
      status: node.status ?? existing?.status ?? "pending",
      iteration,
      createdAt: existing?.createdAt ?? node.createdAt ?? now,
      updatedAt: node.updatedAt ?? now,
    };
    const { rows } = await this.#query(
      `INSERT INTO steward_run_nodes (
         id, run_id, node_id, iteration, status, agent_id, model_id,
         approval_id, correlation_key, signal_type, wake_at, started_at,
         completed_at, completed_by_signal_id, completed_by_approval_id,
         output_json, error_json, payload_json, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12,
         $13, $14, $15,
         $16::jsonb, $17::jsonb, $18::jsonb, $19, $20
       )
       ON CONFLICT (id) DO UPDATE SET
         run_id = EXCLUDED.run_id,
         node_id = EXCLUDED.node_id,
         iteration = EXCLUDED.iteration,
         status = EXCLUDED.status,
         agent_id = EXCLUDED.agent_id,
         model_id = EXCLUDED.model_id,
         approval_id = EXCLUDED.approval_id,
         correlation_key = EXCLUDED.correlation_key,
         signal_type = EXCLUDED.signal_type,
         wake_at = EXCLUDED.wake_at,
         started_at = EXCLUDED.started_at,
         completed_at = EXCLUDED.completed_at,
         completed_by_signal_id = EXCLUDED.completed_by_signal_id,
         completed_by_approval_id = EXCLUDED.completed_by_approval_id,
         output_json = EXCLUDED.output_json,
         error_json = EXCLUDED.error_json,
         payload_json = EXCLUDED.payload_json,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      runNodeParams(next),
    );
    return rowToRunNode(rows[0]);
  }

  async listRunNodes(runId) {
    const values = [];
    const where = runId == null ? "" : "WHERE run_id = $1";
    if (runId != null) values.push(String(runId));
    const { rows } = await this.#query(
      `SELECT * FROM steward_run_nodes ${where}
       ORDER BY node_id ASC, iteration ASC`,
      values,
    );
    return rows.map(rowToRunNode);
  }

  async startAttempt(attempt = {}) {
    return this.#transaction(async (client) => {
      const iteration = normalizedIteration(attempt.iteration, 0);
      const attemptNumber =
        attempt.attempt == null
          ? await this.#nextAttemptNumber(
              client,
              attempt.runId,
              attempt.nodeId,
              iteration,
            )
          : positiveAttemptNumber(attempt.attempt);
      const id = attemptId({ ...attempt, attempt: attemptNumber });
      const existing = await this.#getAttemptRow(client, id);
      const now = new Date().toISOString();
      const next = {
        ...(existing ? rowToAttempt(existing) : null),
        ...attempt,
        id,
        iteration,
        attempt: attemptNumber,
        status: attempt.status ?? existing?.status ?? "running",
        ownerId: attempt.ownerId ?? existing?.owner_id ?? null,
        startedAt: existing
          ? iso(existing.started_at)
          : (attempt.startedAt ?? now),
        heartbeatAt:
          attempt.heartbeatAt ?? (existing ? iso(existing.heartbeat_at) : now),
        createdAt: existing
          ? iso(existing.created_at)
          : (attempt.createdAt ?? now),
        updatedAt: attempt.updatedAt ?? now,
      };
      await this.#ensureRunNode(client, next);
      const { rows } = await client.query(
        `INSERT INTO steward_attempts (
           id, run_id, node_id, iteration, attempt, status, owner_id,
           heartbeat_at, started_at, finished_at, available_at,
           recovered_from_owner_id, recovered_at, output_json, error_json,
           last_error, payload_json, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11,
           $12, $13, $14::jsonb, $15::jsonb,
           $16, $17::jsonb, $18, $19
         )
         ON CONFLICT (id) DO UPDATE SET
           run_id = EXCLUDED.run_id,
           node_id = EXCLUDED.node_id,
           iteration = EXCLUDED.iteration,
           attempt = EXCLUDED.attempt,
           status = EXCLUDED.status,
           owner_id = EXCLUDED.owner_id,
           heartbeat_at = EXCLUDED.heartbeat_at,
           started_at = EXCLUDED.started_at,
           finished_at = EXCLUDED.finished_at,
           available_at = EXCLUDED.available_at,
           recovered_from_owner_id = EXCLUDED.recovered_from_owner_id,
           recovered_at = EXCLUDED.recovered_at,
           output_json = EXCLUDED.output_json,
           error_json = EXCLUDED.error_json,
           last_error = EXCLUDED.last_error,
           payload_json = EXCLUDED.payload_json,
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        attemptParams(next),
      );
      return rowToAttempt(rows[0]);
    });
  }

  async getAttempt(id) {
    const { rows } = await this.#query(
      "SELECT * FROM steward_attempts WHERE id = $1",
      [String(id)],
    );
    return rows[0] ? rowToAttempt(rows[0]) : null;
  }

  async listAttempts({ runId, nodeId, status, ownerId } = {}) {
    const filters = buildFilters({
      run_id: runId,
      node_id: nodeId,
      status,
      owner_id: ownerId,
    });
    const { rows } = await this.#query(
      `SELECT * FROM steward_attempts ${filters.where}
       ORDER BY run_id ASC, node_id ASC, attempt ASC`,
      filters.values,
    );
    return rows.map(rowToAttempt);
  }

  async heartbeatAttempt(id, { ownerId, now = new Date().toISOString() } = {}) {
    const { rows } = await this.#query(
      `UPDATE steward_attempts
       SET status = CASE WHEN status = 'recovering' THEN 'running' ELSE status END,
           owner_id = COALESCE($2, owner_id),
           heartbeat_at = $3,
           payload_json = payload_json || $4::jsonb,
           updated_at = $3
       WHERE id = $1
         AND ($2::text IS NULL OR owner_id IS NULL OR owner_id = $2)
       RETURNING *`,
      [
        String(id),
        ownerId ?? null,
        now,
        jsonPayload({
          ownerId: ownerId ?? undefined,
          heartbeatAt: now,
          updatedAt: now,
        }),
      ],
    );
    return rows[0] ? rowToAttempt(rows[0]) : null;
  }

  async finishAttempt(id, { output, now = new Date().toISOString() } = {}) {
    const existing = await this.getAttempt(id);
    if (!existing) return null;
    const next = {
      ...existing,
      status: "succeeded",
      output: output ?? existing.output ?? null,
      lastError: null,
      finishedAt: now,
      updatedAt: now,
    };
    const { rows } = await this.#query(
      `UPDATE steward_attempts
       SET status = 'succeeded',
           output_json = $2::jsonb,
           error_json = '{}'::jsonb,
           last_error = NULL,
           finished_at = $3,
           payload_json = $4::jsonb,
           updated_at = $3
       WHERE id = $1
       RETURNING *`,
      [String(id), jsonPayload(next.output), now, jsonPayload(next)],
    );
    return rows[0] ? rowToAttempt(rows[0]) : null;
  }

  async failAttempt(
    id,
    { error, output, retryAfterMs, now = new Date().toISOString() } = {},
  ) {
    const existing = await this.getAttempt(id);
    if (!existing) return null;
    const lastError = serializeAttemptError(error);
    const availableAt = Number.isFinite(retryAfterMs)
      ? new Date(Date.parse(now) + retryAfterMs).toISOString()
      : (existing.availableAt ?? null);
    const next = {
      ...existing,
      status: "failed",
      output: output ?? existing.output ?? null,
      lastError,
      availableAt,
      finishedAt: now,
      updatedAt: now,
    };
    const { rows } = await this.#query(
      `UPDATE steward_attempts
       SET status = 'failed',
           output_json = $2::jsonb,
           error_json = $3::jsonb,
           last_error = $4,
           available_at = $5,
           finished_at = $6,
           payload_json = $7::jsonb,
           updated_at = $6
       WHERE id = $1
       RETURNING *`,
      [
        String(id),
        jsonPayload(next.output),
        jsonPayload(lastError),
        lastError.message,
        availableAt,
        now,
        jsonPayload(next),
      ],
    );
    return rows[0] ? rowToAttempt(rows[0]) : null;
  }

  async cancelAttempt(
    id,
    { reason, cancelledBy, now = new Date().toISOString() } = {},
  ) {
    const existing = await this.getAttempt(id);
    if (!existing) return null;
    const next = {
      ...existing,
      status: "cancelled",
      cancelReason: reason ?? null,
      cancelledBy: cancelledBy ?? null,
      finishedAt: now,
      updatedAt: now,
    };
    const { rows } = await this.#query(
      `UPDATE steward_attempts
       SET status = 'cancelled',
           finished_at = $2,
           payload_json = $3::jsonb,
           updated_at = $2
       WHERE id = $1
       RETURNING *`,
      [String(id), now, jsonPayload(next)],
    );
    return rows[0] ? rowToAttempt(rows[0]) : null;
  }

  async claimStaleAttempt({
    workerId = "merge-steward",
    now = new Date().toISOString(),
    staleAfterMs = 30 * 1000,
  } = {}) {
    return this.#transaction(async (client) => {
      const stale = await client.query(
        `SELECT *
         FROM steward_attempts
         WHERE status IN ('running', 'recovering')
           AND COALESCE(heartbeat_at, updated_at, started_at, created_at)
             < ($1::timestamptz - ($2::double precision * interval '1 millisecond'))
         ORDER BY COALESCE(heartbeat_at, started_at, updated_at, created_at) ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [now, staleAfterMs],
      );
      if (!stale.rows[0]) {
        return { claimed: false, reason: "no_stale_attempts" };
      }
      const existing = rowToAttempt(stale.rows[0]);
      const next = {
        ...existing,
        status: "recovering",
        ownerId: workerId,
        recoveredFromOwnerId: existing.ownerId ?? null,
        recoveredAt: now,
        heartbeatAt: now,
        updatedAt: now,
      };
      const { rows } = await client.query(
        `UPDATE steward_attempts
         SET status = 'recovering',
             owner_id = $2,
             recovered_from_owner_id = $3,
             recovered_at = $4,
             heartbeat_at = $4,
             payload_json = $5::jsonb,
             updated_at = $4
         WHERE id = $1
         RETURNING *`,
        [
          existing.id,
          workerId,
          existing.ownerId ?? null,
          now,
          jsonPayload(next),
        ],
      );
      return { claimed: true, attempt: rowToAttempt(rows[0]) };
    });
  }

  async appendRunEvent(event = {}) {
    if (!event.runId) {
      throw new TypeError("Run event requires runId");
    }
    return this.#transaction(async (client) => {
      const seq =
        event.seq == null
          ? await this.#nextRunEventSeq(client, event.runId)
          : positiveSequenceNumber(event.seq);
      const stored = {
        ...event,
        id: event.id ?? `${event.runId}:event:${seq}`,
        seq,
        createdAt: event.createdAt ?? new Date().toISOString(),
      };
      await this.#ensureQueueItemForId(stored.queueItemId, client);
      const { rows } = await client.query(
        `INSERT INTO steward_run_events (
           id, run_id, seq, type, queue_item_id, actor_kind, actor_id,
           payload_json, created_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8::jsonb, $9
         )
         ON CONFLICT (id) DO UPDATE SET
           type = EXCLUDED.type,
           queue_item_id = EXCLUDED.queue_item_id,
           actor_kind = EXCLUDED.actor_kind,
           actor_id = EXCLUDED.actor_id,
           payload_json = EXCLUDED.payload_json
         RETURNING *`,
        [
          stored.id,
          stored.runId,
          stored.seq,
          stored.type,
          stored.queueItemId ?? null,
          stored.actorKind ?? null,
          stored.actorId ?? null,
          jsonPayload(stored),
          stored.createdAt,
        ],
      );
      return rowToRunEvent(rows[0]);
    });
  }

  async listRunEvents(runId, { afterSeq } = {}) {
    const values = [];
    const clauses = [];
    if (runId != null) {
      values.push(String(runId));
      clauses.push(`run_id = $${values.length}`);
    }
    if (afterSeq != null) {
      values.push(Number(afterSeq));
      clauses.push(`seq > $${values.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const { rows } = await this.#query(
      `SELECT * FROM steward_run_events ${where}
       ORDER BY run_id ASC, seq ASC`,
      values,
    );
    return rows.map(rowToRunEvent);
  }

  async appendSignal(signal = {}) {
    if (!signal.runId && !signal.correlationKey) {
      throw new TypeError("Signal requires runId or correlationKey");
    }
    const stored = {
      ...signal,
      id:
        signal.id ??
        `signal:${signal.runId ?? signal.correlationKey}:${await this.#nextSignalNumber()}`,
      status: signal.status ?? "received",
      createdAt: signal.createdAt ?? new Date().toISOString(),
    };
    const { rows } = await this.#query(
      `INSERT INTO steward_signals (
         id, run_id, correlation_key, type, status, payload_json,
         consumed_by, consumed_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6::jsonb,
         $7, $8, $9, $10
       )
       ON CONFLICT (id) DO UPDATE SET
         run_id = EXCLUDED.run_id,
         correlation_key = EXCLUDED.correlation_key,
         type = EXCLUDED.type,
         status = EXCLUDED.status,
         payload_json = EXCLUDED.payload_json,
         consumed_by = EXCLUDED.consumed_by,
         consumed_at = EXCLUDED.consumed_at,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      signalParams(stored),
    );
    return rowToSignal(rows[0]);
  }

  async listSignals({ runId, correlationKey, type, status } = {}) {
    const filters = buildFilters({
      run_id: runId,
      correlation_key: correlationKey,
      type,
      status,
    });
    const { rows } = await this.#query(
      `SELECT * FROM steward_signals ${filters.where}
       ORDER BY created_at ASC`,
      filters.values,
    );
    return rows.map(rowToSignal);
  }

  async consumeSignal(id, { consumerId, now = new Date().toISOString() } = {}) {
    const { rows } = await this.#query(
      `UPDATE steward_signals
       SET status = 'consumed',
           consumed_by = $2,
           consumed_at = $3,
           payload_json = payload_json || $4::jsonb,
           updated_at = $3
       WHERE id = $1
       RETURNING *`,
      [
        String(id),
        consumerId ?? null,
        now,
        jsonPayload({
          status: "consumed",
          consumedBy: consumerId ?? null,
          consumedAt: now,
          updatedAt: now,
        }),
      ],
    );
    return rows[0] ? rowToSignal(rows[0]) : null;
  }

  async claimAgentWork(
    claim = {},
    { now = new Date().toISOString(), ttlMs = 30 * 60 * 1000 } = {},
  ) {
    return this.#transaction(async (client) => {
      validateAgentClaim(claim);
      const requestedId = agentClaimId(claim);
      const existingResult = await client.query(
        `SELECT * FROM steward_agent_claims
         WHERE id = $1
            OR (repo = $2 AND resource_kind = $3 AND resource_id = $4)
         FOR UPDATE`,
        [requestedId, claim.repo, claim.resourceKind, String(claim.resourceId)],
      );
      const existingClaims = existingResult.rows.map(rowToAgentClaim);
      const existingById =
        existingClaims.find((candidate) => candidate.id === requestedId) ??
        null;
      const existingByResource =
        existingClaims.find((candidate) =>
          sameAgentClaimResource(candidate, claim),
        ) ?? null;
      if (existingById && !sameAgentClaimResource(existingById, claim)) {
        return {
          claimed: false,
          reason: "claim_id_conflict",
          claim: existingById,
        };
      }
      const existing = existingByResource ?? existingById;
      const id = existing?.id ?? requestedId;

      if (
        existing?.status === "active" &&
        !isExpired(existing.expiresAt, now) &&
        existing.ownerAgentId !== claim.ownerAgentId
      ) {
        return {
          claimed: false,
          reason: "already_claimed",
          claim: existing,
        };
      }

      const expiresAt =
        claim.expiresAt ?? new Date(Date.parse(now) + ttlMs).toISOString();
      const next = {
        ...existing,
        ...claim,
        id,
        status: "active",
        claimedAt:
          existing?.ownerAgentId === claim.ownerAgentId
            ? (existing.claimedAt ?? now)
            : now,
        renewedAt: now,
        expiresAt,
        releasedAt: null,
        releaseReason: null,
        createdAt: existing?.createdAt ?? claim.createdAt ?? now,
        updatedAt: claim.updatedAt ?? now,
      };
      const { rows } = await client.query(
        `INSERT INTO steward_agent_claims (
           id, repo, resource_kind, resource_id, owner_agent_id, task_id,
           run_id, branch, paths_json, status, claimed_at, renewed_at,
           expires_at, released_at, release_reason, metadata_json, payload_json,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9::jsonb, $10, $11, $12,
           $13, $14, $15, $16::jsonb, $17::jsonb,
           $18, $19
         )
         ON CONFLICT (id) DO UPDATE SET
           repo = EXCLUDED.repo,
           resource_kind = EXCLUDED.resource_kind,
           resource_id = EXCLUDED.resource_id,
           owner_agent_id = EXCLUDED.owner_agent_id,
           task_id = EXCLUDED.task_id,
           run_id = EXCLUDED.run_id,
           branch = EXCLUDED.branch,
           paths_json = EXCLUDED.paths_json,
           status = EXCLUDED.status,
           claimed_at = EXCLUDED.claimed_at,
           renewed_at = EXCLUDED.renewed_at,
           expires_at = EXCLUDED.expires_at,
           released_at = EXCLUDED.released_at,
           release_reason = EXCLUDED.release_reason,
           metadata_json = EXCLUDED.metadata_json,
           payload_json = EXCLUDED.payload_json,
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        agentClaimParams(next),
      );
      return {
        claimed: true,
        claim: rowToAgentClaim(rows[0]),
      };
    });
  }

  async getAgentClaim(id) {
    const { rows } = await this.#query(
      "SELECT * FROM steward_agent_claims WHERE id = $1",
      [String(id)],
    );
    return rows[0] ? rowToAgentClaim(rows[0]) : null;
  }

  async listAgentClaims({ repo, ownerAgentId, resourceKind, status } = {}) {
    const filters = buildFilters({
      repo,
      owner_agent_id: ownerAgentId,
      resource_kind: resourceKind,
      status,
    });
    const { rows } = await this.#query(
      `SELECT * FROM steward_agent_claims ${filters.where}
       ORDER BY updated_at DESC, claimed_at DESC`,
      filters.values,
    );
    return rows.map(rowToAgentClaim);
  }

  async renewAgentClaim(
    id,
    {
      ownerAgentId,
      expiresAt,
      ttlMs = 30 * 60 * 1000,
      now = new Date().toISOString(),
    } = {},
  ) {
    const nextExpiresAt =
      expiresAt ?? new Date(Date.parse(now) + ttlMs).toISOString();
    const { rows } = await this.#query(
      `UPDATE steward_agent_claims
       SET renewed_at = $3,
           expires_at = $4,
           payload_json = payload_json || $5::jsonb,
           updated_at = $3
       WHERE id = $1
         AND status = 'active'
         AND ($2::text IS NULL OR owner_agent_id = $2)
       RETURNING *`,
      [
        String(id),
        ownerAgentId ?? null,
        now,
        nextExpiresAt,
        jsonPayload({
          renewedAt: now,
          expiresAt: nextExpiresAt,
          updatedAt: now,
        }),
      ],
    );
    return rows[0] ? rowToAgentClaim(rows[0]) : null;
  }

  async releaseAgentClaim(
    id,
    { ownerAgentId, reason, now = new Date().toISOString() } = {},
  ) {
    const { rows } = await this.#query(
      `UPDATE steward_agent_claims
       SET status = 'released',
           released_at = $3,
           release_reason = $4,
           payload_json = payload_json || $5::jsonb,
           updated_at = $3
       WHERE id = $1
         AND status = 'active'
         AND ($2::text IS NULL OR owner_agent_id = $2)
       RETURNING *`,
      [
        String(id),
        ownerAgentId ?? null,
        now,
        reason ?? null,
        jsonPayload({
          status: "released",
          releasedAt: now,
          releaseReason: reason ?? null,
          updatedAt: now,
        }),
      ],
    );
    return rows[0] ? rowToAgentClaim(rows[0]) : null;
  }

  async transferAgentClaim(
    id,
    {
      fromOwnerAgentId,
      toOwnerAgentId,
      reason,
      expiresAt,
      ttlMs = 30 * 60 * 1000,
      now = new Date().toISOString(),
    } = {},
  ) {
    if (!toOwnerAgentId) {
      throw new TypeError("Agent claim transfer requires toOwnerAgentId");
    }

    const nextExpiresAt =
      expiresAt ?? new Date(Date.parse(now) + ttlMs).toISOString();
    const { rows } = await this.#query(
      `UPDATE steward_agent_claims
       SET owner_agent_id = $3,
           claimed_at = $4,
           renewed_at = $4,
           expires_at = $5,
           released_at = NULL,
           release_reason = NULL,
           metadata_json = metadata_json || jsonb_build_object(
             'transferredFromAgentId', owner_agent_id,
             'transferredToAgentId', $3::text,
             'transferReason', $6::text,
             'transferredAt', $4::text,
             'handoffs', COALESCE(metadata_json->'handoffs', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
               'fromAgentId', owner_agent_id,
               'toAgentId', $3::text,
               'reason', $6::text,
               'transferredAt', $4::text
             ))
           ),
           payload_json = payload_json || $7::jsonb,
           updated_at = $4
       WHERE id = $1
         AND status = 'active'
         AND ($2::text IS NULL OR owner_agent_id = $2)
       RETURNING *`,
      [
        String(id),
        fromOwnerAgentId ?? null,
        String(toOwnerAgentId),
        now,
        nextExpiresAt,
        reason ?? null,
        jsonPayload({
          ownerAgentId: String(toOwnerAgentId),
          claimedAt: now,
          renewedAt: now,
          expiresAt: nextExpiresAt,
          releasedAt: null,
          releaseReason: null,
          metadata: {
            transferredFromAgentId: fromOwnerAgentId ?? null,
            transferredToAgentId: String(toOwnerAgentId),
            transferReason: reason ?? null,
            transferredAt: now,
          },
          updatedAt: now,
        }),
      ],
    );
    return rows[0] ? rowToAgentClaim(rows[0]) : null;
  }

  async claimWorkerLease(
    lease = {},
    { now = new Date().toISOString(), ttlMs = 30 * 1000 } = {},
  ) {
    return this.#transaction(async (client) => {
      validateWorkerLease(lease);
      const id = workerLeaseId(lease);
      const ownerId = String(lease.ownerId);
      const existingResult = await client.query(
        "SELECT * FROM steward_worker_leases WHERE id = $1 FOR UPDATE",
        [id],
      );
      const existing = existingResult.rows[0]
        ? rowToWorkerLease(existingResult.rows[0])
        : null;

      if (
        existing?.status === "active" &&
        !isExpired(existing.expiresAt, now) &&
        existing.ownerId !== ownerId
      ) {
        return {
          claimed: false,
          reason: "lease_held",
          lease: existing,
        };
      }

      const next = {
        ...existing,
        ...lease,
        id,
        ownerId,
        status: "active",
        acquiredAt:
          existing?.ownerId === ownerId && existing.status === "active"
            ? (existing.acquiredAt ?? now)
            : now,
        renewedAt: now,
        expiresAt:
          lease.expiresAt ?? new Date(Date.parse(now) + ttlMs).toISOString(),
        releasedAt: null,
        releaseReason: null,
        createdAt: existing?.createdAt ?? lease.createdAt ?? now,
        updatedAt: lease.updatedAt ?? now,
      };
      const { rows } = await client.query(
        `INSERT INTO steward_worker_leases (
           id, owner_id, status, acquired_at, renewed_at, expires_at,
           released_at, release_reason, metadata_json, payload_json,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9::jsonb, $10::jsonb,
           $11, $12
         )
         ON CONFLICT (id) DO UPDATE SET
           owner_id = EXCLUDED.owner_id,
           status = EXCLUDED.status,
           acquired_at = EXCLUDED.acquired_at,
           renewed_at = EXCLUDED.renewed_at,
           expires_at = EXCLUDED.expires_at,
           released_at = EXCLUDED.released_at,
           release_reason = EXCLUDED.release_reason,
           metadata_json = EXCLUDED.metadata_json,
           payload_json = EXCLUDED.payload_json,
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        workerLeaseParams(next),
      );
      return {
        claimed: true,
        lease: rowToWorkerLease(rows[0]),
      };
    });
  }

  async getWorkerLease(id) {
    const { rows } = await this.#query(
      "SELECT * FROM steward_worker_leases WHERE id = $1",
      [String(id)],
    );
    return rows[0] ? rowToWorkerLease(rows[0]) : null;
  }

  async listWorkerLeases({ ownerId, status } = {}) {
    const filters = buildFilters({ owner_id: ownerId, status });
    const { rows } = await this.#query(
      `SELECT * FROM steward_worker_leases ${filters.where}
       ORDER BY updated_at DESC, renewed_at DESC`,
      filters.values,
    );
    return rows.map(rowToWorkerLease);
  }

  async heartbeatWorkerLease(
    id,
    { ownerId, now = new Date().toISOString(), ttlMs = 30 * 1000 } = {},
  ) {
    const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
    const values = [String(id), now, expiresAt];
    let ownerFilter = "";
    if (ownerId) {
      values.push(String(ownerId));
      ownerFilter = `AND owner_id = $${values.length}`;
    }
    values.push(
      jsonPayload({
        renewedAt: now,
        expiresAt,
        updatedAt: now,
      }),
    );
    const payloadParam = `$${values.length}`;
    const { rows } = await this.#query(
      `UPDATE steward_worker_leases
       SET renewed_at = $2,
           expires_at = $3,
           payload_json = payload_json || ${payloadParam}::jsonb,
           updated_at = $2
       WHERE id = $1
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > $2::timestamptz)
         ${ownerFilter}
       RETURNING *`,
      values,
    );
    return rows[0] ? rowToWorkerLease(rows[0]) : null;
  }

  async releaseWorkerLease(
    id,
    { ownerId, reason, now = new Date().toISOString() } = {},
  ) {
    const values = [String(id), reason ?? null, now];
    let ownerFilter = "";
    if (ownerId) {
      values.push(String(ownerId));
      ownerFilter = `AND owner_id = $${values.length}`;
    }
    values.push(
      jsonPayload({
        status: "released",
        releaseReason: reason ?? null,
        releasedAt: now,
        updatedAt: now,
      }),
    );
    const payloadParam = `$${values.length}`;
    const { rows } = await this.#query(
      `UPDATE steward_worker_leases
       SET status = 'released',
           release_reason = $2,
           released_at = $3,
           payload_json = payload_json || ${payloadParam}::jsonb,
           updated_at = $3
       WHERE id = $1
         AND status = 'active'
         ${ownerFilter}
       RETURNING *`,
      values,
    );
    return rows[0] ? rowToWorkerLease(rows[0]) : null;
  }

  async upsertRepoPolicy(policy = {}) {
    const repo = repoPolicyId(policy);
    const existing = await this.getRepoPolicy(repo);
    const next = normalizeRepoPolicy(policy, existing);
    const { rows } = await this.#query(
      `INSERT INTO steward_repo_policies (
         repo, queue_mode, protected_branches, required_checks, trusted_actors,
         allow_forks, policy_json, created_at, updated_at
       ) VALUES (
         $1, $2, $3::jsonb, $4::jsonb, $5::jsonb,
         $6, $7::jsonb, $8, $9
       )
       ON CONFLICT (repo) DO UPDATE SET
         queue_mode = EXCLUDED.queue_mode,
         protected_branches = EXCLUDED.protected_branches,
         required_checks = EXCLUDED.required_checks,
         trusted_actors = EXCLUDED.trusted_actors,
         allow_forks = EXCLUDED.allow_forks,
         policy_json = EXCLUDED.policy_json,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      repoPolicyParams(next),
    );
    return rowToRepoPolicy(rows[0]);
  }

  async getRepoPolicy(repo) {
    if (!repo) return null;
    const { rows } = await this.#query(
      "SELECT * FROM steward_repo_policies WHERE repo = $1",
      [String(repo)],
    );
    return rows[0] ? rowToRepoPolicy(rows[0]) : null;
  }

  async listRepoPolicies() {
    const { rows } = await this.#query(
      `SELECT * FROM steward_repo_policies
       ORDER BY repo ASC`,
    );
    return rows.map(rowToRepoPolicy);
  }

  async upsertRegisteredAgent(
    agent = {},
    { registeredBy, now = new Date().toISOString() } = {},
  ) {
    const id = registeredAgentId(agent);
    const existing = await this.getRegisteredAgent(id);
    const next = normalizeRegisteredAgent(agent, existing, {
      registeredBy,
      now,
    });
    const { rows } = await this.#query(
      `INSERT INTO steward_registered_agents (
         id, status, display_name, forgejo_username, eliza_cloud_subject,
         tenant_id, source, registered_by, registered_at, disabled_by,
         disabled_at, disable_reason, metadata_json, payload_json,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9, $10,
         $11, $12, $13::jsonb, $14::jsonb,
         $15, $16
       )
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         display_name = EXCLUDED.display_name,
         forgejo_username = EXCLUDED.forgejo_username,
         eliza_cloud_subject = EXCLUDED.eliza_cloud_subject,
         tenant_id = EXCLUDED.tenant_id,
         source = EXCLUDED.source,
         registered_by = EXCLUDED.registered_by,
         disabled_by = EXCLUDED.disabled_by,
         disabled_at = EXCLUDED.disabled_at,
         disable_reason = EXCLUDED.disable_reason,
         metadata_json = EXCLUDED.metadata_json,
         payload_json = EXCLUDED.payload_json,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      registeredAgentParams(next),
    );
    return rowToRegisteredAgent(rows[0]);
  }

  async getRegisteredAgent(id) {
    if (!id) return null;
    const { rows } = await this.#query(
      "SELECT * FROM steward_registered_agents WHERE id = $1",
      [String(id)],
    );
    return rows[0] ? rowToRegisteredAgent(rows[0]) : null;
  }

  async listRegisteredAgents({ status, tenantId, source } = {}) {
    const filters = buildFilters({
      status,
      tenant_id: tenantId,
      source,
    });
    const { rows } = await this.#query(
      `SELECT * FROM steward_registered_agents ${filters.where}
       ORDER BY id ASC`,
      filters.values,
    );
    return rows.map(rowToRegisteredAgent);
  }

  async disableRegisteredAgent(
    id,
    { disabledBy, reason, now = new Date().toISOString() } = {},
  ) {
    const { rows } = await this.#query(
      `UPDATE steward_registered_agents
       SET status = 'disabled',
           disabled_by = $2,
           disabled_at = $3,
           disable_reason = $4,
           payload_json = payload_json || $5::jsonb,
           updated_at = $3
       WHERE id = $1
       RETURNING *`,
      [
        String(id),
        disabledBy ?? null,
        now,
        reason ?? null,
        jsonPayload({
          status: "disabled",
          disabledBy: disabledBy ?? null,
          disabledAt: now,
          disableReason: reason ?? null,
          updatedAt: now,
        }),
      ],
    );
    return rows[0] ? rowToRegisteredAgent(rows[0]) : null;
  }

  async appendEvent(event = {}) {
    const stored = {
      ...event,
      receivedAt: event.receivedAt ?? new Date().toISOString(),
    };
    const { rows } = await this.#query(
      `INSERT INTO steward_events (
         delivery_id, type, repo, pull_request_id, payload_hash, payload_json, received_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6::jsonb, $7
       )
       RETURNING *`,
      [
        stored.deliveryId ?? null,
        stored.type ?? null,
        stored.repo ?? null,
        intOrNull(stored.pullRequestId),
        payloadHash(stored),
        jsonPayload(stored),
        stored.receivedAt,
      ],
    );
    return rowToEvent(rows[0]);
  }

  async findEventByDeliveryId(deliveryId) {
    if (!deliveryId) return null;
    const { rows } = await this.#query(
      "SELECT * FROM steward_events WHERE delivery_id = $1 ORDER BY received_at ASC LIMIT 1",
      [String(deliveryId)],
    );
    return rows[0] ? rowToEvent(rows[0]) : null;
  }

  async listEvents() {
    const { rows } = await this.#query(
      "SELECT * FROM steward_events ORDER BY received_at ASC, id ASC",
    );
    return rows.map(rowToEvent);
  }

  async #query(text, values = []) {
    return this.#pool.query(text, values);
  }

  async #transaction(callback) {
    if (typeof this.#pool.connect !== "function") {
      return callback(this.#pool);
    }
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      // error-policy:J6 transaction teardown: roll back, then rethrow the
      // original error
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release?.();
    }
  }

  async #getQueueItemRow(client, id) {
    const { rows } = await client.query(
      "SELECT * FROM steward_queue_items WHERE id = $1",
      [String(id)],
    );
    return rows[0] ?? null;
  }

  async #insertQueueCandidate(client, candidate) {
    const id = queueItemId(candidate);
    const now = new Date().toISOString();
    const next = {
      ...candidate,
      id,
      createdAt: candidate.createdAt ?? now,
      updatedAt: candidate.updatedAt ?? now,
    };
    await client.query(
      `INSERT INTO steward_queue_items (
         id, repo, pull_request_id, source_branch, target_branch, head_sha,
         queue_state, priority, risk_score, conflict_score, author_kind,
         owner_agent_id, task_id, labels, changed_files, affected_paths,
         affected_packages, required_checks, check_results, policy_snapshot,
         claim_owner_id, claimed_at, attempt_count, available_at, finished_at,
         last_error, payload_json, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         $12, $13, $14::jsonb, $15::jsonb, $16::jsonb,
         $17::jsonb, $18::jsonb, $19::jsonb, $20::jsonb,
         $21, $22, $23, $24, $25,
         $26, $27::jsonb, $28, $29
       )
       ON CONFLICT (id) DO NOTHING`,
      queueItemParams(next),
    );
  }

  async #lockQueueLane(client, item) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [item.repo ?? "", item.targetBranch ?? ""],
    );
  }

  async #laneHasActiveItem(client, item, excludedIds = [item.id]) {
    const { rows } = await client.query(
      `SELECT 1
       FROM steward_queue_items
       WHERE repo = $1
         AND target_branch = $2
         AND queue_state IN ('running', 'building_integration')
         AND NOT (id = ANY($3::text[]))
       LIMIT 1`,
      [item.repo ?? "", item.targetBranch ?? "", excludedIds],
    );
    return rows.length > 0;
  }

  async #ensureQueueItemForId(id, client = this.#pool) {
    const parsed = parseQueueItemId(id);
    if (!parsed) return;
    await client.query(
      `INSERT INTO steward_queue_items (
         id, repo, pull_request_id, target_branch, payload_json
       ) VALUES (
         $1, $2, $3, '', $4::jsonb
       )
       ON CONFLICT (id) DO NOTHING`,
      [parsed.id, parsed.repo, parsed.pullRequestId, jsonPayload(parsed)],
    );
  }

  async #getRunNode(id) {
    const { rows } = await this.#query(
      "SELECT * FROM steward_run_nodes WHERE id = $1",
      [String(id)],
    );
    return rows[0] ? rowToRunNode(rows[0]) : null;
  }

  async #ensureRunNode(client, attempt) {
    const iteration = normalizedIteration(attempt.iteration, 0);
    const id = runNodeId({
      runId: attempt.runId,
      nodeId: attempt.nodeId,
      iteration,
    });
    await client.query(
      `INSERT INTO steward_run_nodes (
         id, run_id, node_id, iteration, status, payload_json
       ) VALUES (
         $1, $2, $3, $4, 'pending', $5::jsonb
       )
       ON CONFLICT (id) DO NOTHING`,
      [
        id,
        attempt.runId,
        attempt.nodeId,
        iteration,
        jsonPayload({
          id,
          runId: attempt.runId,
          nodeId: attempt.nodeId,
          iteration,
          status: "pending",
        }),
      ],
    );
  }

  async #getAttemptRow(client, id) {
    const { rows } = await client.query(
      "SELECT * FROM steward_attempts WHERE id = $1",
      [String(id)],
    );
    return rows[0] ?? null;
  }

  async #nextAttemptNumber(client, runId, nodeId, iteration) {
    if (!runId || !nodeId) {
      throw new TypeError("Attempt requires runId and nodeId");
    }
    const { rows } = await client.query(
      `SELECT COALESCE(MAX(attempt), 0) + 1 AS next_attempt
       FROM steward_attempts
       WHERE run_id = $1 AND node_id = $2 AND iteration = $3`,
      [runId, nodeId, iteration],
    );
    return Number(rows[0]?.next_attempt ?? 1);
  }

  async #nextRunEventSeq(client, runId) {
    const { rows } = await client.query(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
       FROM steward_run_events
       WHERE run_id = $1`,
      [runId],
    );
    return Number(rows[0]?.next_seq ?? 1);
  }

  async #nextSignalNumber() {
    const { rows } = await this.#query(
      "SELECT COUNT(*) + 1 AS next_signal FROM steward_signals",
    );
    return Number(rows[0]?.next_signal ?? 1);
  }
}

function queueItemParams(item) {
  return [
    item.id,
    item.repo ?? "",
    intOrNull(item.pullRequestId),
    item.sourceBranch ?? null,
    item.targetBranch ?? "",
    item.headSha ?? null,
    item.queueState ?? "observed",
    intOrZero(item.priority),
    intOrZero(item.riskScore),
    intOrZero(item.conflictScore),
    item.authorKind ?? null,
    item.ownerAgentId ?? null,
    item.taskId ?? null,
    jsonPayload(arrayValue(item.labels)),
    jsonPayload(arrayValue(item.changedFiles)),
    jsonPayload(arrayValue(item.affectedPaths)),
    jsonPayload(arrayValue(item.affectedPackages)),
    jsonPayload(arrayValue(item.requiredChecks)),
    jsonPayload(item.checkResults ?? {}),
    jsonPayload(item.policySnapshot ?? {}),
    item.claimedBy ?? null,
    item.claimedAt ?? null,
    intOrZero(item.attemptCount),
    item.availableAt ?? null,
    item.finishedAt ?? null,
    item.lastError == null ? null : String(item.lastError),
    jsonPayload(item),
    item.createdAt ?? new Date().toISOString(),
    item.updatedAt ?? new Date().toISOString(),
  ];
}

function queueItemScopeKey(item = {}) {
  return `${item.repo ?? ""}:${item.targetBranch ?? ""}`;
}

function approvalParams(approval) {
  return [
    approval.id,
    approval.runId ?? null,
    approval.queueItemId ?? null,
    approval.nodeId ?? "human_approval",
    normalizedIteration(approval.iteration, 0),
    approval.status ?? "requested",
    jsonPayload(approval.request ?? {}),
    jsonPayload(arrayValue(approval.allowedActors)),
    jsonPayload(approval.decision ?? {}),
    approval.requestedBy ?? null,
    approval.decidedBy ?? null,
    approval.requestedAt ?? new Date().toISOString(),
    approval.decidedAt ?? null,
    jsonPayload(approval),
    approval.createdAt ?? new Date().toISOString(),
    approval.updatedAt ?? new Date().toISOString(),
  ];
}

function humanRequestParams(request) {
  return [
    request.id,
    request.runId,
    request.nodeId ?? "human_input",
    normalizedIteration(request.iteration, 0),
    request.kind ?? "confirm",
    request.status ?? "requested",
    request.prompt ?? null,
    jsonPayload(arrayValue(request.options)),
    jsonPayload(request.response ?? {}),
    request.requestedBy ?? null,
    request.respondedBy ?? null,
    request.requestedAt ?? new Date().toISOString(),
    request.respondedAt ?? null,
    jsonPayload(request),
    request.createdAt ?? new Date().toISOString(),
    request.updatedAt ?? new Date().toISOString(),
  ];
}

function workItemParams(item) {
  return [
    item.id,
    item.repo,
    item.kind ?? "task",
    item.state ?? "ready",
    item.title,
    item.summary ?? null,
    intOrZero(item.priority),
    item.ownerAgentId ?? null,
    item.taskId ?? null,
    item.issueId ?? null,
    intOrNull(item.pullRequestId),
    item.cycleId ?? null,
    item.moduleId ?? null,
    item.sourceUrl ?? null,
    item.targetBranch ?? null,
    jsonPayload(arrayValue(item.paths)),
    jsonPayload(arrayValue(item.packages)),
    jsonPayload(arrayValue(item.labels)),
    jsonPayload(item.metadata ?? {}),
    item.createdBy ?? null,
    item.updatedBy ?? null,
    item.claimedAt ?? null,
    item.completedAt ?? null,
    jsonPayload(item),
    item.createdAt ?? new Date().toISOString(),
    item.updatedAt ?? new Date().toISOString(),
  ];
}

function workCycleParams(cycle) {
  return [
    cycle.id,
    cycle.repo,
    cycle.state ?? "planned",
    cycle.title,
    cycle.summary ?? null,
    cycle.ownerAgentId ?? null,
    cycle.startAt ?? null,
    cycle.endAt ?? null,
    jsonPayload(cycle.metadata ?? {}),
    cycle.createdBy ?? null,
    cycle.updatedBy ?? null,
    jsonPayload(cycle),
    cycle.createdAt ?? new Date().toISOString(),
    cycle.updatedAt ?? new Date().toISOString(),
  ];
}

function workModuleParams(module) {
  return [
    module.id,
    module.repo,
    module.state ?? "active",
    module.title,
    module.summary ?? null,
    module.ownerAgentId ?? null,
    jsonPayload(arrayValue(module.paths)),
    jsonPayload(arrayValue(module.packages)),
    jsonPayload(arrayValue(module.labels)),
    jsonPayload(module.metadata ?? {}),
    module.createdBy ?? null,
    module.updatedBy ?? null,
    jsonPayload(module),
    module.createdAt ?? new Date().toISOString(),
    module.updatedAt ?? new Date().toISOString(),
  ];
}

function workViewParams(view) {
  return [
    view.id,
    view.repo ?? null,
    view.kind ?? "list",
    view.state ?? "active",
    view.title,
    view.summary ?? null,
    view.ownerAgentId ?? null,
    view.query ?? null,
    jsonPayload(view.filters ?? {}),
    jsonPayload(view.layout ?? {}),
    jsonPayload(arrayValue(view.columns)),
    view.visibility ?? "private",
    jsonPayload(view.metadata ?? {}),
    view.createdBy ?? null,
    view.updatedBy ?? null,
    jsonPayload(view),
    view.createdAt ?? new Date().toISOString(),
    view.updatedAt ?? new Date().toISOString(),
  ];
}

function workPageParams(page) {
  return [
    page.id,
    page.repo,
    page.kind ?? "note",
    page.state ?? "active",
    page.title,
    page.summary ?? null,
    page.body ?? null,
    page.format ?? "markdown",
    page.ownerAgentId ?? null,
    page.workItemId ?? null,
    page.cycleId ?? null,
    page.moduleId ?? null,
    page.taskId ?? null,
    page.issueId ?? null,
    intOrNull(page.pullRequestId),
    page.sourceUrl ?? null,
    jsonPayload(arrayValue(page.tags)),
    page.visibility ?? "private",
    jsonPayload(page.metadata ?? {}),
    page.createdBy ?? null,
    page.updatedBy ?? null,
    jsonPayload(page),
    page.createdAt ?? new Date().toISOString(),
    page.updatedAt ?? new Date().toISOString(),
  ];
}

function runParams(run) {
  return [
    run.id,
    run.repo ?? null,
    run.queueItemId ?? null,
    intOrNull(run.pullRequestId),
    run.sourceBranch ?? null,
    run.targetBranch ?? null,
    run.ownerKind ?? null,
    run.ownerId ?? null,
    run.status ?? "running",
    run.runtimeOwnerId ?? null,
    run.heartbeatAt ?? null,
    run.correlationKey ?? null,
    run.startedAt ?? null,
    run.finishedAt ?? null,
    run.resumedBySignalId ?? null,
    run.resumedByApprovalId ?? null,
    run.lastError == null ? null : String(run.lastError),
    jsonPayload(run.summary ?? run.summaryJson ?? {}),
    jsonPayload(run),
    run.createdAt ?? new Date().toISOString(),
    run.updatedAt ?? new Date().toISOString(),
  ];
}

function runNodeParams(node) {
  return [
    node.id,
    node.runId,
    node.nodeId,
    normalizedIteration(node.iteration, 0),
    node.status ?? "pending",
    node.agentId ?? null,
    node.modelId ?? null,
    node.approvalId ?? null,
    node.correlationKey ?? null,
    node.signalType ?? null,
    node.wakeAt ?? null,
    node.startedAt ?? null,
    node.completedAt ?? null,
    node.completedBySignalId ?? null,
    node.completedByApprovalId ?? null,
    jsonPayload(node.output ?? {}),
    jsonPayload(node.error ?? {}),
    jsonPayload(node),
    node.createdAt ?? new Date().toISOString(),
    node.updatedAt ?? new Date().toISOString(),
  ];
}

function attemptParams(attempt) {
  const lastError =
    attempt.lastError == null ? null : serializeAttemptError(attempt.lastError);
  return [
    attempt.id,
    attempt.runId,
    attempt.nodeId,
    normalizedIteration(attempt.iteration, 0),
    positiveAttemptNumber(attempt.attempt),
    attempt.status ?? "running",
    attempt.ownerId ?? null,
    attempt.heartbeatAt ?? null,
    attempt.startedAt ?? new Date().toISOString(),
    attempt.finishedAt ?? null,
    attempt.availableAt ?? null,
    attempt.recoveredFromOwnerId ?? null,
    attempt.recoveredAt ?? null,
    jsonPayload(attempt.output ?? {}),
    jsonPayload(lastError ?? {}),
    lastError?.message ?? null,
    jsonPayload(attempt),
    attempt.createdAt ?? new Date().toISOString(),
    attempt.updatedAt ?? new Date().toISOString(),
  ];
}

function signalParams(signal) {
  return [
    signal.id,
    signal.runId ?? null,
    signal.correlationKey ?? null,
    signal.type ?? null,
    signal.status ?? "received",
    jsonPayload(signal),
    signal.consumedBy ?? null,
    signal.consumedAt ?? null,
    signal.createdAt ?? new Date().toISOString(),
    signal.updatedAt ?? signal.createdAt ?? new Date().toISOString(),
  ];
}

function agentClaimParams(claim) {
  return [
    claim.id,
    claim.repo,
    claim.resourceKind,
    String(claim.resourceId),
    claim.ownerAgentId,
    claim.taskId ?? null,
    claim.runId ?? null,
    claim.branch ?? null,
    jsonPayload(arrayValue(claim.paths)),
    claim.status ?? "active",
    claim.claimedAt ?? new Date().toISOString(),
    claim.renewedAt ?? new Date().toISOString(),
    claim.expiresAt ?? null,
    claim.releasedAt ?? null,
    claim.releaseReason ?? null,
    jsonPayload(claim.metadata ?? {}),
    jsonPayload(claim),
    claim.createdAt ?? new Date().toISOString(),
    claim.updatedAt ?? new Date().toISOString(),
  ];
}

function workerLeaseParams(lease) {
  return [
    lease.id,
    lease.ownerId,
    lease.status ?? "active",
    lease.acquiredAt ?? new Date().toISOString(),
    lease.renewedAt ?? new Date().toISOString(),
    lease.expiresAt ?? null,
    lease.releasedAt ?? null,
    lease.releaseReason ?? null,
    jsonPayload(lease.metadata ?? {}),
    jsonPayload(lease),
    lease.createdAt ?? new Date().toISOString(),
    lease.updatedAt ?? new Date().toISOString(),
  ];
}

function repoPolicyParams(policy) {
  return [
    policy.repo,
    policy.queueMode,
    jsonPayload(arrayValue(policy.protectedBranches)),
    jsonPayload(arrayValue(policy.requiredChecks)),
    jsonPayload(arrayValue(policy.trustedActors)),
    policy.allowForks === true,
    jsonPayload(policy.policy ?? {}),
    policy.createdAt ?? new Date().toISOString(),
    policy.updatedAt ?? new Date().toISOString(),
  ];
}

function registeredAgentParams(agent) {
  return [
    agent.id,
    agent.status ?? "active",
    agent.displayName ?? null,
    agent.forgejoUsername ?? null,
    agent.elizaCloudSubject ?? null,
    agent.tenantId ?? null,
    agent.source ?? "steward",
    agent.registeredBy ?? null,
    agent.registeredAt ?? new Date().toISOString(),
    agent.disabledBy ?? null,
    agent.disabledAt ?? null,
    agent.disableReason ?? null,
    jsonPayload(agent.metadata ?? {}),
    jsonPayload(agent),
    agent.createdAt ?? new Date().toISOString(),
    agent.updatedAt ?? new Date().toISOString(),
  ];
}

function rowToQueueItem(row) {
  const payload = jsonObject(row.payload_json);
  return dropUndefined({
    ...payload,
    id: row.id,
    repo: row.repo,
    pullRequestId: row.pull_request_id,
    sourceBranch: row.source_branch ?? payload.sourceBranch,
    targetBranch: row.target_branch ?? payload.targetBranch,
    headSha: row.head_sha ?? payload.headSha,
    queueState: row.queue_state,
    priority: row.priority,
    riskScore: row.risk_score,
    conflictScore: row.conflict_score,
    authorKind: row.author_kind ?? payload.authorKind,
    ownerAgentId: row.owner_agent_id ?? payload.ownerAgentId,
    taskId: row.task_id ?? payload.taskId,
    labels: jsonArray(row.labels, payload.labels),
    changedFiles: jsonArray(row.changed_files, payload.changedFiles),
    affectedPaths: jsonArray(row.affected_paths, payload.affectedPaths),
    affectedPackages: jsonArray(
      row.affected_packages,
      payload.affectedPackages,
    ),
    requiredChecks: jsonArray(row.required_checks, payload.requiredChecks),
    checkResults: jsonObject(row.check_results, payload.checkResults),
    policySnapshot: jsonObject(row.policy_snapshot, payload.policySnapshot),
    claimedBy: row.claim_owner_id ?? payload.claimedBy,
    claimedAt: iso(row.claimed_at) ?? payload.claimedAt,
    attemptCount: row.attempt_count,
    availableAt: iso(row.available_at) ?? payload.availableAt,
    finishedAt: iso(row.finished_at) ?? payload.finishedAt,
    lastError: row.last_error ?? payload.lastError,
    createdAt: iso(row.created_at) ?? payload.createdAt,
    updatedAt: iso(row.updated_at) ?? payload.updatedAt,
  });
}

function rowToApproval(row) {
  const payload = jsonObject(row.payload_json);
  return dropUndefined({
    ...payload,
    id: row.id,
    runId: row.run_id ?? payload.runId,
    queueItemId: row.queue_item_id ?? payload.queueItemId,
    nodeId: row.node_id,
    iteration: row.iteration,
    status: row.status,
    request: jsonObject(row.request_json, payload.request),
    allowedActors: jsonArray(row.allowed_actors_json, payload.allowedActors),
    decision: jsonObject(row.decision_json, payload.decision),
    requestedBy: row.requested_by ?? payload.requestedBy,
    decidedBy: row.decided_by ?? payload.decidedBy,
    requestedAt: iso(row.requested_at) ?? payload.requestedAt,
    decidedAt: iso(row.decided_at) ?? payload.decidedAt,
    createdAt: iso(row.created_at) ?? payload.createdAt,
    updatedAt: iso(row.updated_at) ?? payload.updatedAt,
  });
}

function rowToHumanRequest(row) {
  const payload = jsonObject(row.payload_json);
  return dropUndefined({
    ...payload,
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    iteration: row.iteration,
    kind: row.kind,
    status: row.status,
    prompt: row.prompt ?? payload.prompt,
    options: jsonArray(row.options_json, payload.options),
    response: jsonValue(row.response_json, payload.response),
    requestedBy: row.requested_by ?? payload.requestedBy,
    respondedBy: row.responded_by ?? payload.respondedBy,
    requestedAt: iso(row.requested_at) ?? payload.requestedAt,
    respondedAt: iso(row.responded_at) ?? payload.respondedAt,
    createdAt: iso(row.created_at) ?? payload.createdAt,
    updatedAt: iso(row.updated_at) ?? payload.updatedAt,
  });
}

function rowToWorkItem(row) {
  const payload = jsonObject(row.payload_json);
  return dropUndefined({
    ...payload,
    id: row.id,
    repo: row.repo,
    kind: row.kind,
    state: row.state,
    title: row.title,
    summary: row.summary ?? payload.summary,
    priority: row.priority,
    ownerAgentId: row.owner_agent_id ?? payload.ownerAgentId,
    taskId: row.task_id ?? payload.taskId,
    issueId: row.issue_id ?? payload.issueId,
    pullRequestId: row.pull_request_id ?? payload.pullRequestId,
    cycleId: row.cycle_id ?? payload.cycleId,
    moduleId: row.module_id ?? payload.moduleId,
    sourceUrl: row.source_url ?? payload.sourceUrl,
    targetBranch: row.target_branch ?? payload.targetBranch,
    paths: jsonArray(row.paths_json, payload.paths),
    packages: jsonArray(row.packages_json, payload.packages),
    labels: jsonArray(row.labels_json, payload.labels),
    metadata: jsonObject(row.metadata_json, payload.metadata),
    createdBy: row.created_by ?? payload.createdBy,
    updatedBy: row.updated_by ?? payload.updatedBy,
    claimedAt: iso(row.claimed_at) ?? payload.claimedAt,
    completedAt: iso(row.completed_at) ?? payload.completedAt,
    createdAt: iso(row.created_at) ?? payload.createdAt,
    updatedAt: iso(row.updated_at) ?? payload.updatedAt,
  });
}

function rowToWorkCycle(row) {
  const payload = jsonObject(row.payload_json);
  return dropUndefined({
    ...payload,
    id: row.id,
    repo: row.repo,
    state: row.state,
    title: row.title,
    summary: row.summary ?? payload.summary,
    ownerAgentId: row.owner_agent_id ?? payload.ownerAgentId,
    startAt: iso(row.start_at) ?? payload.startAt,
    endAt: iso(row.end_at) ?? payload.endAt,
    metadata: jsonObject(row.metadata_json, payload.metadata),
    createdBy: row.created_by ?? payload.createdBy,
    updatedBy: row.updated_by ?? payload.updatedBy,
    createdAt: iso(row.created_at) ?? payload.createdAt,
    updatedAt: iso(row.updated_at) ?? payload.updatedAt,
  });
}

function rowToWorkModule(row) {
  const payload = jsonObject(row.payload_json);
  return dropUndefined({
    ...payload,
    id: row.id,
    repo: row.repo,
    state: row.state,
    title: row.title,
    summary: row.summary ?? payload.summary,
    ownerAgentId: row.owner_agent_id ?? payload.ownerAgentId,
    paths: jsonArray(row.paths_json, payload.paths),
    packages: jsonArray(row.packages_json, payload.packages),
    labels: jsonArray(row.labels_json, payload.labels),
    metadata: jsonObject(row.metadata_json, payload.metadata),
    createdBy: row.created_by ?? payload.createdBy,
    updatedBy: row.updated_by ?? payload.updatedBy,
    createdAt: iso(row.created_at) ?? payload.createdAt,
    updatedAt: iso(row.updated_at) ?? payload.updatedAt,
  });
}

function rowToWorkView(row) {
  const payload = jsonObject(row.payload_json);
  return dropUndefined({
    ...payload,
    id: row.id,
    repo: row.repo ?? payload.repo,
    kind: row.kind,
    state: row.state,
    title: row.title,
    summary: row.summary ?? payload.summary,
    ownerAgentId: row.owner_agent_id ?? payload.ownerAgentId,
    query: row.query_text ?? payload.query,
    filters: jsonObject(row.filters_json, payload.filters),
    layout: jsonObject(row.layout_json, payload.layout),
    columns: jsonArray(row.columns_json, payload.columns),
    visibility: row.visibility ?? payload.visibility,
    metadata: jsonObject(row.metadata_json, payload.metadata),
    createdBy: row.created_by ?? payload.createdBy,
    updatedBy: row.updated_by ?? payload.updatedBy,
    createdAt: iso(row.created_at) ?? payload.createdAt,
    updatedAt: iso(row.updated_at) ?? payload.updatedAt,
  });
}

function rowToWorkPage(row) {
  const payload = jsonObject(row.payload_json);
  return dropUndefined({
    ...payload,
    id: row.id,
    repo: row.repo,
    kind: row.kind,
    state: row.state,
    title: row.title,
    summary: row.summary ?? payload.summary,
    body: row.body_text ?? payload.body,
    format: row.body_format ?? payload.format,
    ownerAgentId: row.owner_agent_id ?? payload.ownerAgentId,
    workItemId: row.work_item_id ?? payload.workItemId,
    cycleId: row.cycle_id ?? payload.cycleId,
    moduleId: row.module_id ?? payload.moduleId,
    taskId: row.task_id ?? payload.taskId,
    issueId: row.issue_id ?? payload.issueId,
    pullRequestId: row.pull_request_id ?? payload.pullRequestId,
    sourceUrl: row.source_url ?? payload.sourceUrl,
    tags: jsonArray(row.tags_json, payload.tags),
    visibility: row.visibility ?? payload.visibility,
    metadata: jsonObject(row.metadata_json, payload.metadata),
    createdBy: row.created_by ?? payload.createdBy,
    updatedBy: row.updated_by ?? payload.updatedBy,
    createdAt: iso(row.created_at) ?? payload.createdAt,
    updatedAt: iso(row.updated_at) ?? payload.updatedAt,
  });
}

function rowToRun(row) {
  const payload = jsonObject(row.payload_json);
  return dropUndefined({
    ...payload,
    id: row.id,
    repo: row.repo ?? payload.repo,
    queueItemId: row.queue_item_id ?? payload.queueItemId,
    pullRequestId: row.pull_request_id ?? payload.pullRequestId,
    sourceBranch: row.source_branch ?? payload.sourceBranch,
    targetBranch: row.target_branch ?? payload.targetBranch,
    ownerKind: row.owner_kind ?? payload.ownerKind,
    ownerId: row.owner_id ?? payload.ownerId,
    status: row.status,
    runtimeOwnerId: row.runtime_owner_id ?? payload.runtimeOwnerId,
    heartbeatAt: iso(row.heartbeat_at) ?? payload.heartbeatAt,
    correlationKey: row.correlation_key ?? payload.correlationKey,
    startedAt: iso(row.started_at) ?? payload.startedAt,
    finishedAt: iso(row.finished_at) ?? payload.finishedAt,
    resumedBySignalId: row.resumed_by_signal_id ?? payload.resumedBySignalId,
    resumedByApprovalId:
      row.resumed_by_approval_id ?? payload.resumedByApprovalId,
    lastError: row.last_error ?? payload.lastError,
    summary: jsonObject(row.summary_json, payload.summary),
    createdAt: iso(row.created_at) ?? payload.createdAt,
    updatedAt: iso(row.updated_at) ?? payload.updatedAt,
  });
}

function rowToRunNode(row) {
  const payload = jsonObject(row.payload_json);
  return dropUndefined({
    ...payload,
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    iteration: row.iteration,
    status: row.status,
    agentId: row.agent_id ?? payload.agentId,
    modelId: row.model_id ?? payload.modelId,
    approvalId: row.approval_id ?? payload.approvalId,
    correlationKey: row.correlation_key ?? payload.correlationKey,
    signalType: row.signal_type ?? payload.signalType,
    wakeAt: iso(row.wake_at) ?? payload.wakeAt,
    startedAt: iso(row.started_at) ?? payload.startedAt,
    completedAt: iso(row.completed_at) ?? payload.completedAt,
    completedBySignalId:
      row.completed_by_signal_id ?? payload.completedBySignalId,
    completedByApprovalId:
      row.completed_by_approval_id ?? payload.completedByApprovalId,
    output: jsonValue(row.output_json, payload.output),
    error: jsonObject(row.error_json, payload.error),
    createdAt: iso(row.created_at) ?? payload.createdAt,
    updatedAt: iso(row.updated_at) ?? payload.updatedAt,
  });
}

function rowToAttempt(row) {
  const payload = jsonObject(row.payload_json);
  const error = jsonObject(row.error_json, payload.lastError);
  return dropUndefined({
    ...payload,
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    iteration: row.iteration,
    attempt: row.attempt,
    status: row.status,
    ownerId: row.owner_id ?? payload.ownerId,
    heartbeatAt: iso(row.heartbeat_at) ?? payload.heartbeatAt,
    startedAt: iso(row.started_at) ?? payload.startedAt,
    finishedAt: iso(row.finished_at) ?? payload.finishedAt,
    availableAt: iso(row.available_at) ?? payload.availableAt,
    recoveredFromOwnerId:
      row.recovered_from_owner_id ?? payload.recoveredFromOwnerId,
    recoveredAt: iso(row.recovered_at) ?? payload.recoveredAt,
    output: jsonValue(row.output_json, payload.output),
    lastError: Object.keys(error).length
      ? error
      : (row.last_error ?? payload.lastError),
    createdAt: iso(row.created_at) ?? payload.createdAt,
    updatedAt: iso(row.updated_at) ?? payload.updatedAt,
  });
}

function rowToRunEvent(row) {
  const payload = jsonObject(row.payload_json);
  return dropUndefined({
    ...payload,
    id: row.id,
    runId: row.run_id,
    seq: Number(row.seq),
    type: row.type,
    queueItemId: row.queue_item_id ?? payload.queueItemId,
    actorKind: row.actor_kind ?? payload.actorKind,
    actorId: row.actor_id ?? payload.actorId,
    createdAt: iso(row.created_at) ?? payload.createdAt,
  });
}

function rowToSignal(row) {
  const payload = jsonObject(row.payload_json);
  return dropUndefined({
    ...payload,
    id: row.id,
    runId: row.run_id ?? payload.runId,
    correlationKey: row.correlation_key ?? payload.correlationKey,
    type: row.type ?? payload.type,
    status: row.status,
    consumedBy: row.consumed_by ?? payload.consumedBy,
    consumedAt: iso(row.consumed_at) ?? payload.consumedAt,
    createdAt: iso(row.created_at) ?? payload.createdAt,
    updatedAt: iso(row.updated_at) ?? payload.updatedAt,
  });
}

function rowToAgentClaim(row) {
  const payload = jsonObject(row.payload_json);
  return dropUndefined({
    ...payload,
    id: row.id,
    repo: row.repo,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    ownerAgentId: row.owner_agent_id,
    taskId: row.task_id ?? payload.taskId,
    runId: row.run_id ?? payload.runId,
    branch: row.branch ?? payload.branch,
    paths: jsonArray(row.paths_json, payload.paths),
    status: row.status,
    claimedAt: iso(row.claimed_at) ?? payload.claimedAt,
    renewedAt: iso(row.renewed_at) ?? payload.renewedAt,
    expiresAt: iso(row.expires_at) ?? payload.expiresAt,
    releasedAt: iso(row.released_at) ?? payload.releasedAt,
    releaseReason: row.release_reason ?? payload.releaseReason,
    metadata: jsonObject(row.metadata_json, payload.metadata),
    createdAt: iso(row.created_at) ?? payload.createdAt,
    updatedAt: iso(row.updated_at) ?? payload.updatedAt,
  });
}

function rowToWorkerLease(row) {
  const payload = jsonObject(row.payload_json);
  return dropUndefined({
    ...payload,
    id: row.id,
    ownerId: row.owner_id ?? payload.ownerId,
    status: row.status,
    acquiredAt: iso(row.acquired_at) ?? payload.acquiredAt,
    renewedAt: iso(row.renewed_at) ?? payload.renewedAt,
    expiresAt: iso(row.expires_at) ?? payload.expiresAt,
    releasedAt: iso(row.released_at) ?? payload.releasedAt,
    releaseReason: row.release_reason ?? payload.releaseReason,
    metadata: jsonObject(row.metadata_json, payload.metadata),
    createdAt: iso(row.created_at) ?? payload.createdAt,
    updatedAt: iso(row.updated_at) ?? payload.updatedAt,
  });
}

function rowToRepoPolicy(row) {
  return dropUndefined({
    repo: row.repo,
    queueMode: row.queue_mode,
    protectedBranches: jsonArray(row.protected_branches, ["main", "develop"]),
    requiredChecks: jsonArray(row.required_checks),
    trustedActors: jsonArray(row.trusted_actors),
    allowForks: row.allow_forks === true,
    policy: jsonObject(row.policy_json),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function rowToRegisteredAgent(row) {
  const payload = jsonObject(row.payload_json);
  return dropUndefined({
    ...payload,
    id: row.id,
    status: row.status,
    displayName: row.display_name ?? payload.displayName,
    forgejoUsername: row.forgejo_username ?? payload.forgejoUsername,
    elizaCloudSubject: row.eliza_cloud_subject ?? payload.elizaCloudSubject,
    tenantId: row.tenant_id ?? payload.tenantId,
    source: row.source ?? payload.source,
    registeredBy: row.registered_by ?? payload.registeredBy,
    registeredAt: iso(row.registered_at) ?? payload.registeredAt,
    disabledBy: row.disabled_by ?? payload.disabledBy,
    disabledAt: iso(row.disabled_at) ?? payload.disabledAt,
    disableReason: row.disable_reason ?? payload.disableReason,
    metadata: jsonObject(row.metadata_json, payload.metadata),
    createdAt: iso(row.created_at) ?? payload.createdAt,
    updatedAt: iso(row.updated_at) ?? payload.updatedAt,
  });
}

function rowToEvent(row) {
  const payload = jsonObject(row.payload_json);
  return dropUndefined({
    ...payload,
    deliveryId: row.delivery_id ?? payload.deliveryId,
    type: row.type ?? payload.type,
    repo: row.repo ?? payload.repo,
    pullRequestId: row.pull_request_id ?? payload.pullRequestId,
    receivedAt: iso(row.received_at) ?? payload.receivedAt,
  });
}

function buildFilters(filters) {
  const clauses = [];
  const values = [];
  for (const [column, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    values.push(String(value));
    clauses.push(`${column} = $${values.length}`);
  }
  return {
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

function jsonPayload(value) {
  return JSON.stringify(jsonSerializable(value));
}

function jsonSerializable(value) {
  if (value instanceof Set) return [...value];
  if (Array.isArray(value)) return value.map(jsonSerializable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, jsonSerializable(item)]),
    );
  }
  return value;
}

function jsonObject(value, fallback = {}) {
  const parsed = parseJson(value);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
    return parsed;
  return fallback && typeof fallback === "object" && !Array.isArray(fallback)
    ? fallback
    : {};
}

function jsonArray(value, fallback = []) {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) return parsed;
  return Array.isArray(fallback) ? fallback : [];
}

function jsonValue(value, fallback = null) {
  const parsed = parseJson(value);
  return parsed ?? fallback ?? null;
}

function parseJson(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      // error-policy:J3 legacy rows may hold plain text where JSON is expected;
      // the raw value passes through explicitly
      return value;
    }
  }
  return value ?? null;
}

function arrayValue(value) {
  if (value instanceof Set) return [...value];
  return Array.isArray(value) ? value : [];
}

function intOrNull(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function intOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : String(value);
}

function normalizedIteration(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function positiveAttemptNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new TypeError("Attempt number must be a positive integer");
  }
  return number;
}

function positiveSequenceNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new TypeError("Event sequence must be a positive integer");
  }
  return number;
}

function isFutureAvailableAt(availableAt, now) {
  if (!availableAt) return false;
  const availableAtMs = Date.parse(availableAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(availableAtMs) || !Number.isFinite(nowMs)) return false;
  return availableAtMs > nowMs;
}

function parseQueueItemId(id) {
  if (!id) return null;
  const value = String(id);
  const index = value.lastIndexOf("#");
  if (index === -1) return null;
  const repo = value.slice(0, index);
  const pullRequestId = intOrNull(value.slice(index + 1));
  if (!repo || pullRequestId == null) return null;
  return { id: value, repo, pullRequestId };
}

function isExpired(expiresAt, now) {
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) return false;
  return expiresAtMs <= nowMs;
}

function validateAgentClaim(claim = {}) {
  if (
    !claim.repo ||
    !claim.resourceKind ||
    !claim.resourceId ||
    !claim.ownerAgentId
  ) {
    throw new TypeError(
      "Agent claim requires repo, resourceKind, resourceId, and ownerAgentId",
    );
  }
}

function validateWorkerLease(lease = {}) {
  workerLeaseId(lease);
  if (!lease.ownerId) {
    throw new TypeError("Worker lease requires ownerId");
  }
}

function sameAgentClaimResource(left = {}, right = {}) {
  return (
    left.repo === right.repo &&
    left.resourceKind === right.resourceKind &&
    String(left.resourceId) === String(right.resourceId)
  );
}

function serializeAttemptError(error) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
    };
  }
  if (error && typeof error === "object") return error;
  return { message: String(error ?? "attempt_failed") };
}

function payloadHash(value) {
  return createHash("sha256").update(jsonPayload(value)).digest("hex");
}

function dropUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}
