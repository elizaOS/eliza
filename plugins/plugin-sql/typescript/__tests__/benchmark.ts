/**
 * elizaOS Database API Benchmark
 *
 * Runs on BOTH old (singular) and new (batch-first) API versions.
 * Detects which API is available at runtime and adapts accordingly.
 *
 * WHY two code paths: We stash our changes and run this on the old code too.
 * The old API has createAgent (singular), the new has createAgents (batch).
 * We cast adapter to `any` to bypass TypeScript and detect at runtime.
 *
 * Usage:
 *   bun run plugins/plugin-sql/typescript/__tests__/benchmark.ts
 *   bun run plugins/plugin-sql/typescript/__tests__/benchmark.ts --dry-run
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent, Entity, Memory, Room, UUID } from "@elizaos/core";
import { AgentRuntime } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { v4 } from "uuid";
import { plugin as sqlPlugin } from "../index";
import { DatabaseMigrationService } from "../migration-service";
import { PgliteDatabaseAdapter } from "../pglite/adapter";
import { PGliteClientManager } from "../pglite/manager";
import { mockCharacter } from "./fixtures";

// ─── Configuration ──────────────────────────────────────────────────────────

const isDryRun = process.argv.includes("--dry-run");
const nArg = process.argv.find((a) => a.startsWith("--n="));
const itersArg = process.argv.find((a) => a.startsWith("--iters="));
const N = isDryRun ? 5 : nArg ? Number.parseInt(nArg.split("=")[1], 10) : 100;
const ITERATIONS = isDryRun ? 1 : itersArg ? Number.parseInt(itersArg.split("=")[1], 10) : 5;
const WARMUP = isDryRun ? 0 : Math.max(1, Math.floor(ITERATIONS / 3));

// ─── API Detection ──────────────────────────────────────────────────────────

interface DetectedAPI {
  isNewAPI: boolean;
  // Agents
  createOneAgent: (a: any) => Promise<any>;
  createManyAgents: (agents: any[]) => Promise<any>;
  updateOneAgent: (id: UUID, data: any) => Promise<any>;
  updateManyAgents: (updates: any[]) => Promise<any>;
  hasUpsertAgents: boolean;
  upsertAgents: (agents: any[]) => Promise<any>;
  // Entities
  createEntities: (entities: any[]) => Promise<any>;
  // Memories
  createOneMemory: (memory: any, tableName: string) => Promise<any>;
  createManyMemories: (items: any[]) => Promise<any>;
  // Rooms
  createRooms: (rooms: any[]) => Promise<any>;
}

function detectAPI(adapter: any): DetectedAPI {
  const isNewAPI = typeof adapter.createAgents === "function";

  return {
    isNewAPI,

    // Old: createAgent(agent) -> boolean
    // New: createAgents([agent]) -> UUID[]
    createOneAgent: isNewAPI
      ? (a: any) => adapter.createAgents([a])
      : (a: any) => adapter.createAgent(a),

    createManyAgents: isNewAPI
      ? (agents: any[]) => adapter.createAgents(agents)
      : async (agents: any[]) => {
          for (const a of agents) await adapter.createAgent(a);
        },

    // Old: updateAgent(id, data) -> boolean
    // New: updateAgents([{agentId, agent}]) -> boolean
    updateOneAgent: isNewAPI
      ? (id: UUID, data: any) =>
          adapter.updateAgents([{ agentId: id, agent: data }])
      : (id: UUID, data: any) => adapter.updateAgent(id, data),

    updateManyAgents: isNewAPI
      ? (updates: any[]) => adapter.updateAgents(updates)
      : async (updates: any[]) => {
          for (const u of updates) await adapter.updateAgent(u.agentId, u.agent);
        },

    hasUpsertAgents: typeof adapter.upsertAgents === "function",
    upsertAgents: adapter.upsertAgents?.bind(adapter) ?? (async () => {}),

    // Old: createEntities(entities) -> boolean
    // New: createEntities(entities) -> UUID[]  (same name, different return)
    createEntities: (entities: any[]) => adapter.createEntities(entities),

    // Old: createMemory(memory, tableName) -> UUID
    // New: createMemories([{memory, tableName}]) -> UUID[]
    createOneMemory: isNewAPI
      ? (memory: any, tableName: string) =>
          adapter.createMemories([{ memory, tableName }])
      : (memory: any, tableName: string) =>
          adapter.createMemory(memory, tableName),

    createManyMemories: isNewAPI
      ? (items: any[]) => adapter.createMemories(items)
      : async (items: any[]) => {
          for (const { memory, tableName } of items)
            await adapter.createMemory(memory, tableName);
        },

    // Both have createRooms (same signature)
    createRooms: (rooms: any[]) => adapter.createRooms(rooms),
  };
}

// ─── Database Setup ─────────────────────────────────────────────────────────

async function setupDatabase() {
  const testAgentId = v4() as UUID;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-bench-"));
  const connectionManager = new PGliteClientManager({ dataDir: tempDir });
  await connectionManager.initialize();
  const adapter = new PgliteDatabaseAdapter(testAgentId, connectionManager);
  await adapter.init();

  const runtime = new AgentRuntime({
    character: { ...mockCharacter, id: undefined },
    agentId: testAgentId,
    plugins: [sqlPlugin],
  });
  runtime.registerDatabaseAdapter(adapter);

  const migrationService = new DatabaseMigrationService();
  await migrationService.initializeWithDatabase(adapter.getDatabase());
  migrationService.discoverAndRegisterPluginSchemas([sqlPlugin]);
  await migrationService.runAllPluginMigrations();

  const api = detectAPI(adapter);

  // Create the test agent using whichever API is available
  await api.createOneAgent({
    id: testAgentId,
    ...mockCharacter,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const cleanup = async () => {
    await adapter.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  };

  return { adapter, runtime, testAgentId, api, cleanup };
}

// ─── Table Cleanup ──────────────────────────────────────────────────────────

async function cleanTable(db: any, table: string) {
  await db.execute(sql.raw(`DELETE FROM ${table}`));
}

async function cleanAgentsAndRestore(
  db: any,
  api: ReturnType<typeof detectAPI>,
  testAgentId: UUID,
) {
  await cleanTable(db, "agents");
  // Restore via raw SQL to avoid adapter silently swallowing errors on old code
  await db.execute(
    sql`INSERT INTO agents (id, name, bio, message_examples, post_examples, topics, adjectives, plugins, settings, style)
        VALUES (${testAgentId}::uuid, 'Bench Agent', '["Test"]'::jsonb, '[[]]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb)`
  );
}

// ─── Data Generators ────────────────────────────────────────────────────────

function makeAgent(id?: UUID): any {
  return {
    id: id ?? (v4() as UUID),
    name: `Agent ${Math.random().toString(36).slice(2)}`,
    bio: ["Test agent"],
    lore: [],
    topics: ["test"],
    adjectives: ["test"],
    style: { all: ["casual"], chat: ["friendly"], post: ["informative"] },
    messageExamples: [[]],
    postExamples: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeEntity(agentId: UUID): any {
  return {
    id: v4() as UUID,
    agentId,
    names: [`Entity ${Math.random().toString(36).slice(2)}`],
    metadata: {},
  };
}

function makeMemoryItem(agentId: UUID, roomId: UUID, entityId?: UUID) {
  return {
    memory: {
      id: v4() as UUID,
      agentId,
      roomId,
      entityId: entityId ?? null,
      content: { text: `Mem ${Math.random().toString(36).slice(2)}` },
      createdAt: Date.now(),
    } as any,
    tableName: "memories",
  };
}

// ─── Timing Utilities ───────────────────────────────────────────────────────

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

async function bench(name: string, fn: () => Promise<void>): Promise<number> {
  for (let i = 0; i < WARMUP; i++) await fn();
  const times: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  const result = median(times);
  if (isDryRun) console.log(`  ${name}: OK (${result.toFixed(1)}ms)`);
  return result;
}

async function batchChunked<T>(items: T[], fn: (chunk: T[]) => Promise<any>) {
  for (let i = 0; i < items.length; i += CHUNK) {
    await fn(items.slice(i, i + CHUNK));
  }
}

const CHUNK = 1000;

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { adapter, testAgentId, api, cleanup } = await setupDatabase();
  const db = (adapter as any).getDatabase();

  const apiLabel = api.isNewAPI ? "NEW (batch-first)" : "OLD (singular)";
  console.log(`elizaOS Database API Benchmark`);
  console.log(`API detected: ${apiLabel}`);
  console.log(`N=${N}  iterations=${ITERATIONS}  warmup=${WARMUP}`);
  console.log("=".repeat(50));

  try {
    // ─── 1. Create Agents: Loop vs Batch ──────────────────────────────
    {
      const label = "createAgents";
      const agentsLoop = Array.from({ length: N }, () => makeAgent());
      const agentsBatch = Array.from({ length: N }, () => makeAgent());

      const loopMs = await bench(`${label} loop`, async () => {
        for (const a of agentsLoop) await api.createOneAgent(a);
        await cleanAgentsAndRestore(db, api, testAgentId);
      });

      const batchMs = await bench(`${label} batch`, async () => {
        await batchChunked(agentsBatch, (c) => api.createManyAgents(c));
        await cleanAgentsAndRestore(db, api, testAgentId);
      });

      if (!isDryRun) {
        console.log(`\n${label} (N=${N})`);
        console.log(`  loop:    ${loopMs.toFixed(1)}ms`);
        console.log(`  batch:   ${batchMs.toFixed(1)}ms`);
        console.log(`  speedup: ${(loopMs / batchMs).toFixed(1)}x`);
      }
    }

    // ─── 2. Create Entities: Loop vs Batch ────────────────────────────
    {
      const label = "createEntities";
      const entLoop = Array.from({ length: N }, () => makeEntity(testAgentId));
      const entBatch = Array.from({ length: N }, () =>
        makeEntity(testAgentId)
      );

      const loopMs = await bench(`${label} loop`, async () => {
        for (const e of entLoop) await api.createEntities([e]);
        await cleanTable(db, "entities");
      });

      const batchMs = await bench(`${label} batch`, async () => {
        await batchChunked(entBatch, (c) => api.createEntities(c));
        await cleanTable(db, "entities");
      });

      if (!isDryRun) {
        console.log(`\n${label} (N=${N})`);
        console.log(`  loop:    ${loopMs.toFixed(1)}ms`);
        console.log(`  batch:   ${batchMs.toFixed(1)}ms`);
        console.log(`  speedup: ${(loopMs / batchMs).toFixed(1)}x`);
      }
    }

    // ─── 3. Create Memories: Loop vs Batch ────────────────────────────
    {
      const label = "createMemories";
      const roomId = v4() as UUID;
      await api.createRooms([
        { id: roomId, agentId: testAgentId, source: "test", type: "GROUP" },
      ]);

      const memLoop = Array.from({ length: N }, () =>
        makeMemoryItem(testAgentId, roomId)
      );
      const memBatch = Array.from({ length: N }, () =>
        makeMemoryItem(testAgentId, roomId)
      );

      const loopMs = await bench(`${label} loop`, async () => {
        for (const m of memLoop)
          await api.createOneMemory(m.memory, m.tableName);
        await cleanTable(db, "memories");
      });

      const batchMs = await bench(`${label} batch`, async () => {
        await batchChunked(memBatch, (c) => api.createManyMemories(c));
        await cleanTable(db, "memories");
      });

      if (!isDryRun) {
        console.log(`\n${label} (N=${N})`);
        console.log(`  loop:    ${loopMs.toFixed(1)}ms`);
        console.log(`  batch:   ${batchMs.toFixed(1)}ms`);
        console.log(`  speedup: ${(loopMs / batchMs).toFixed(1)}x`);
      }
    }

    // ─── 4. Update Agents: Loop vs Batch ──────────────────────────────
    {
      const label = "updateAgents";
      const agents = Array.from({ length: N }, () => makeAgent());
      await batchChunked(agents, (c) => api.createManyAgents(c));

      const updates = agents.map((a) => ({
        agentId: a.id,
        agent: { name: `Updated ${a.name}` },
      }));

      const loopMs = await bench(`${label} loop`, async () => {
        for (const u of updates)
          await api.updateOneAgent(u.agentId, u.agent);
      });

      const batchMs = await bench(`${label} batch`, async () => {
        await batchChunked(updates, (c) => api.updateManyAgents(c));
      });

      await cleanAgentsAndRestore(db, api, testAgentId);

      if (!isDryRun) {
        console.log(`\n${label} (N=${N})`);
        console.log(`  loop:    ${loopMs.toFixed(1)}ms`);
        console.log(`  batch:   ${batchMs.toFixed(1)}ms`);
        console.log(`  speedup: ${(loopMs / batchMs).toFixed(1)}x`);
      }
    }

    // ─── 5. Upsert Agents (new API only) ──────────────────────────────
    {
      const label = "upsertAgents";
      if (api.hasUpsertAgents) {
        const agents = Array.from({ length: N }, () => makeAgent());
        const halfAgents = agents.slice(0, Math.floor(N / 2));
        await batchChunked(halfAgents, (c) => api.createManyAgents(c));

        const getCreateMs = await bench(`${label} get+create`, async () => {
          const existing = await adapter.getAgents();
          const existingIds = new Set(existing.map((a: any) => a.id));
          const toCreate = agents.filter((a) => !existingIds.has(a.id));
          if (toCreate.length > 0) await batchChunked(toCreate, (c) => api.createManyAgents(c));
          await cleanAgentsAndRestore(db, api, testAgentId);
        });

        await batchChunked(halfAgents, (c) => api.createManyAgents(c));

        const upsertMs = await bench(`${label} upsert`, async () => {
          await batchChunked(agents, (c) => api.upsertAgents(c));
          await cleanAgentsAndRestore(db, api, testAgentId);
        });

        if (!isDryRun) {
          console.log(`\n${label} (N=${N})`);
          console.log(`  get+create: ${getCreateMs.toFixed(1)}ms`);
          console.log(`  upsert:     ${upsertMs.toFixed(1)}ms`);
          console.log(`  speedup:    ${(getCreateMs / upsertMs).toFixed(1)}x`);
        }
      } else {
        if (!isDryRun) {
          console.log(`\n${label}: [NOT AVAILABLE in old API]`);
        } else {
          console.log(`  ${label}: [NOT AVAILABLE]`);
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // READ / QUERY BENCHMARKS  (exercise indexes)
    // ═══════════════════════════════════════════════════════════════════
    if (!isDryRun) {
      console.log(`\n${"─".repeat(50)}`);
      console.log("READ / QUERY benchmarks (indexes matter here)");
      console.log("─".repeat(50));
    }

    // Seed data for read benchmarks: we need a populated database
    const seedRooms: UUID[] = [];
    const seedEntityIds: UUID[] = [];
    const ROOMS_COUNT = 10;
    for (let i = 0; i < ROOMS_COUNT; i++) {
      const rid = v4() as UUID;
      seedRooms.push(rid);
      await api.createRooms([
        { id: rid, agentId: testAgentId, source: "test", type: "GROUP" },
      ]);
    }
    // Entities — insert in chunks to avoid PGLite statement-size limits
    const seedEntities = Array.from({ length: N }, () => makeEntity(testAgentId));
    console.log(`  seeding ${N} entities (${Math.ceil(N / CHUNK)} chunks)…`);
    for (let i = 0; i < seedEntities.length; i += CHUNK) {
      await api.createEntities(seedEntities.slice(i, i + CHUNK));
    }
    for (const e of seedEntities) seedEntityIds.push(e.id);

    // Add participants to rooms (old: addParticipantsRoom, new: createRoomParticipants)
    const addParticipants: (eIds: UUID[], rId: UUID) => Promise<any> =
      (adapter as any).createRoomParticipants?.bind(adapter)
      ?? (adapter as any).addParticipantsRoom?.bind(adapter);

    if (addParticipants) {
      for (const rid of seedRooms) {
        const slice = seedEntityIds.slice(0, 10);
        await addParticipants(slice, rid);
      }
    }

    // Memories: N memories spread across rooms — chunked
    const seedMemories = seedRooms.flatMap((rid) =>
      Array.from({ length: Math.ceil(N / ROOMS_COUNT) }, () =>
        makeMemoryItem(testAgentId, rid)
      )
    );
    console.log(`  seeding ${seedMemories.length} memories (${Math.ceil(seedMemories.length / CHUNK)} chunks)…`);
    for (let i = 0; i < seedMemories.length; i += CHUNK) {
      await api.createManyMemories(seedMemories.slice(i, i + CHUNK));
    }

    // Also seed some worlds for getRoomsByWorld
    const worldId = v4() as UUID;
    const createWorld: (w: any) => Promise<any> =
      (adapter as any).createWorlds?.bind(adapter)
      ?? (adapter as any).createWorld?.bind(adapter);
    if (createWorld) {
      const worldObj = {
        id: worldId,
        agentId: testAgentId,
        name: "Bench World",
        serverId: "bench-server",
      };
      try {
        // new API: createWorlds([world])
        if (typeof (adapter as any).createWorlds === "function") {
          await (adapter as any).createWorlds([worldObj]);
        } else {
          await (adapter as any).createWorld(worldObj);
        }
      } catch (_e) {
        // ignore if world creation fails - getRoomsByWorld will just return empty
      }
    }
    // Assign some rooms to the world via updateRoom
    for (const rid of seedRooms.slice(0, 5)) {
      try {
        await (adapter as any).updateRoom({ id: rid, worldId, agentId: testAgentId, source: "test", type: "GROUP" });
      } catch (_e) { /* ok */ }
    }

    // ─── 6. getMemories by room + type (idx_memories_type_room) ───────
    {
      const label = "getMemories";
      const targetRoom = seedRooms[0];
      const ms = await bench(label, async () => {
        await adapter.getMemories({
          roomId: targetRoom,
          tableName: "memories",
          agentId: testAgentId,
          count: 50,
        });
      });
      if (!isDryRun) console.log(`\n${label} (room+type idx): ${ms.toFixed(1)}ms`);
    }

    // ─── 7. countMemories (idx_memories_type_room) ────────────────────
    {
      const label = "countMemories";
      const targetRoom = seedRooms[0];
      const ms = await bench(label, async () => {
        await adapter.countMemories({ roomIds: [targetRoom], unique: false, tableName: "memories" });
      });
      if (!isDryRun) console.log(`${label} (room+type idx): ${ms.toFixed(1)}ms`);
    }

    // ─── 8. getMemoriesByRoomIds (idx_memories_type_room) ─────────────
    {
      const label = "getMemoriesByRoomIds";
      const ms = await bench(label, async () => {
        await adapter.getMemoriesByRoomIds({
          roomIds: seedRooms,
          tableName: "memories",
          agentId: testAgentId,
        });
      });
      if (!isDryRun) console.log(`${label} (multi-room): ${ms.toFixed(1)}ms`);
    }

    // ─── 9. getParticipantsForRoom (idx_participants_room) ────────────
    {
      const label = "getParticipantsForRoom";
      const targetRoom = seedRooms[0];
      const ms = await bench(label, async () => {
        await adapter.getParticipantsForRoom(targetRoom);
      });
      if (!isDryRun) console.log(`${label} (idx): ${ms.toFixed(1)}ms`);
    }

    // ─── 10. getRoomsByWorld (idx_rooms_world) ────────────────────────
    {
      const label = "getRoomsByWorld";
      const ms = await bench(label, async () => {
        await adapter.getRoomsByWorld(worldId);
      });
      if (!isDryRun) console.log(`${label} (idx): ${ms.toFixed(1)}ms`);
    }

    // ─── 11. getEntitiesByIds (primary key) ──────────────────────────
    {
      const label = "getEntitiesByIds";
      const targetIds = seedEntityIds.slice(0, 10);
      const ms = await bench(label, async () => {
        await adapter.getEntitiesByIds(targetIds);
      });
      if (!isDryRun) console.log(`${label} (10 ids): ${ms.toFixed(1)}ms`);
    }

    // ─── 12. getRoomsByIds (primary key) ─────────────────────────────
    {
      const label = "getRoomsByIds";
      const ms = await bench(label, async () => {
        await adapter.getRoomsByIds(seedRooms);
      });
      if (!isDryRun) console.log(`${label} (${seedRooms.length} ids): ${ms.toFixed(1)}ms`);
    }

    // ─── 13. getEntitiesForRoom (idx_components/participants) ────────
    {
      const label = "getEntitiesForRoom";
      if (typeof (adapter as any).getEntitiesForRoom === "function") {
        const targetRoom = seedRooms[0];
        const ms = await bench(label, async () => {
          await (adapter as any).getEntitiesForRoom(targetRoom, testAgentId);
        });
        if (!isDryRun) console.log(`${label} (idx): ${ms.toFixed(1)}ms`);
      } else {
        if (isDryRun) console.log(`  ${label}: [NOT AVAILABLE]`);
      }
    }

    // ─── 14. Full-table scan baseline: getAgents (no filter) ─────────
    {
      const label = "getAgents (full scan)";
      const ms = await bench(label, async () => {
        await adapter.getAgents();
      });
      if (!isDryRun) console.log(`${label}: ${ms.toFixed(1)}ms`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // NEW COMPOSITE INDEX BENCHMARKS  (indexes added in new code)
    // ═══════════════════════════════════════════════════════════════════
    if (!isDryRun) {
      console.log(`\n${"─".repeat(50)}`);
      console.log("NEW composite index benchmarks");
      console.log("─".repeat(50));
    }

    // Seed components, tasks, logs, relationships for the new index tests
    const createComponents: (c: any[]) => Promise<any> =
      (adapter as any).createComponents?.bind(adapter);
    const createTasks: (t: any[]) => Promise<any> =
      (adapter as any).createTasks?.bind(adapter);
    const createLogs: (l: any[]) => Promise<any> =
      (adapter as any).createLogs?.bind(adapter);
    const createRelationships: (r: any[]) => Promise<any> =
      (adapter as any).createRelationships?.bind(adapter);

    const seedComponentCount = Math.min(N, 1000);

    if (createComponents) {
      const comps = Array.from({ length: seedComponentCount }, (_, i) => ({
        entityId: seedEntityIds[i % seedEntityIds.length],
        agentId: testAgentId,
        roomId: seedRooms[i % seedRooms.length],
        worldId: worldId,
        type: i % 2 === 0 ? "profile" : "settings",
        data: { idx: i },
      }));
      try { await createComponents(comps); } catch (_e) { /* ok */ }
    }

    if (createTasks) {
      const tasks = Array.from({ length: seedComponentCount }, (_, i) => ({
        name: i % 3 === 0 ? "SEND_MESSAGE" : i % 3 === 1 ? "CHECK_STATUS" : "PROCESS_DATA",
        description: `Task ${i}`,
        agentId: testAgentId,
        roomId: seedRooms[i % seedRooms.length],
        tags: ["bench"],
        metadata: { idx: i },
      }));
      try { await createTasks(tasks); } catch (_e) { /* ok */ }
    }

    if (createLogs) {
      const logs = Array.from({ length: seedComponentCount }, (_, i) => ({
        body: { message: `Log ${i}` },
        entityId: seedEntityIds[i % seedEntityIds.length],
        roomId: seedRooms[i % seedRooms.length],
        type: i % 2 === 0 ? "info" : "error",
      }));
      try { await createLogs(logs); } catch (_e) { /* ok */ }
    }

    if (createRelationships) {
      const rels = Array.from({ length: Math.min(100, seedEntityIds.length / 2) }, (_, i) => ({
        sourceEntityId: seedEntityIds[i * 2],
        targetEntityId: seedEntityIds[i * 2 + 1],
        agentId: testAgentId,
        tags: ["bench"],
        metadata: {},
      }));
      try { await createRelationships(rels); } catch (_e) { /* ok */ }
    }

    // ─── 15. getComponents by entity+type (idx_components_entity_type) NEW ─
    {
      const label = "getComponents (entity+type)";
      const getComps: any = (adapter as any).getComponents?.bind(adapter);
      if (getComps) {
        const targetEntity = seedEntityIds[0];
        const ms = await bench(label, async () => {
          await getComps(targetEntity, worldId);
        });
        if (!isDryRun) console.log(`\n${label}: ${ms.toFixed(1)}ms  [idx_components_entity_type] NEW`);
      } else {
        if (!isDryRun) console.log(`\n${label}: [NOT AVAILABLE]`);
      }
    }

    // ─── 16. getComponent by entity+type (idx_components_entity_type) NEW ──
    {
      const label = "getComponent (entity+type exact)";
      const getComp: any = (adapter as any).getComponent?.bind(adapter);
      if (getComp) {
        const targetEntity = seedEntityIds[0];
        const ms = await bench(label, async () => {
          await getComp(targetEntity, "profile", worldId);
        });
        if (!isDryRun) console.log(`${label}: ${ms.toFixed(1)}ms  [idx_components_entity_type] NEW`);
      } else {
        if (!isDryRun) console.log(`${label}: [NOT AVAILABLE]`);
      }
    }

    // ─── 17. getTasks by agent+name (idx_tasks_agent_name) NEW ────────────
    {
      const label = "getTasksByName (agent+name)";
      const getByName: any = (adapter as any).getTasksByName?.bind(adapter);
      if (getByName) {
        const ms = await bench(label, async () => {
          await getByName("SEND_MESSAGE");
        });
        if (!isDryRun) console.log(`${label}: ${ms.toFixed(1)}ms  [idx_tasks_agent_name] NEW`);
      } else {
        if (!isDryRun) console.log(`${label}: [NOT AVAILABLE]`);
      }
    }

    // ─── 18. getLogs by room+type+created (idx_logs_room_type_created) NEW ─
    {
      const label = "getLogs (room+type)";
      const getLogs: any = (adapter as any).getLogs?.bind(adapter);
      if (getLogs) {
        const ms = await bench(label, async () => {
          await getLogs({ roomId: seedRooms[0], type: "info", count: 50 });
        });
        if (!isDryRun) console.log(`${label}: ${ms.toFixed(1)}ms  [idx_logs_room_type_created] NEW`);
      } else {
        if (!isDryRun) console.log(`${label}: [NOT AVAILABLE]`);
      }
    }

    // ─── 19. getLogs by entity+type (idx_logs_entity_type) NEW ────────────
    {
      const label = "getLogs (entity+type)";
      const getLogs: any = (adapter as any).getLogs?.bind(adapter);
      if (getLogs) {
        const ms = await bench(label, async () => {
          await getLogs({ entityId: seedEntityIds[0], type: "error", count: 50 });
        });
        if (!isDryRun) console.log(`${label}: ${ms.toFixed(1)}ms  [idx_logs_entity_type] NEW`);
      } else {
        if (!isDryRun) console.log(`${label}: [NOT AVAILABLE]`);
      }
    }

    // ─── 20. getRelationships (idx_relationships_users) NEW ───────────────
    {
      const label = "getRelationships (entity)";
      const getRels: any = (adapter as any).getRelationships?.bind(adapter);
      if (getRels) {
        const ms = await bench(label, async () => {
          await getRels({ entityId: seedEntityIds[0] });
        });
        if (!isDryRun) console.log(`${label}: ${ms.toFixed(1)}ms  [idx_relationships_users] NEW`);
      } else {
        if (!isDryRun) console.log(`${label}: [NOT AVAILABLE]`);
      }
    }

    // ─── 21. getMemories by agent+type (idx_memories_agent_type) NEW ──────
    {
      const label = "getMemories (agent+type)";
      const ms = await bench(label, async () => {
        await adapter.getMemories({
          agentId: testAgentId,
          tableName: "memories",
          count: 50,
        });
      });
      if (!isDryRun) console.log(`${label}: ${ms.toFixed(1)}ms  [idx_memories_agent_type] NEW`);
    }

    // ─── Print Summary ────────────────────────────────────────────────
    console.log(`\n${"=".repeat(50)}`);
    console.log(isDryRun ? "Dry run completed successfully!" : "Done!");
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
