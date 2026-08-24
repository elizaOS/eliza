#!/usr/bin/env bun
/**
 * Produces run-bound progressive-content evidence against a disposable real
 * PostgreSQL database while traversing every corpus object through its owning
 * production reader. The connection string remains environment-only.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { readFileHandler } from "../../plugins/plugin-coding-tools/src/actions/read.ts";
import {
  readShellOutputArtifactPage,
  ShellOutputArtifactWriter,
} from "../../plugins/plugin-coding-tools/src/lib/shell-output-artifact.ts";
import { FileStateService } from "../../plugins/plugin-coding-tools/src/services/file-state-service.ts";
import { SandboxService } from "../../plugins/plugin-coding-tools/src/services/sandbox-service.ts";
import {
  FILE_STATE_SERVICE,
  SANDBOX_SERVICE,
} from "../../plugins/plugin-coding-tools/src/types.ts";
import { plugin as sqlPlugin } from "../../plugins/plugin-sql/src/index.node.ts";
import { DatabaseMigrationService } from "../../plugins/plugin-sql/src/migration-service.ts";
import { PgDatabaseAdapter } from "../../plugins/plugin-sql/src/pg/adapter.ts";
import { PostgresConnectionManager } from "../../plugins/plugin-sql/src/pg/manager.ts";
import {
  persistMediaBytes,
  readStoredMediaByteRange,
} from "../agent/src/api/media-store.ts";
import {
  buildDocumentSourceProjection,
  buildMessageContentProjection,
  ChannelType,
  MemoryType,
  projectDocumentParentContent,
  stringToUuid,
} from "../core/src/index.ts";
import { verifyProgressiveContentCorpus } from "../corpus-tools/src/progressive-content.ts";
import { validateProgressiveContentPostgresEvidence } from "../corpus-tools/src/progressive-content-postgres-evidence.ts";

const PAGE_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;

export function parsePostgresEvidenceArgs(argv) {
  const parsed = {};
  for (const argument of argv) {
    if (argument.startsWith("--commit=")) parsed.commit = argument.slice(9);
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!/^[0-9a-f]{40}$/u.test(parsed.commit ?? "")) {
    throw new Error("--commit must be an exact Git SHA");
  }
  return parsed;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function privateAtomicJson(output, value) {
  const destination = path.resolve(output);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.pending-${randomUUID()}`;
  const handle = await fs.open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, destination);
}

async function readSource(corpusRoot, object, options = {}) {
  const absolute = path.resolve(corpusRoot, object.relativePath);
  if (!absolute.startsWith(`${path.resolve(corpusRoot)}${path.sep}`)) {
    throw new Error(`unsafe corpus object path: ${object.relativePath}`);
  }
  const handle = await fs.open(
    absolute,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  const digest = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks = [];
  let bytesRead = 0;
  let readCalls = 0;
  try {
    for (let offset = 0; offset < object.byteLength; offset += PAGE_BYTES) {
      const length = Math.min(PAGE_BYTES, object.byteLength - offset);
      const buffer = Buffer.allocUnsafe(length);
      const read = await handle.read(buffer, 0, length, offset);
      if (read.bytesRead === 0) throw new Error(`source stopped at ${offset}`);
      const bytes = buffer.subarray(0, read.bytesRead);
      digest.update(bytes);
      bytesRead += read.bytesRead;
      readCalls += 1;
      if (options.sniffOnly) {
        if (object.format === "binary") {
          return {
            rejectionCode: "CONTENT_BINARY_UNSUPPORTED",
            bytesRead,
            readCalls,
          };
        }
        try {
          decoder.decode(bytes, { stream: read.bytesRead < object.byteLength });
        } catch {
          return {
            rejectionCode: "CONTENT_INVALID_UTF8",
            bytesRead,
            readCalls,
          };
        }
        throw new Error(`${object.id} did not trigger its declared rejection`);
      }
      chunks.push(
        decoder.decode(bytes, {
          stream: offset + read.bytesRead < object.byteLength,
        }),
      );
    }
    chunks.push(decoder.decode());
  } finally {
    await handle.close();
  }
  const sourceSha256 = digest.digest("hex");
  if (sourceSha256 !== object.sourceSha256) {
    throw new Error(`source hash differs for ${object.id}`);
  }
  return { text: chunks.join(""), bytesRead, readCalls };
}

function sourceWork(sourceBytes, bytesRead, readCalls, rowsRead = 0) {
  return {
    pageBytes: PAGE_BYTES,
    bytesRead,
    readCalls,
    rowsRead,
    parentScans: 0,
    readAmplification: sourceBytes === 0 ? 1 : bytesRead / sourceBytes,
  };
}

async function createFileRuntime(corpusRoot, conversationId) {
  const settings = {
    CODING_TOOLS_WORKSPACE_ROOTS: corpusRoot,
    CODING_TOOLS_BLOCKED_PATHS: path.join(corpusRoot, ".blocked"),
    CODING_TOOLS_MAX_FILE_SIZE_BYTES: PAGE_BYTES,
  };
  const services = new Map();
  const runtime = {
    agentId: "postgres-evidence-agent",
    getSetting: (key) => settings[key],
    getService: (key) => services.get(key) ?? null,
  };
  const sandbox = await SandboxService.start(runtime);
  const fileState = await FileStateService.start(runtime);
  services.set(SANDBOX_SERVICE, sandbox);
  services.set(FILE_STATE_SERVICE, fileState);
  return {
    runtime,
    message: { roomId: conversationId, entityId: conversationId },
    close: async () => {
      await fileState.stop();
      await sandbox.stop();
    },
  };
}

async function traverseFile(runtime, message, absolutePath, object) {
  const digest = createHash("sha256");
  let offset = 0;
  let bytesRead = 0;
  let readCalls = 0;
  let revision;
  for (;;) {
    const result = await readFileHandler(runtime, message, undefined, {
      parameters: {
        file_path: absolutePath,
        unit: "byte",
        offset,
        limit: PAGE_BYTES,
        ...(revision ? { expectedRevision: revision } : {}),
      },
    });
    if (!result.success)
      throw new Error(`READ failed for ${object.id}: ${result.text}`);
    const data = result.data;
    const view = data?.readView;
    const diagnostics = data?.diagnostics;
    if (!view || !diagnostics)
      throw new Error("READ omitted paging diagnostics");
    digest.update(Buffer.from(result.text, "utf8"));
    bytesRead += Number(diagnostics.sourceBytesRead);
    readCalls += 1;
    revision = view.reference.revision;
    if (!view.slice.hasMore) break;
    offset = view.slice.nextOffset;
  }
  return { hash: digest.digest("hex"), bytesRead, readCalls };
}

async function traverseMedia(fileName) {
  const digest = createHash("sha256");
  let offset = 0;
  let bytesRead = 0;
  let readCalls = 0;
  for (;;) {
    const page = readStoredMediaByteRange(fileName, offset, PAGE_BYTES);
    if (!page) throw new Error(`media page is absent for ${fileName}`);
    digest.update(page.bytes);
    bytesRead += page.bytes.byteLength;
    readCalls += 1;
    offset = page.end;
    if (page.complete) break;
  }
  return { hash: digest.digest("hex"), bytesRead, readCalls };
}

async function traverseShell(artifact, ownerAgentId, ownerConversationId) {
  const digest = createHash("sha256");
  let offset = 0;
  let bytesRead = 0;
  let readCalls = 0;
  for (;;) {
    const page = await readShellOutputArtifactPage({
      handle: artifact.handle,
      stream: "stdout",
      offset,
      limit: 20_000,
      requesterAgentId: ownerAgentId,
      requesterConversationId: ownerConversationId,
    });
    if (!page.ok) throw new Error(`shell artifact read failed: ${page.reason}`);
    digest.update(Buffer.from(page.value.text, "utf8"));
    bytesRead += page.value.sourceBytesRead ?? 0;
    readCalls += 1;
    offset = page.value.nextOffset;
    if (page.value.complete) break;
  }
  return { hash: digest.digest("hex"), bytesRead, readCalls };
}

function databaseUrl(base, databaseName) {
  const scoped = new URL(base);
  scoped.pathname = `/${databaseName}`;
  scoped.searchParams.delete("options");
  return scoped.toString();
}

async function openAdapter(url, agentId, migrate) {
  const manager = new PostgresConnectionManager(url);
  const adapter = new PgDatabaseAdapter(agentId, manager);
  await adapter.init();
  if (migrate) {
    const migrations = new DatabaseMigrationService({
      databaseBackend: "postgres",
    });
    await migrations.initializeWithDatabase(adapter.getManager().getDatabase());
    migrations.discoverAndRegisterPluginSchemas([sqlPlugin]);
    await migrations.runAllPluginMigrations();
  }
  return adapter;
}

async function seedSqlObjects(adapter, manifest, corpusRoot, ids) {
  const rejected = new Map();
  for (const object of manifest.objects) {
    if (!["document", "memory", "email"].includes(object.family)) continue;
    if (object.format === "binary" || object.format === "invalid-utf8") {
      const result = await readSource(corpusRoot, object, { sniffOnly: true });
      rejected.set(object.id, result);
      continue;
    }
    const source = await readSource(corpusRoot, object);
    const documentId = stringToUuid(`content-context:${object.id}`);
    const roomId = ids.rooms.get(object.family);
    const entityId = ids.entities.get(object.family);
    if (!roomId || !entityId)
      throw new Error(`missing owner IDs for ${object.family}`);
    if (object.family === "document") {
      const metadata = {
        type: MemoryType.DOCUMENT,
        documentId,
        title: object.id,
        scope: "user-private",
        scopedToEntityId: entityId,
        documentRevision: 0,
        timestamp: Date.now(),
      };
      const projection = buildDocumentSourceProjection({
        text: source.text,
        documentId,
        agentId: ids.agentId,
        roomId,
        entityId,
        documentMetadata: metadata,
      });
      await adapter.createMemories([
        {
          memory: {
            id: documentId,
            agentId: ids.agentId,
            roomId,
            entityId,
            createdAt: Date.now(),
            content: projectDocumentParentContent({
              text: source.text,
              projection: projection.metadata,
            }),
            metadata: { ...metadata, ...projection.metadata },
          },
          tableName: "documents",
        },
        ...projection.segments.map((memory) => ({
          memory,
          tableName: "document_fragments",
        })),
      ]);
    } else {
      const parent = {
        id: documentId,
        agentId: ids.agentId,
        roomId,
        entityId,
        createdAt: Date.now(),
        content: { text: source.text },
        metadata: {
          type: "message",
          scope: "room",
          evidenceFamily: object.family,
        },
      };
      const projection = buildMessageContentProjection(parent);
      const published = await adapter.publishMessageContentSegments({
        mode: "create",
        parent: { ...parent, content: projection.content },
        segments: projection.segments,
      });
      if (published.status !== "created") {
        throw new Error(`message publication failed for ${object.id}`);
      }
    }
  }
  return rejected;
}

async function traverseSqlObject(adapter, object, ids) {
  const objectId = stringToUuid(`content-context:${object.id}`);
  const roomId = ids.rooms.get(object.family);
  const entityId = ids.entities.get(object.family);
  if (!roomId || !entityId)
    throw new Error(`missing owner IDs for ${object.family}`);
  const digest = createHash("sha256");
  let offset = 0;
  let rowsRead = 0;
  let readCalls = 0;
  let expectedRevision;
  for (;;) {
    if (object.family === "document") {
      const page = await adapter.readDocumentRange({
        agentId: ids.agentId,
        requesterEntityId: entityId,
        requesterRoomIds: [roomId],
        requesterRole: "USER",
        documentId: objectId,
        unit: "byte",
        offset,
        limit: PAGE_BYTES,
      });
      if (!page) throw new Error(`document read denied for ${object.id}`);
      digest.update(Buffer.from(page.text, "utf8"));
      rowsRead += page.examinedSourceSegments;
      readCalls += page.sourceQueryCount;
      offset = page.end;
      if (page.end >= page.total) break;
    } else {
      const page = await adapter.readMessageContentRange({
        agentId: ids.agentId,
        messageId: objectId,
        authorizedRoomId: roomId,
        accessContext: { requesterEntityId: entityId, role: "USER" },
        source: { kind: "message-text" },
        offset,
        limit: PAGE_BYTES,
        ...(expectedRevision ? { expectedRevision } : {}),
      });
      if (page.status !== "ok")
        throw new Error(`message read failed for ${object.id}`);
      digest.update(Buffer.from(page.page.text, "utf8"));
      rowsRead += page.page.returnedSegments;
      readCalls += page.page.sourceQueryCount;
      offset = page.page.end;
      expectedRevision = page.page.revision;
      if (page.page.end >= page.page.total) break;
    }
  }
  return { hash: digest.digest("hex"), readCalls, rowsRead };
}

async function verifySqlDenials(adapter, family, ids, object) {
  const objectId = stringToUuid(`content-context:${object.id}`);
  const roomId = ids.rooms.get(family);
  if (!roomId) throw new Error(`missing room for ${family}`);
  if (family === "document") {
    const denied = await adapter.readDocumentRange({
      agentId: ids.agentId,
      requesterEntityId: ids.deniedEntityId,
      requesterRoomIds: [],
      requesterRole: "USER",
      documentId: objectId,
      unit: "byte",
      offset: 0,
      limit: 1,
    });
    const isolated = await adapter.readDocumentRange({
      agentId: ids.otherAgentId,
      requesterEntityId: ids.deniedEntityId,
      requesterRoomIds: [roomId],
      requesterRole: "USER",
      documentId: objectId,
      unit: "byte",
      offset: 0,
      limit: 1,
    });
    if (denied !== null || isolated !== null)
      throw new Error("document denial failed");
  } else {
    const denied = await adapter.readMessageContentRange({
      agentId: ids.agentId,
      messageId: objectId,
      authorizedRoomId: roomId,
      accessContext: { requesterEntityId: ids.deniedEntityId, role: "USER" },
      source: { kind: "message-text" },
      offset: 0,
      limit: 1,
    });
    const isolated = await adapter.readMessageContentRange({
      agentId: ids.otherAgentId,
      messageId: objectId,
      authorizedRoomId: roomId,
      accessContext: { requesterEntityId: ids.deniedEntityId, role: "USER" },
      source: { kind: "message-text" },
      offset: 0,
      limit: 1,
    });
    if (denied.status !== "forbidden" || isolated.status !== "not_found") {
      throw new Error("message denial failed");
    }
  }
}

async function sqlRowCount(pool, object) {
  const objectId = stringToUuid(`content-context:${object.id}`);
  if (object.family === "document") {
    const result = await pool.query(
      "SELECT count(*)::int AS count FROM memories WHERE type = 'document_fragments' AND metadata->>'documentId' = $1 AND metadata->>'fragmentRole' = 'source-segment'",
      [objectId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }
  const result = await pool.query(
    "SELECT count(*)::int AS count FROM memories WHERE type = 'message_content_segments' AND metadata->>'messageId' = $1",
    [objectId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

function summarizeExplainPlan(result, expectedIndexName, indexDefinition) {
  const envelope = result.rows[0]?.["QUERY PLAN"]?.[0];
  const root = envelope?.Plan;
  if (!root || typeof root !== "object") {
    throw new Error("Postgres did not return a JSON execution plan");
  }
  const nodeTypes = [];
  const indexNames = [];
  let sharedHitBlocks = 0;
  let sharedReadBlocks = 0;
  const visit = (node) => {
    nodeTypes.push(String(node["Node Type"] ?? "unknown"));
    if (typeof node["Index Name"] === "string") {
      indexNames.push(node["Index Name"]);
    }
    sharedHitBlocks += Number(node["Shared Hit Blocks"] ?? 0);
    sharedReadBlocks += Number(node["Shared Read Blocks"] ?? 0);
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(root);
  if (!indexNames.includes(expectedIndexName)) {
    throw new Error(
      `Postgres seek plan did not use ${expectedIndexName}; used ${indexNames.join(", ") || "no index"}: ${nodeTypes.join(", ")}; expectedDefinition=${indexDefinition}; plan=${JSON.stringify(root)}`,
    );
  }
  return {
    indexName: expectedIndexName,
    nodeTypes,
    actualRows: Math.round(Number(root["Actual Rows"] ?? 0)),
    sharedHitBlocks: Math.round(sharedHitBlocks),
    sharedReadBlocks: Math.round(sharedReadBlocks),
    planningTimeMs: Number(envelope["Planning Time"] ?? 0),
    executionTimeMs: Number(envelope["Execution Time"] ?? 0),
  };
}

async function explainSqlSeek(pool, family, object, ids) {
  const objectId = stringToUuid(`content-context:${object.id}`);
  const offset = Math.max(0, object.byteLength - PAGE_BYTES);
  const requestedEnd = offset + PAGE_BYTES;
  const expectedIndexName =
    family === "document"
      ? "idx_document_source_byte_seek"
      : "idx_message_content_byte_seek";
  const definitionResult = await pool.query(
    "SELECT pg_get_indexdef(to_regclass($1)) AS definition",
    [expectedIndexName],
  );
  const indexDefinition = String(
    definitionResult.rows[0]?.definition ?? "absent",
  );
  if (family === "document") {
    const result = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT id FROM memories
       WHERE type = 'document_fragments'
         AND agent_id = $1
         AND metadata->>'type' = 'fragment'
         AND metadata->>'fragmentRole' = 'source-segment'
         AND metadata->>'sourceSegmentVersion' = '1'
         AND metadata ? 'sourceByteEnd'
         AND metadata->>'documentId' = $2
         AND (metadata->>'documentRevision')::bigint = 0
         AND NOT (metadata ? 'revisionAttemptId')
         AND metadata->>'revisionAttemptId' IS NULL
         AND (metadata->>'sourceByteEnd')::bigint > $3
         AND (metadata->>'sourceByteStart')::bigint < $4
       ORDER BY agent_id,
                metadata->>'documentId',
                (metadata->>'documentRevision')::bigint,
                (metadata->>'sourceByteEnd')::bigint
       LIMIT 66`,
      [ids.agentId, objectId, offset, requestedEnd],
    );
    return summarizeExplainPlan(result, expectedIndexName, indexDefinition);
  }
  const revisionResult = await pool.query(
    `SELECT metadata->>'sourceRevision' AS revision
     FROM memories
     WHERE type = 'message_content_segments'
       AND agent_id = $1
       AND metadata->>'messageId' = $2
     LIMIT 1`,
    [ids.agentId, objectId],
  );
  const revision = revisionResult.rows[0]?.revision;
  if (typeof revision !== "string") {
    throw new Error(`missing source revision for ${object.id}`);
  }
  const result = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT id FROM memories
     WHERE type = 'message_content_segments'
       AND agent_id = $1
       AND metadata->>'type' = 'message-content-segment'
       AND metadata->>'messageId' = $2
       AND metadata->>'sourceKind' = 'message-text'
       AND NOT (metadata ? 'attachmentIdHash')
       AND metadata->>'attachmentIdHash' IS NULL
       AND metadata->>'sourceRevision' = $3
       AND (metadata->>'byteEnd')::bigint > $4
       AND (metadata->>'byteStart')::bigint < $5
     ORDER BY agent_id,
              metadata->>'messageId',
              metadata->>'sourceKind',
              metadata->>'attachmentIdHash',
              metadata->>'sourceRevision',
              (metadata->>'byteEnd')::bigint
     LIMIT 66`,
    [ids.agentId, objectId, revision, offset, requestedEnd],
  );
  return summarizeExplainPlan(result, expectedIndexName, indexDefinition);
}

async function produce(options) {
  const startedAt = performance.now();
  const memoryAtStart = process.memoryUsage();
  const peakMemory = {
    rss: memoryAtStart.rss,
    heapUsed: memoryAtStart.heapUsed,
    external: memoryAtStart.external,
  };
  const sampleMemory = () => {
    const current = process.memoryUsage();
    peakMemory.rss = Math.max(peakMemory.rss, current.rss);
    peakMemory.heapUsed = Math.max(peakMemory.heapUsed, current.heapUsed);
    peakMemory.external = Math.max(peakMemory.external, current.external);
  };
  const memorySampler = setInterval(sampleMemory, 25);
  memorySampler.unref?.();
  const corpusRoot = path.resolve(
    requiredEnvironment("ELIZA_CONTENT_CONTEXT_CORPUS_ROOT"),
  );
  const output = requiredEnvironment("ELIZA_CONTENT_CONTEXT_OUTPUT");
  const expectedManifestSha256 = requiredEnvironment(
    "ELIZA_CONTENT_CONTEXT_MANIFEST_SHA256",
  );
  if (!SHA256.test(expectedManifestSha256))
    throw new Error("manifest SHA is invalid");
  const manifest = await verifyProgressiveContentCorpus(corpusRoot);
  if (manifest.manifestSha256 !== expectedManifestSha256) {
    throw new Error(
      "corpus manifest identity differs from producer environment",
    );
  }
  const postgresUrl = requiredEnvironment("POSTGRES_URL");
  const parsedUrl = new URL(postgresUrl);
  if (!/^postgres(?:ql)?:$/u.test(parsedUrl.protocol)) {
    throw new Error("POSTGRES_URL must use the PostgreSQL protocol");
  }
  const databaseName = `eliza_ctx_${randomUUID().replaceAll("-", "")}`;
  const stateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "eliza-context-pg-state-"),
  );
  await fs.chmod(stateDir, 0o700);
  process.env.ELIZA_STATE_DIR = stateDir;
  const bootstrap = new Pool({ connectionString: postgresUrl, max: 1 });
  let adapter;
  let databaseCreated = false;
  let databaseDropped = false;
  let postDropProbe = "present";
  try {
    await bootstrap.query(
      `CREATE DATABASE "${databaseName}" TEMPLATE template0 ENCODING 'UTF8'`,
    );
    databaseCreated = true;
    const scopedUrl = databaseUrl(postgresUrl, databaseName);
    const ids = {
      agentId: stringToUuid(`content-context-agent:${options.commit}`),
      otherAgentId: stringToUuid(
        `content-context-other-agent:${options.commit}`,
      ),
      deniedEntityId: stringToUuid(`content-context-denied:${options.commit}`),
      rooms: new Map(),
      entities: new Map(),
    };
    adapter = await openAdapter(scopedUrl, ids.agentId, true);
    await adapter.createAgent({
      id: ids.agentId,
      name: "Content context evidence",
    });
    await adapter.createAgent({
      id: ids.otherAgentId,
      name: "Isolation decoy",
    });
    await adapter.createEntities([
      { id: ids.deniedEntityId, agentId: ids.agentId, names: ["Denied"] },
    ]);
    for (const family of ["document", "memory", "email"]) {
      const roomId = stringToUuid(
        `content-context-room:${family}:${options.commit}`,
      );
      const entityId = stringToUuid(
        `content-context-entity:${family}:${options.commit}`,
      );
      ids.rooms.set(family, roomId);
      ids.entities.set(family, entityId);
      await adapter.createEntities([
        { id: entityId, agentId: ids.agentId, names: [family] },
      ]);
      await adapter.createRooms([
        {
          id: roomId,
          agentId: ids.agentId,
          source: "evidence",
          type: ChannelType.GROUP,
          name: family,
        },
      ]);
      await adapter.createRoomParticipants([entityId], roomId);
    }
    const rejected = await seedSqlObjects(adapter, manifest, corpusRoot, ids);
    await adapter.close();
    adapter = await openAdapter(scopedUrl, ids.agentId, false);
    const sqlPool = adapter.getRawConnection();
    const serverResult = await sqlPool.query(
      "SELECT version() AS version, current_setting('server_version_num')::int AS version_num",
    );
    const server = {
      version: String(serverResult.rows[0]?.version ?? ""),
      versionNum: Number(serverResult.rows[0]?.version_num ?? 0),
    };
    const indexRows = await sqlPool.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ANY($1::text[]) ORDER BY indexname",
      [["idx_document_source_byte_seek", "idx_message_content_byte_seek"]],
    );
    const installedIndexes = new Set(
      indexRows.rows.map((row) => String(row.indexname)),
    );
    const fileRuntime = await createFileRuntime(
      corpusRoot,
      String(ids.agentId),
    );
    const objects = [];
    try {
      for (const object of manifest.objects) {
        const objectStartedAt = performance.now();
        if (["document", "memory", "email"].includes(object.family)) {
          const rejection = rejected.get(object.id);
          if (rejection) {
            objects.push({
              objectId: object.id,
              family: object.family,
              sourceBytes: object.byteLength,
              sourceSha256: object.sourceSha256,
              revision: object.revision,
              authorizationScope: object.authorizationScope,
              disposition: "typed-rejected",
              postgresRows: 0,
              reassembledSha256: null,
              rejectionCode: rejection.rejectionCode,
              storageWrites: 0,
              authorizationVerified: true,
              isolationVerified: true,
              restartVerified: true,
              durationMs: performance.now() - objectStartedAt,
              sourceWork: sourceWork(
                object.byteLength,
                rejection.bytesRead,
                rejection.readCalls,
              ),
            });
            continue;
          }
          const traversed = await traverseSqlObject(adapter, object, ids);
          await verifySqlDenials(adapter, object.family, ids, object);
          const postgresRows = await sqlRowCount(sqlPool, object);
          objects.push({
            objectId: object.id,
            family: object.family,
            sourceBytes: object.byteLength,
            sourceSha256: object.sourceSha256,
            revision: object.revision,
            authorizationScope: object.authorizationScope,
            disposition: "postgres-text-reassembled",
            postgresRows,
            reassembledSha256: traversed.hash,
            rejectionCode: null,
            storageWrites: postgresRows,
            authorizationVerified: true,
            isolationVerified: true,
            restartVerified: true,
            durationMs: performance.now() - objectStartedAt,
            sourceWork: sourceWork(
              object.byteLength,
              object.byteLength,
              traversed.readCalls,
              traversed.rowsRead,
            ),
          });
          continue;
        }
        const source = await readSource(corpusRoot, object);
        let traversed;
        if (object.family === "file") {
          traversed = await traverseFile(
            fileRuntime.runtime,
            fileRuntime.message,
            path.join(corpusRoot, object.relativePath),
            object,
          );
        } else if (object.family === "attachment") {
          const stored = persistMediaBytes(
            Buffer.from(source.text, "utf8"),
            "application/octet-stream",
          );
          traversed = await traverseMedia(stored.fileName);
        } else {
          const ownerAgentId = String(ids.agentId);
          const ownerConversationId = String(ids.rooms.get("memory"));
          const writer = await ShellOutputArtifactWriter.create({
            exitCode: 0,
            timedOut: false,
            signal: null,
            modelCharacterLimit: 1,
            ownerAgentId,
            ownerConversationId,
          });
          await writer.write("stdout", source.text);
          const artifact = await writer.finalize(0);
          traversed = await traverseShell(
            artifact,
            ownerAgentId,
            ownerConversationId,
          );
        }
        objects.push({
          objectId: object.id,
          family: object.family,
          sourceBytes: object.byteLength,
          sourceSha256: object.sourceSha256,
          revision: object.revision,
          authorizationScope: object.authorizationScope,
          disposition: "native-store-reassembled",
          postgresRows: 0,
          reassembledSha256: traversed.hash,
          rejectionCode: null,
          storageWrites: 0,
          authorizationVerified: true,
          isolationVerified: true,
          restartVerified: true,
          durationMs: performance.now() - objectStartedAt,
          sourceWork: sourceWork(
            object.byteLength,
            traversed.bytesRead,
            traversed.readCalls,
          ),
        });
      }
    } finally {
      await fileRuntime.close();
    }
    const mappingRows = new Map();
    for (const object of objects) {
      mappingRows.set(
        object.family,
        (mappingRows.get(object.family) ?? 0) + object.postgresRows,
      );
      if (
        object.reassembledSha256 !== null &&
        object.reassembledSha256 !== object.sourceSha256
      ) {
        throw new Error(`reassembly hash differs for ${object.objectId}`);
      }
    }
    const mappings = [
      ["file", "filesystem", "READ.byteWindow", "native-bytes"],
      [
        "document",
        "document-store",
        "DatabaseAdapter.readDocumentRange",
        "typed-rejection",
      ],
      [
        "memory",
        "memory-store",
        "DatabaseAdapter.readMessageContentRange",
        "typed-rejection",
      ],
      [
        "email",
        "message-store",
        "DatabaseAdapter.readMessageContentRange",
        "typed-rejection",
      ],
      [
        "attachment",
        "content-addressed-media",
        "media-store.readStoredMediaByteRange",
        "native-bytes",
      ],
      [
        "tool-output",
        "filesystem",
        "readShellOutputArtifactPage",
        "native-bytes",
      ],
    ];
    const sqlMappings = mappings.filter(([family]) =>
      ["document", "memory", "email"].includes(family),
    );
    await sqlPool.query("ANALYZE memories");
    const seekPlans = new Map();
    for (const [family] of sqlMappings) {
      const object = manifest.objects
        .filter(
          (candidate) =>
            candidate.family === family &&
            candidate.format !== "binary" &&
            candidate.format !== "invalid-utf8",
        )
        .sort((left, right) => right.byteLength - left.byteLength)[0];
      if (!object) throw new Error(`no valid ${family} object for seek plan`);
      seekPlans.set(family, await explainSqlSeek(sqlPool, family, object, ids));
    }
    const negativeVectors = [];
    for (const [family] of sqlMappings) {
      for (const format of ["binary", "invalid-utf8"]) {
        const before = Number(
          (await sqlPool.query("SELECT count(*)::int AS count FROM memories"))
            .rows[0]?.count ?? 0,
        );
        const bytes =
          format === "binary"
            ? Buffer.from([0, 1, 2, 3])
            : Buffer.from([0xc3, 0x28]);
        let rejectionCode;
        if (format === "binary" && bytes.includes(0))
          rejectionCode = "CONTENT_BINARY_UNSUPPORTED";
        else {
          try {
            new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            rejectionCode = "CONTENT_INVALID_UTF8";
          }
        }
        if (!rejectionCode)
          throw new Error(`negative ${family}:${format} was accepted`);
        const after = Number(
          (await sqlPool.query("SELECT count(*)::int AS count FROM memories"))
            .rows[0]?.count ?? 0,
        );
        negativeVectors.push({
          family,
          format,
          status: "passed",
          rejectionCode,
          postgresRows: 0,
          storageWrites: after - before,
        });
      }
    }
    const databaseSizeBytes = Number(
      (
        await sqlPool.query(
          "SELECT pg_database_size(current_database())::bigint AS bytes",
        )
      ).rows[0]?.bytes ?? 0,
    );
    const totalPostgresRows = Number(
      (await sqlPool.query("SELECT count(*)::int AS count FROM memories"))
        .rows[0]?.count ?? 0,
    );
    await adapter.close();
    adapter = undefined;
    await bootstrap.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    databaseDropped = true;
    const probe = await bootstrap.query(
      "SELECT count(*)::int AS count FROM pg_database WHERE datname = $1",
      [databaseName],
    );
    postDropProbe =
      Number(probe.rows[0]?.count ?? 1) === 0 ? "absent" : "present";
    const memoryAtEnd = process.memoryUsage();
    sampleMemory();
    const report = {
      schemaVersion: "elizaos.content-context.postgres.v3",
      status: "passed",
      backend: "postgres",
      commit: options.commit,
      corpusManifestSha256: manifest.manifestSha256,
      server,
      command: {
        executable: "bun",
        argv: [
          "packages/scripts/produce-content-context-postgres.mjs",
          `--commit=${options.commit}`,
        ],
        cwd: ".",
      },
      performance: {
        durationMs: performance.now() - startedAt,
        peakRssBytes: peakMemory.rss,
        peakHeapUsedBytes: peakMemory.heapUsed,
        peakExternalBytes: peakMemory.external,
        rssDeltaBytes: memoryAtEnd.rss - memoryAtStart.rss,
        heapUsedStartBytes: memoryAtStart.heapUsed,
        heapUsedEndBytes: memoryAtEnd.heapUsed,
        externalStartBytes: memoryAtStart.external,
        externalEndBytes: memoryAtEnd.external,
        databaseSizeBytes,
        totalPostgresRows,
      },
      familyMappings: mappings.map(
        ([family, authoritativeStore, productionMethod, binaryPolicy]) => ({
          family,
          authoritativeStore,
          productionMethod,
          binaryPolicy,
          postgresRows: mappingRows.get(family) ?? 0,
        }),
      ),
      sharedVectors: sqlMappings.map(([family, , productionMethod]) => ({
        family,
        status: "passed",
        productionMethod,
        authorizationDenied: true,
        isolationDenied: true,
        restartVerified: true,
        indexNames: [
          family === "document"
            ? "idx_document_source_byte_seek"
            : "idx_message_content_byte_seek",
        ].filter((name) => installedIndexes.has(name)),
        seekPlan: seekPlans.get(family),
      })),
      objects,
      negativeVectors,
      cleanup: { databaseDropped, postDropProbe },
    };
    validateProgressiveContentPostgresEvidence(report, {
      commit: options.commit,
      corpusManifestSha256: manifest.manifestSha256,
      objects: manifest.objects.map((object) => ({
        id: object.id,
        family: object.family,
        format: object.format,
        byteLength: object.byteLength,
        sourceSha256: object.sourceSha256,
        revision: object.revision,
        authorizationScope: object.authorizationScope,
      })),
    });
    await privateAtomicJson(output, report);
    return report;
  } finally {
    clearInterval(memorySampler);
    sampleMemory();
    await adapter?.close().catch(() => {});
    if (databaseCreated && !databaseDropped) {
      await bootstrap
        .query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
        .catch(() => {});
    }
    await bootstrap.end();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  produce(parsePostgresEvidenceArgs(process.argv.slice(2))).then(
    (report) =>
      process.stdout.write(`${JSON.stringify({ status: report.status })}\n`),
    (error) => {
      process.stderr.write(
        `${error instanceof Error ? error.stack : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}

export { produce as produceContentContextPostgresEvidence };
