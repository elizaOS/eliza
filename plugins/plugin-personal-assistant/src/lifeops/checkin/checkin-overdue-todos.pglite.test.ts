/**
 * The engine moves an overdue one-shot todo to the "visible" occurrence state;
 * the morning check-in must still list it as overdue. Real PGlite, no model.
 */
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { materializeDefinitionOccurrences } from "../engine.js";
import { CheckinService } from "./checkin-service.js";

it("morning check-in lists an overdue todo the engine has made visible", async () => {
  const db = await PGlite.create();
  const agentId = "agent-1";
  const now = new Date("2026-10-04T15:00:00.000Z");
  const definition = {
    id: "def-1",
    agentId,
    domain: "user_lifeops",
    subjectType: "owner",
    subjectId: agentId,
    visibilityScope: "owner_only",
    contextPolicy: "allowed_in_private_chat",
    kind: "task",
    title: "Pay rent",
    description: "",
    originalIntent: "pay rent",
    timezone: "America/Los_Angeles",
    status: "active",
    priority: 3,
    cadence: { kind: "once", dueAt: "2026-10-04T14:00:00.000Z" },
    windowPolicy: { timezone: "America/Los_Angeles", windows: [] },
    progressionRule: { kind: "none" },
    reminderPlanId: null,
    goalId: null,
    source: "chat",
    metadata: {},
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  } as never;
  const [occ] = materializeDefinitionOccurrences(definition, [], { now });
  expect(occ?.state).toBe("visible");
  await db.exec(`CREATE SCHEMA app_lifeops;
    CREATE TABLE fixture_cache (key text PRIMARY KEY, payload jsonb);
    CREATE TABLE app_lifeops.life_checkin_reports (id text PRIMARY KEY, agent_id text, kind text, generated_at text, generated_at_ms bigint, escalation_level text, payload_json jsonb, acknowledged_at text);
    CREATE TABLE app_lifeops.life_task_definitions (id text PRIMARY KEY, agent_id text, title text, kind text, status text, metadata_json jsonb, cadence_json jsonb);
    CREATE TABLE app_lifeops.life_task_occurrences (id text PRIMARY KEY, agent_id text, definition_id text, state text, due_at text, completion_payload_json jsonb, updated_at text);
    CREATE TABLE app_lifeops.life_task_progress_events (agent_id text, occurrence_id text, quantity int);`);
  await db.query(
    "INSERT INTO app_lifeops.life_task_definitions VALUES ('def-1',$1,'Pay rent','task','active','{}','{}')",
    [agentId],
  );
  await db.query(
    "INSERT INTO app_lifeops.life_task_occurrences VALUES ($1,$2,'def-1',$3,$4,NULL,$5)",
    [occ.id, agentId, occ.state, occ.dueAt, now.toISOString()],
  );
  const runtime = {
    agentId,
    character: { name: "x" },
    getSetting: () => undefined,
    getService: () => null,
    getCache: async () => undefined,
    setCache: async () => true,
    adapter: {
      db: {
        execute: (q: { queryChunks: { value?: string }[] }) =>
          db.query(q.queryChunks.map((c) => c.value ?? "").join("")),
      },
    },
    useModel: async () => {
      throw new Error("no model");
    },
  } as never;
  const report = await new CheckinService(runtime).runMorningCheckin({
    timezone: "America/Los_Angeles",
    now,
  });
  expect(report.overdueTodos.map((t) => t.title)).toEqual(["Pay rent"]);
});
