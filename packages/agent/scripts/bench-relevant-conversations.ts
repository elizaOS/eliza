/**
 * Stage-decomposition micro-bench for the relevant-conversations provider's
 * recall pipeline against a real PGlite-backed AgentRuntime. Seeds a local
 * corpus (message memories with HNSW-indexed embeddings across many rooms plus
 * a hash-memory room), then times each pipeline stage independently — current
 * room fetch, access-context build, hash-memory scan + BM25 rank, recall
 * embed, semantic vector search (threshold-in-SQL vs threshold-post-filter
 * query shapes, with EXPLAIN ANALYZE), room resolution (sequential getRoom vs
 * one batched getRoomsByIds), and the provider end-to-end — so critical-path
 * fixes attack measured dominators instead of guesses.
 *
 * Run from the repo root:
 *   bun packages/agent/scripts/bench-relevant-conversations.ts \
 *     [--vectors=8000] [--hash=2000] [--rooms=64] [--reps=5] [--embed-ms=0]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  AgentRuntime,
  buildAccessContext,
  embedRecallQuery,
  ModelType,
  type Plugin,
  type Room,
  type State,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { HASH_MEMORY_SOURCE, rankByKeyword } from "../src/api/memory-routes.ts";
import { relevantConversationsProvider } from "../src/providers/relevant-conversations.ts";
import {
  executeRawSql,
  extractRows,
} from "../src/runtime/trajectory-internals.ts";

interface BenchArgs {
  vectors: number;
  hash: number;
  rooms: number;
  reps: number;
  embedMs: number;
}

function parseArgs(): BenchArgs {
  const defaults: BenchArgs = {
    vectors: 8000,
    hash: 2000,
    rooms: 64,
    reps: 5,
    embedMs: 0,
  };
  for (const arg of process.argv.slice(2)) {
    const match = /^--([a-z-]+)=(\d+)$/.exec(arg);
    if (!match) continue;
    const value = Number(match[2]);
    if (match[1] === "vectors") defaults.vectors = value;
    if (match[1] === "hash") defaults.hash = value;
    if (match[1] === "rooms") defaults.rooms = value;
    if (match[1] === "reps") defaults.reps = value;
    if (match[1] === "embed-ms") defaults.embedMs = value;
  }
  return defaults;
}

/** Deterministic PRNG so every run seeds the identical corpus. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIM = 384;

function normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => Number((v / norm).toFixed(6)));
}

function randomVector(rand: () => number): number[] {
  return Array.from({ length: DIM }, () => rand() * 2 - 1);
}

/** Deterministic text -> unit vector (stands in for the embedding model). */
function textToVector(text: string): number[] {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return normalize(randomVector(mulberry32(hash >>> 0)));
}

/** Cluster around a topic center so the corpus geometry resembles real text
 * embeddings (unrelated docs at moderate similarity, not near-orthogonal). */
function clusteredVector(
  center: number[],
  rand: () => number,
  closeness: number,
): number[] {
  const noise = randomVector(rand);
  return normalize(
    center.map((c, i) => closeness * c + (1 - closeness) * noise[i]),
  );
}

function vectorLiteral(vec: number[]): string {
  return `[${vec.map((v) => v.toFixed(6)).join(",")}]`;
}

