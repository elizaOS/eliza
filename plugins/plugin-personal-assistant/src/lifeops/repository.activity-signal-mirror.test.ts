/** PGlite-backed proof that mirror failures remain non-fatal and enter AgentRuntime diagnostics. */

import {
  AgentRuntime,
  type Character,
  type ErrorReportedPayload,
  EventType,
  type UUID,
} from "@elizaos/core";
import type { LifeOpsActivitySignal } from "@elizaos/shared";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgliteDatabaseAdapter } from "../../../plugin-sql/src/pglite/adapter.js";
import { PGliteClientManager } from "../../../plugin-sql/src/pglite/manager.js";
import {
  createSignalSourceRegistry,
  registerSignalSourceRegistry,
} from "./registries/signal-source-registry.js";
import { LifeOpsRepository } from "./repository.js";
import { registerBuiltinSignalSources } from "./telemetry-mapping.js";

let agentId: UUID;

function signal(id: UUID): LifeOpsActivitySignal {
  return {
    id,
    agentId,
    source: "desktop_interaction",
    platform: "macos_desktop",
    state: "active",
    observedAt: "2026-07-11T06:00:00.000Z",
    idleState: null,
    idleTimeSeconds: 3,
    onBattery: null,
    health: null,
    metadata: {},
    createdAt: "2026-07-11T06:00:00.000Z",
  };
}

describe("LifeOpsRepository activity telemetry mirror", () => {
  let manager: PGliteClientManager;
  let adapter: PgliteDatabaseAdapter;
  let runtime: AgentRuntime;
  let repository: LifeOpsRepository;

  beforeEach(async () => {
    agentId = crypto.randomUUID() as UUID;
    manager = new PGliteClientManager({});
    await manager.initialize();
    adapter = new PgliteDatabaseAdapter(agentId, manager);
    await adapter.init();
    runtime = new AgentRuntime({
      agentId,
      character: { name: "lifeops-mirror-test" } as Character,
      adapter,
    });
    const registry = createSignalSourceRegistry();
    registerBuiltinSignalSources(registry);
    registerSignalSourceRegistry(runtime, registry);
    repository = new LifeOpsRepository(runtime);

    const db = adapter.getDatabase();
    await db.execute(sql.raw("CREATE SCHEMA IF NOT EXISTS app_lifeops"));
    await db.execute(
      sql.raw(`CREATE TABLE app_lifeops.life_activity_signals (
      id UUID PRIMARY KEY, agent_id UUID NOT NULL, source TEXT NOT NULL,
      platform TEXT NOT NULL, state TEXT NOT NULL, observed_at TEXT NOT NULL,
      idle_state TEXT, idle_time_seconds INTEGER, on_battery BOOLEAN,
      metadata_json JSONB NOT NULL, created_at TEXT NOT NULL
    )`),
    );
    // Intentionally omit life_telemetry_events: the real mirror insert fails.
  });

  afterEach(async () => {
    await adapter.close();
    await manager.close();
  });

  it("commits the primary row and exposes the mirror failure through the real runtime", async () => {
    const events: ErrorReportedPayload[] = [];
    runtime.registerEvent(EventType.ERROR_REPORTED, async (payload) => {
      events.push(payload as ErrorReportedPayload);
    });

    await expect(
      repository.createActivitySignal(signal(crypto.randomUUID() as UUID)),
    ).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rows = await adapter
      .getDatabase()
      .execute(sql.raw("SELECT id FROM app_lifeops.life_activity_signals"));
    expect(rows.rows).toHaveLength(1);
    expect(runtime.getRecentReportedErrors()).toEqual([
      expect.objectContaining({
        scope: "lifeops.repository",
        code: "LIFEOPS_ACTIVITY_TELEMETRY_MIRROR_FAILED",
      }),
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        scope: "lifeops.repository",
        code: "LIFEOPS_ACTIVITY_TELEMETRY_MIRROR_FAILED",
        context: expect.objectContaining({ consecutiveFailures: 1 }),
      }),
    ]);
  });

  it("reports a sustained outage on a bounded first-and-every-100th cadence", async () => {
    for (let index = 0; index < 100; index += 1) {
      await repository.createActivitySignal(
        signal(crypto.randomUUID() as UUID),
      );
    }

    expect(runtime.getRecentReportedErrors()).toHaveLength(2);
    expect(
      runtime
        .getRecentReportedErrors()
        .map((entry) => entry.context.consecutiveFailures),
    ).toEqual([1, 100]);
  });

  it("resets the consecutive-failure cadence after a successful mirror write", async () => {
    await repository.createActivitySignal(signal(crypto.randomUUID() as UUID));

    const db = adapter.getDatabase();
    await db.execute(
      sql.raw(`CREATE TABLE app_lifeops.life_telemetry_events (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, family TEXT NOT NULL,
      occurred_at TEXT NOT NULL, ingested_at TEXT NOT NULL,
      dedupe_key TEXT NOT NULL, source_reliability REAL NOT NULL,
      payload_json TEXT NOT NULL, UNIQUE (agent_id, dedupe_key)
    )`),
    );
    await repository.createActivitySignal(signal(crypto.randomUUID() as UUID));
    await db.execute(sql.raw("DROP TABLE app_lifeops.life_telemetry_events"));
    await repository.createActivitySignal(signal(crypto.randomUUID() as UUID));

    expect(
      runtime
        .getRecentReportedErrors()
        .map((entry) => entry.context.consecutiveFailures),
    ).toEqual([1, 1]);
  });
});
