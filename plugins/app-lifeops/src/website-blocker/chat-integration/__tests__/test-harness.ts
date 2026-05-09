import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime, Task, UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  resetSelfControlStatusCache,
  setSelfControlPluginConfig,
} from "../../engine.js";

export interface BlockRuleTestHarness {
  runtime: IAgentRuntime;
  execute: (statement: string) => Promise<unknown>;
  close: () => Promise<void>;
}

const BOOTSTRAP_STATEMENTS = [
  `CREATE SCHEMA IF NOT EXISTS app_lifeops`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_task_definitions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT 'user_lifeops',
    subject_type TEXT NOT NULL DEFAULT 'owner',
    subject_id TEXT NOT NULL,
    visibility_scope TEXT NOT NULL DEFAULT 'owner_only',
    context_policy TEXT NOT NULL DEFAULT 'explicit_only',
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    original_intent TEXT NOT NULL DEFAULT '',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    status TEXT NOT NULL DEFAULT 'active',
    priority INTEGER NOT NULL DEFAULT 3,
    cadence_json TEXT NOT NULL DEFAULT '{}',
    window_policy_json TEXT NOT NULL DEFAULT '{}',
    progression_rule_json TEXT NOT NULL DEFAULT '{}',
    website_access_json TEXT,
    reminder_plan_id TEXT,
    goal_id TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_task_occurrences (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    definition_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    due_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_block_rules (
    id UUID PRIMARY KEY,
    agent_id UUID NOT NULL,
    profile TEXT NOT NULL,
    websites JSONB NOT NULL,
    gate_type TEXT NOT NULL,
    gate_todo_id TEXT,
    gate_until_ms BIGINT,
    fixed_duration_ms BIGINT,
    unlock_duration_ms BIGINT,
    active BOOLEAN DEFAULT TRUE,
    created_at BIGINT NOT NULL,
    released_at BIGINT,
    released_reason TEXT
  )`,
];

/**
 * Stub runtime with task-worker and getTasks hooks so the BlockWriter's call
 * into websiteBlockAction handler can complete synchronously. The
 * SelfControl engine degrades gracefully on non-macOS test hosts; when engine
 * is unavailable the action returns `success: false`, which we catch in tests
 * that need to skip the SelfControl side-effect path.
 */
export async function createBlockRuleHarness(
  agentId: UUID = "00000000-0000-0000-0000-000000000042" as UUID,
): Promise<BlockRuleTestHarness> {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "lifeops-block-rules-"),
  );
  const hostsFilePath = path.join(tempDir, "hosts");
  fs.writeFileSync(hostsFilePath, "127.0.0.1 localhost\n::1 localhost\n");
  setSelfControlPluginConfig({
    hostsFilePath,
    validateSystemResolution: false,
    statusCacheTtlMs: 0,
  });
  resetSelfControlStatusCache();

  const pgClient = new PGlite();
  const db = drizzle(pgClient);
  for (const statement of BOOTSTRAP_STATEMENTS) {
    await db.execute(sql.raw(statement));
  }

  const taskWorkers = new Map<
    string,
    {
      name: string;
      execute: (
        rt: IAgentRuntime,
        options: unknown,
        task: Task,
      ) => Promise<unknown>;
    }
  >();
  const tasks = new Map<UUID, Task>();

  const runtime = {
    agentId,
    adapter: { db },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    registerTaskWorker: (worker: {
      name: string;
      shouldRun?: (rt: IAgentRuntime) => Promise<boolean>;
      execute: (
        rt: IAgentRuntime,
        options: unknown,
        task: Task,
      ) => Promise<unknown>;
    }) => {
      taskWorkers.set(worker.name, worker);
    },
    getTaskWorker: (name: string) => taskWorkers.get(name) ?? null,
    getTasks: async () => [],
    createTask: async () => `00000000-0000-0000-0000-0000000000aa` as UUID,
    updateTask: async () => undefined,
    deleteTask: async () => undefined,
  } as IAgentRuntime;

  return {
    runtime,
    execute: (statement: string) => db.execute(sql.raw(statement)),
    close: async () => {
      tasks.clear();
      taskWorkers.clear();
      setSelfControlPluginConfig(undefined);
      resetSelfControlStatusCache();
      await pgClient.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

export async function seedTodo(
  harness: BlockRuleTestHarness,
  options: { id: string; title: string; state?: "pending" | "completed" },
): Promise<void> {
  const agentId = String(harness.runtime.agentId);
  const now = new Date().toISOString();
  await harness.execute(
    `INSERT INTO app_lifeops.life_task_definitions (
       id, agent_id, subject_id, kind, title, created_at, updated_at
     ) VALUES (
       '${options.id}', '${agentId}', '${agentId}', 'todo',
       '${options.title.replace(/'/g, "''")}', '${now}', '${now}'
     )`,
  );
  await harness.execute(
    `INSERT INTO app_lifeops.life_task_occurrences (
       id, agent_id, definition_id, state, created_at, updated_at
     ) VALUES (
       '${options.id}', '${agentId}', '${options.id}',
       '${options.state ?? "pending"}', '${now}', '${now}'
     )`,
  );
}

export async function completeTodo(
  harness: BlockRuleTestHarness,
  id: string,
): Promise<void> {
  const now = new Date().toISOString();
  await harness.execute(
    `UPDATE app_lifeops.life_task_occurrences
       SET state = 'completed', updated_at = '${now}'
     WHERE id = '${id}'`,
  );
}