function quantile(sorted: number[], q: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

interface StageResult {
  label: string;
  median: number;
  min: number;
  max: number;
}

const results: StageResult[] = [];

async function timeStage(
  label: string,
  reps: number,
  fn: () => Promise<unknown>,
): Promise<StageResult> {
  const samples: number[] = [];
  for (let i = 0; i < reps; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const stage: StageResult = {
    label,
    median: quantile(samples, 0.5),
    min: samples[0],
    max: samples[samples.length - 1],
  };
  results.push(stage);
  process.stdout.write(
    `  ${label.padEnd(58)} median=${stage.median.toFixed(1)}ms min=${stage.min.toFixed(1)}ms max=${stage.max.toFixed(1)}ms\n`,
  );
  return stage;
}

const HASH_SENTENCES = [
  "the launch window for the connector rollout is the first week of the month",
  "billing reconciliation runs nightly and posts a ledger summary to the ops room",
  "the staging canary needs a manual promote before the prod deploy can start",
  "remember that the vector index rebuild happens on the first boot after upgrade",
  "the desktop shell pins the api port registry under the state directory",
  "trajectory captures drain their write queue before the viewer reads them",
  "the media store is content addressed by sha256 and garbage collected weekly",
  "scheduling conflicts resolve through the shared task service clock",
];

function hashMemoryText(rand: () => number, index: number): string {
  const base = HASH_SENTENCES[index % HASH_SENTENCES.length];
  const filler = Math.floor(rand() * 3) + 1;
  return `${base} (note ${index}, detail level ${filler})`;
}

const SCARCE_QUERY =
  "did we ever settle the question about the quarterly hardware budget approval flow";
const MATCH_QUERY =
  "what did we decide about the launch date for the connector rollout";

async function main(): Promise<void> {
  const args = parseArgs();
  process.stdout.write(
    `relevant-conversations stage bench — vectors=${args.vectors} hash=${args.hash} rooms=${args.rooms} reps=${args.reps} embed-ms=${args.embedMs}\n`,
  );

  const prevPgliteDir = process.env.PGLITE_DATA_DIR;
  const pgliteDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-recall-bench-"),
  );
  process.env.PGLITE_DATA_DIR = pgliteDir;

  const runtime = new AgentRuntime({
    character: { name: "Eliza" },
    plugins: [],
    logLevel: "error",
    enableAutonomy: false,
  });

  const pluginSqlModule = (await import(
    ["@elizaos", "plugin-sql"].join("/")
  )) as {
    default?: Plugin;
    plugin?: Plugin;
  };
  const pluginSql = pluginSqlModule.default ?? pluginSqlModule.plugin;
  if (!pluginSql) throw new Error("plugin-sql did not export a plugin");
  await runtime.registerPlugin(pluginSql);
  await runtime.initialize();

  try {
    await run(runtime, args);
  } finally {
    await runtime.stop();
    if (prevPgliteDir === undefined) {
      delete process.env.PGLITE_DATA_DIR;
    } else {
      process.env.PGLITE_DATA_DIR = prevPgliteDir;
    }
    fs.rmSync(pgliteDir, { recursive: true, force: true });
  }
}

async function run(runtime: AgentRuntime, args: BenchArgs): Promise<void> {
  const rand = mulberry32(0xe11a);
  const agentId = runtime.agentId;
  const worldId = stringToUuid("bench-world") as UUID;
  const userEntityId = stringToUuid("bench-user") as UUID;
  const currentRoomId = stringToUuid("bench-current-room") as UUID;
  const hashRoomId = stringToUuid("Eliza-hash-memory-room") as UUID;

  await runtime.createWorld({
    id: worldId,
    name: "bench world",
    agentId,
    messageServerId: stringToUuid("bench-server") as UUID,
  });
  await runtime.createEntity({
    id: userEntityId,
    names: ["Bench User"],
    agentId,
  });

  const roomIds: UUID[] = [];
  const roomRows: Room[] = [];
  for (let i = 0; i < args.rooms; i++) {
    const id = stringToUuid(`bench-room-${i}`) as UUID;
    roomIds.push(id);
    roomRows.push({
      id,
      name: `bench room ${i}`,
      agentId,
      source: "discord",
      type: "GROUP" as Room["type"],
      worldId,
    });
  }
  roomRows.push(
    {
      id: currentRoomId,
      name: "current room",
      agentId,
      source: "discord",
      type: "GROUP" as Room["type"],
      worldId,
    },
    {
      id: hashRoomId,
      name: "hash memory room",
      agentId,
      source: "agent",
      type: "GROUP" as Room["type"],
      worldId,
    },
  );
  await runtime.createRooms(roomRows);

  // ---- Seed corpus via chunked multi-row inserts (fast on PGlite) ----
  process.stdout.write("seeding corpus...\n");
  const seedStart = performance.now();

  const centers = Array.from({ length: 32 }, () =>
    normalize(randomVector(rand)),
  );
  const matchVector = textToVector(MATCH_QUERY);

  const CHUNK = 250;
  let seeded = 0;
  while (seeded < args.vectors) {
    const batch = Math.min(CHUNK, args.vectors - seeded);
    const memoryValues: string[] = [];
    const embeddingValues: string[] = [];
    for (let i = 0; i < batch; i++) {
      const index = seeded + i;
      const id = stringToUuid(`bench-memory-${index}`) as UUID;
      const roomId = roomIds[index % roomIds.length];
      const entityId = index % 3 === 0 ? agentId : userEntityId;
      // The first 24 docs sit near the match query so the plentiful-match path
      // has real hits; everything else clusters around topic centers.
      const vec =
        index < 24
          ? clusteredVector(matchVector, rand, 0.92)
          : clusteredVector(centers[index % centers.length], rand, 0.55);
      const text = `seed message ${index} about topic ${index % centers.length} in room ${index % roomIds.length}`;
      const createdAt = new Date(Date.now() - index * 60_000).toISOString();
      memoryValues.push(
        `('${id}', 'messages', '${createdAt}', ` +
          `'${JSON.stringify({ text, source: "discord" })}'::jsonb, ` +
          `'${entityId}', '${agentId}', '${roomId}', '${worldId}', true, '{}'::jsonb)`,
      );
      embeddingValues.push(
        `(gen_random_uuid(), '${id}', now(), '${vectorLiteral(vec)}'::vector)`,
      );
    }
    await executeRawSql(
      runtime,
      `INSERT INTO memories (id, type, created_at, content, entity_id, agent_id, room_id, world_id, "unique", metadata) VALUES ${memoryValues.join(",")}`,
    );
    await executeRawSql(
      runtime,
      `INSERT INTO embeddings (id, memory_id, created_at, dim_384) VALUES ${embeddingValues.join(",")}`,
    );
    seeded += batch;
  }

  let hashSeeded = 0;
  while (hashSeeded < args.hash) {
    const batch = Math.min(CHUNK, args.hash - hashSeeded);
    const values: string[] = [];
    for (let i = 0; i < batch; i++) {
      const index = hashSeeded + i;
      const id = stringToUuid(`bench-hash-${index}`) as UUID;
      const text = hashMemoryText(rand, index);
      const createdAt = new Date(Date.now() - index * 30_000).toISOString();
      values.push(
        `('${id}', 'messages', '${createdAt}', ` +
          `'${JSON.stringify({ text, source: HASH_MEMORY_SOURCE })}'::jsonb, ` +
          `'${agentId}', '${agentId}', '${hashRoomId}', '${worldId}', true, '{}'::jsonb)`,
      );
    }
    await executeRawSql(
      runtime,
      `INSERT INTO memories (id, type, created_at, content, entity_id, agent_id, room_id, world_id, "unique", metadata) VALUES ${values.join(",")}`,
    );
    hashSeeded += batch;
  }

  // Register the deterministic embedding model, then build the HNSW index over
  // the seeded corpus in one pass (the adapter creates it during the dimension
  // ensure) and refresh planner stats.
  const embedMs = args.embedMs;
  runtime.registerModel(
    ModelType.TEXT_EMBEDDING,
    async (_runtime, params) => {
      if (embedMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, embedMs));
      }
      // The dimension probe may call with null/absent params; any input maps
      // to a deterministic 384-wide vector.
      const text =
        params !== null &&
        typeof params === "object" &&
        typeof (params as { text?: unknown }).text === "string"
          ? (params as { text: string }).text
          : "dimension probe";
      return textToVector(text);
    },
    "bench",
    1000,
  );
  await runtime.ensureEmbeddingDimension();
  await executeRawSql(runtime, "ANALYZE memories");
  await executeRawSql(runtime, "ANALYZE embeddings");
  process.stdout.write(
    `seeded ${args.vectors} vectors + ${args.hash} hash rows in ${((performance.now() - seedStart) / 1000).toFixed(1)}s\n\n`,
  );

  const message = {
    id: stringToUuid("bench-message") as UUID,
    entityId: userEntityId,
    agentId,
    roomId: currentRoomId,
    content: { text: SCARCE_QUERY, source: "discord" },
    createdAt: Date.now(),
  };
  const matchMessage = {
    ...message,
    id: stringToUuid("bench-message-match") as UUID,
    content: { text: MATCH_QUERY, source: "discord" },
  };
  const emptyState: State = { values: {}, data: {}, text: "" };
  const scarceVector = textToVector(SCARCE_QUERY);
  const accessContext = await buildAccessContext(runtime, message);

  // ---- EXPLAIN ANALYZE both semantic-search query shapes ----
  const oldShape = (vec: number[]) =>
    `SELECT m.id, 1 - (e.dim_384 <=> '${vectorLiteral(vec)}'::vector) AS similarity ` +
    `FROM embeddings e JOIN memories m ON m.id = e.memory_id ` +
    `WHERE e.dim_384 IS NOT NULL AND m.type = 'messages' AND m.agent_id = '${agentId}' ` +
    `AND 1 - (e.dim_384 <=> '${vectorLiteral(vec)}'::vector) >= 0.7 ` +
    `ORDER BY e.dim_384 <=> '${vectorLiteral(vec)}'::vector ASC LIMIT 15`;
  const newShape = (vec: number[]) =>
    `SELECT m.id, 1 - (e.dim_384 <=> '${vectorLiteral(vec)}'::vector) AS similarity ` +
    `FROM embeddings e JOIN memories m ON m.id = e.memory_id ` +
    `WHERE e.dim_384 IS NOT NULL AND m.type = 'messages' AND m.agent_id = '${agentId}' ` +
    `ORDER BY e.dim_384 <=> '${vectorLiteral(vec)}'::vector ASC LIMIT 15`;

  for (const [label, sqlText] of [
    [
      "threshold-in-SQL (current adapter shape), scarce-match query",
      oldShape(scarceVector),
    ],
    [
      "no-threshold top-K (post-filter shape), scarce-match query",
      newShape(scarceVector),
    ],
  ] as const) {
    const explain = await executeRawSql(runtime, `EXPLAIN ANALYZE ${sqlText}`);
    process.stdout.write(`EXPLAIN ANALYZE — ${label}\n`);
    for (const row of extractRows(explain)) {
      const record = row as Record<string, unknown>;
      process.stdout.write(`  ${String(record["QUERY PLAN"])}\n`);
    }
    process.stdout.write("\n");
  }

  // ---- Stage timings ----
  process.stdout.write("stage timings:\n");
  const reps = args.reps;

  await timeStage("getRoom(current) — cold adapter read", reps, () =>
    runtime.getRoomsByIds([currentRoomId]),
  );
  await timeStage("buildAccessContext", reps, () =>
    buildAccessContext(runtime, message),
  );

  let hashRows: Awaited<ReturnType<typeof runtime.getMemories>> = [];
  await timeStage(
    `hash-memory getMemories (limit 2000, ${args.hash} rows)`,
    reps,
    async () => {
      hashRows = await runtime.getMemories({
        roomId: hashRoomId,
        tableName: "messages",
        limit: 2000,
        includeEmbedding: false,
        accessContext,
      });
    },
  );
  await timeStage(
    `BM25 rankByKeyword over ${hashRows.length} rows`,
    reps,
    async () =>
      rankByKeyword(SCARCE_QUERY, hashRows, (m) =>
        typeof m.content.text === "string" ? m.content.text : "",
      ),
  );
  await timeStage(
    `embedRecallQuery (simulated ${args.embedMs}ms model)`,
    reps,
    () => embedRecallQuery(runtime, SCARCE_QUERY),
  );

  await timeStage(
    "runtime.searchMemories (checked-out adapter), scarce-match query",
    reps,
    () =>
      runtime.searchMemories({
        embedding: scarceVector,
        tableName: "messages",
        match_threshold: 0.7,
        limit: 15,
        accessContext,
      }),
  );
  await timeStage(
    "runtime.searchMemories (checked-out adapter), plentiful-match query",
    reps,
    () =>
      runtime.searchMemories({
        embedding: textToVector(MATCH_QUERY),
        tableName: "messages",
        match_threshold: 0.7,
        limit: 15,
        accessContext,
      }),
  );
  await timeStage(
    "raw SQL threshold-in-SQL shape, scarce-match query",
    reps,
    () => executeRawSql(runtime, oldShape(scarceVector)),
  );
  await timeStage(
    "raw SQL no-threshold top-K shape, scarce-match query",
    reps,
    () => executeRawSql(runtime, newShape(scarceVector)),
  );
  await timeStage(
    "raw SQL threshold-in-SQL shape, plentiful-match query",
    reps,
    () => executeRawSql(runtime, oldShape(textToVector(MATCH_QUERY))),
  );
  await timeStage(
    "raw SQL no-threshold top-K shape, plentiful-match query",
    reps,
    () => executeRawSql(runtime, newShape(textToVector(MATCH_QUERY))),
  );

  const resultRooms = roomIds.slice(0, 10);
  await timeStage(
    "room resolve — 10x sequential getRoomsByIds([id])",
    reps,
    async () => {
      for (const id of resultRooms) {
        await runtime.getRoomsByIds([id]);
      }
    },
  );
  await timeStage("room resolve — 1x batched getRoomsByIds(ids)", reps, () =>
    runtime.getRoomsByIds(resultRooms),
  );

  await timeStage("provider.get end-to-end, scarce-match query", reps, () =>
    relevantConversationsProvider.get(runtime, message, emptyState),
  );
  await timeStage("provider.get end-to-end, plentiful-match query", reps, () =>
    relevantConversationsProvider.get(runtime, matchMessage, emptyState),
  );

  process.stdout.write("\nsummary (median ms):\n");
  for (const stage of results) {
    process.stdout.write(
      `  ${stage.label.padEnd(58)} ${stage.median.toFixed(1)}\n`,
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `bench failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
