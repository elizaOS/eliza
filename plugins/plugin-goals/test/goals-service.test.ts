/**
 * Unit tests for the goals back-end: GoalsService CRUD + dedup + scoring,
 * GoalsRepository raw-SQL shape, and the OWNER_GOALS action dispatch.
 *
 * The runtime DB is faked: `runtime.adapter.db.execute(raw(sql))` is intercepted
 * and the captured SQL string is matched to return canned rows, so these tests
 * exercise the real query construction + row parsing without a database.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GoalsRepository } from "../src/db/goals-repository.ts";
import { GoalsServiceError } from "../src/goal-normalize.ts";
import { createOwnerGoalsService } from "../src/goals-runtime.ts";
import {
  type GoalsNormalizeOwnership,
  type GoalsRecordAudit,
  GoalsService,
  scoreGoalSimilarity,
} from "../src/goals-service.ts";
import { ownerGoalsAction } from "../src/actions/goals.ts";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";

interface GoalRow {
  id: string;
  agent_id: string;
  domain: string;
  subject_type: string;
  subject_id: string;
  visibility_scope: string;
  context_policy: string;
  title: string;
  description: string;
  cadence_json: string | null;
  support_strategy_json: string;
  success_criteria_json: string;
  status: string;
  review_state: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

/**
 * A fake runtime whose DB returns rows from an in-memory goal store. Captures
 * every executed SQL string for assertions. `sql.raw(text)` is the drizzle shape
 * the repo expects; we pass the text through `queryChunks[0].value`.
 */
function makeRuntime(): {
  runtime: IAgentRuntime;
  goals: Map<string, GoalRow>;
  links: Array<Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
  executedSql: string[];
} {
  const goals = new Map<string, GoalRow>();
  const links: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const executedSql: string[] = [];

  // Minimal drizzle sql.raw shim — store the text so we can route on it.
  vi.stubGlobal("__noop__", undefined);

  const execute = async (query: {
    queryChunks: Array<{ value?: unknown }>;
  }): Promise<unknown> => {
    const text = String(query.queryChunks[0]?.value ?? "");
    executedSql.push(text);
    const normalized = text.replace(/\s+/g, " ").trim();

    if (normalized.startsWith("SELECT * FROM app_goals.life_goal_definitions")) {
      if (normalized.includes("AND id =")) {
        const idMatch = normalized.match(/AND id = '([^']+)'/);
        const id = idMatch?.[1];
        const row = id ? goals.get(id) : undefined;
        return { rows: row ? [row] : [] };
      }
      return { rows: [...goals.values()] };
    }
    if (
      normalized.startsWith("SELECT * FROM app_goals.life_goal_links")
    ) {
      const goalMatch = normalized.match(/AND goal_id = '([^']+)'/);
      const goalId = goalMatch?.[1];
      return {
        rows: links.filter((l) => l.goal_id === goalId),
      };
    }
    if (normalized.startsWith("INSERT INTO app_goals.life_goal_definitions")) {
      const row = parseInsertGoal(text);
      goals.set(row.id, row);
      return { rows: [] };
    }
    if (normalized.startsWith("UPDATE app_goals.life_goal_definitions")) {
      const idMatch = normalized.match(/WHERE id = '([^']+)'/);
      const id = idMatch?.[1];
      if (id && goals.has(id)) {
        // We don't fully re-parse the UPDATE; tests assert via re-read of a
        // freshly built record returned by the service, so the in-memory copy
        // only needs to exist for getGoal lookups.
        const titleMatch = text.match(/title = '([^']*)'/);
        const existing = goals.get(id);
        if (existing && titleMatch) existing.title = titleMatch[1];
      }
      return { rows: [] };
    }
    if (
      normalized.startsWith("DELETE FROM app_goals.life_goal_definitions")
    ) {
      const idMatch = normalized.match(/AND id = '([^']+)'/);
      if (idMatch?.[1]) goals.delete(idMatch[1]);
      return { rows: [] };
    }
    if (normalized.startsWith("DELETE FROM app_goals.life_goal_links")) {
      return { rows: [] };
    }
    if (normalized.startsWith("UPDATE app_lifeops.life_task_definitions")) {
      return { rows: [] };
    }
    if (normalized.startsWith("INSERT INTO app_lifeops.life_audit_events")) {
      audits.push({ sql: text });
      return { rows: [] };
    }
    return { rows: [] };
  };

  const runtime = {
    agentId: AGENT_ID,
    adapter: { db: { execute } },
  } as unknown as IAgentRuntime;

  return { runtime, goals, links, audits, executedSql };
}

/**
 * Tokenize the VALUES list into ordered literals, honoring single-quoted
 * strings (which may contain commas, e.g. JSON columns) and `''` escapes.
 */
function tokenizeSqlValues(raw: string): Array<string | null> {
  const out: Array<string | null> = [];
  let i = 0;
  const n = raw.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(raw[i])) i++;
    if (i >= n) break;
    if (raw[i] === "'") {
      i++;
      let value = "";
      while (i < n) {
        if (raw[i] === "'" && raw[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        if (raw[i] === "'") {
          i++;
          break;
        }
        value += raw[i];
        i++;
      }
      out.push(value);
    } else {
      let token = "";
      while (i < n && !/[\s,]/.test(raw[i])) {
        token += raw[i];
        i++;
      }
      out.push(token === "NULL" ? null : token);
    }
  }
  return out;
}

function parseInsertGoal(text: string): GoalRow {
  // The INSERT lists columns then VALUES with single-quoted literals in order.
  const valuesMatch = text.match(/VALUES\s*\(([\s\S]+)\)/);
  const raw = valuesMatch?.[1] ?? "";
  const literals = tokenizeSqlValues(raw);
  const [
    id,
    agent_id,
    domain,
    subject_type,
    subject_id,
    visibility_scope,
    context_policy,
    title,
    description,
    cadence_json,
    support_strategy_json,
    success_criteria_json,
    status,
    review_state,
    metadata_json,
    created_at,
    updated_at,
  ] = literals;
  return {
    id: String(id),
    agent_id: String(agent_id),
    domain: String(domain),
    subject_type: String(subject_type),
    subject_id: String(subject_id),
    visibility_scope: String(visibility_scope),
    context_policy: String(context_policy),
    title: String(title),
    description: String(description ?? ""),
    cadence_json: cadence_json,
    support_strategy_json: String(support_strategy_json ?? "{}"),
    success_criteria_json: String(success_criteria_json ?? "{}"),
    status: String(status),
    review_state: String(review_state),
    metadata_json: String(metadata_json ?? "{}"),
    created_at: String(created_at),
    updated_at: String(updated_at),
  };
}

describe("scoreGoalSimilarity", () => {
  it("scores near-identical goals high and unrelated goals zero", () => {
    const base = {
      id: "g",
      agentId: AGENT_ID,
      domain: "user_lifeops",
      subjectType: "owner",
      subjectId: "owner",
      visibilityScope: "owner_only",
      contextPolicy: "explicit_only",
      title: "Run a marathon this year",
      description: "Train for and finish a marathon",
      cadence: null,
      supportStrategy: {},
      successCriteria: {},
      status: "active",
      reviewState: "idle",
      metadata: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as const;
    const same = scoreGoalSimilarity({
      reference: { title: "Run a marathon this year", description: "Train for a marathon" },
      candidate: base,
    });
    expect(same).toBeGreaterThanOrEqual(0.85);
    const unrelated = scoreGoalSimilarity({
      reference: { title: "Learn to paint watercolors" },
      candidate: base,
    });
    expect(unrelated).toBe(0);
  });
});

describe("GoalsService CRUD", () => {
  let env: ReturnType<typeof makeRuntime>;
  let recordAudit: GoalsRecordAudit;
  let normalizeOwnership: GoalsNormalizeOwnership;
  let service: GoalsService;
  const auditCalls: Array<{ eventType: string; ownerId: string; reason: string }> =
    [];

  beforeEach(() => {
    env = makeRuntime();
    auditCalls.length = 0;
    recordAudit = async (eventType, _ownerType, ownerId, reason) => {
      auditCalls.push({ eventType, ownerId, reason });
    };
    normalizeOwnership = () => ({
      domain: "user_lifeops",
      subjectType: "owner",
      subjectId: "owner-entity",
      visibilityScope: "owner_only",
      contextPolicy: "explicit_only",
    });
    service = new GoalsService(env.runtime, { recordAudit, normalizeOwnership });
  });

  it("creates a goal, records an audit, returns the record", async () => {
    const record = await service.createGoal({
      title: "  Sleep by 11pm  ",
      description: "Wind down earlier",
    });
    expect(record.goal.title).toBe("Sleep by 11pm");
    expect(record.goal.status).toBe("active");
    expect(record.goal.reviewState).toBe("idle");
    expect(record.goal.subjectType).toBe("owner");
    expect(record.links).toEqual([]);
    expect(auditCalls).toContainEqual(
      expect.objectContaining({ eventType: "goal_created", reason: "goal created" }),
    );
    // Persisted via INSERT, readable via listGoals.
    const all = await service.listGoals();
    expect(all.map((r) => r.goal.title)).toContain("Sleep by 11pm");
  });

  it("short-circuits a near-duplicate active goal via dedup", async () => {
    const first = await service.createGoal({ title: "Run a marathon this year" });
    auditCalls.length = 0;
    const dup = await service.createGoal({
      title: "Run a marathon this year",
      description: "marathon training",
    });
    expect(dup.goal.id).toBe(first.goal.id);
    expect(auditCalls).toContainEqual(
      expect.objectContaining({
        eventType: "goal_created",
        reason: "goal create short-circuited by dedup",
      }),
    );
  });

  it("rejects an empty title", async () => {
    await expect(service.createGoal({ title: "   " })).rejects.toBeInstanceOf(
      GoalsServiceError,
    );
  });

  it("getGoal throws 404 for an unknown id", async () => {
    await expect(service.getGoal("missing")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("updates a goal title and records an audit", async () => {
    const created = await service.createGoal({ title: "Read more books" });
    auditCalls.length = 0;
    const updated = await service.updateGoal(created.goal.id, {
      title: "Read 12 books this year",
    });
    expect(updated.goal.title).toBe("Read 12 books this year");
    expect(auditCalls).toContainEqual(
      expect.objectContaining({ eventType: "goal_updated" }),
    );
  });

  it("deletes a goal and records an audit", async () => {
    const created = await service.createGoal({ title: "Quit caffeine" });
    auditCalls.length = 0;
    await service.deleteGoal(created.goal.id);
    expect(auditCalls).toContainEqual(
      expect.objectContaining({ eventType: "goal_deleted" }),
    );
    await expect(service.getGoal(created.goal.id)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("createOwnerGoalsService", () => {
  it("builds a working service whose default audit hook writes to life_audit_events", async () => {
    const env = makeRuntime();
    const service = createOwnerGoalsService(env.runtime);
    const record = await service.createGoal({ title: "Stretch daily" });
    expect(record.goal.subjectType).toBe("owner");
    expect(record.goal.domain).toBe("user_lifeops");
    // Default recordAudit hook inserted into the shared audit table.
    expect(env.audits.length).toBeGreaterThan(0);
  });
});

describe("ownerGoalsAction handler", () => {
  function actionRuntime(env: ReturnType<typeof makeRuntime>): IAgentRuntime {
    return env.runtime;
  }

  it("creates a goal from planner-trusted params and emits a callback", async () => {
    const env = makeRuntime();
    const lines: string[] = [];
    const result = await ownerGoalsAction.handler?.(
      actionRuntime(env),
      { content: { text: "" } } as never,
      undefined,
      { parameters: { action: "create", title: "Meditate 10 min" } },
      async (resp) => {
        if (resp.text) lines.push(resp.text);
        return [];
      },
    );
    expect(result?.success).toBe(true);
    expect(lines.join(" ")).toContain("Meditate 10 min");
    const created = result?.data as { record?: { goal?: { title?: string } } };
    expect(created?.record?.goal?.title).toBe("Meditate 10 min");
  });

  it("reviews a goal and reports its state", async () => {
    const env = makeRuntime();
    const service = createOwnerGoalsService(env.runtime);
    const created = await service.createGoal({ title: "Drink water" });
    const lines: string[] = [];
    const result = await ownerGoalsAction.handler?.(
      env.runtime,
      { content: { text: "" } } as never,
      undefined,
      { parameters: { action: "review", id: created.goal.id } },
      async (resp) => {
        if (resp.text) lines.push(resp.text);
        return [];
      },
    );
    expect(result?.success).toBe(true);
    expect(lines.join(" ")).toContain("Drink water");
  });

  it("surfaces a GoalsServiceError (404) as a failed result, not a throw", async () => {
    const env = makeRuntime();
    const result = await ownerGoalsAction.handler?.(
      env.runtime,
      { content: { text: "" } } as never,
      undefined,
      { parameters: { action: "delete", id: "does-not-exist" } },
      async () => [],
    );
    expect(result?.success).toBe(false);
  });
});
