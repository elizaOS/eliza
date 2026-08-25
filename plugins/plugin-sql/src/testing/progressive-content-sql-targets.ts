/**
 * Realizes document, stored-memory, and email corpus objects in private
 * disk-backed PGlite databases. Ingestion reads at most one 64 KiB source page,
 * publishes immutable UTF-8 segments before their parent, and serves every
 * continuation through the adapter's authorized indexed range methods.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildReadView, type Content, type Memory, MemoryType, type UUID } from "@elizaos/core";
import {
  PROGRESSIVE_CONTENT_TARGET_FACTORY_SCHEMA_VERSION,
  type ProgressiveContentBoundedSource,
  type ProgressiveContentTarget,
  type ProgressiveContentTargetFactory,
  type ProgressiveContentTargetFamily,
  type ProgressiveContentTargetObject,
} from "@elizaos/core/testing";
import { and, count, eq, inArray, sql, sum } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import { DatabaseMigrationService } from "../migration-service";
import { PgliteDatabaseAdapter } from "../pglite/adapter";
import { PGliteClientManager } from "../pglite/manager";
import * as schema from "../schema";
import { memoryTable } from "../schema";
import type { DrizzleDatabase } from "../types";

const SOURCE_PAGE_BYTES = 64 * 1024;
const SOURCE_READ_BYTES = SOURCE_PAGE_BYTES - 4;
const TARGET_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
const SQL_FAMILIES = ["document", "memory", "email"] as const;
type ProgressiveSqlFamily = (typeof SQL_FAMILIES)[number];

class ProgressiveSqlTargetError extends Error {
  constructor(
    readonly code: string,
    message = code
  ) {
    super(message);
    this.name = "ProgressiveSqlTargetError";
  }
}

interface TargetIds {
  readonly agentId: UUID;
  readonly requesterId: UUID;
  readonly unauthorizedId: UUID;
  readonly roomId: UUID;
  readonly isolatedRoomId: UUID;
  readonly objectId: UUID;
}

interface StagedSegment {
  readonly id: UUID;
  readonly text: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly ordinal: number;
  readonly sha256: string;
}

function targetUuid(objectId: string, label: string): UUID {
  return uuidv5(`${objectId}:${label}`, TARGET_NAMESPACE) as UUID;
}

function idsFor(objectId: string): TargetIds {
  return {
    agentId: targetUuid(objectId, "agent"),
    requesterId: targetUuid(objectId, "requester"),
    unauthorizedId: targetUuid(objectId, "unauthorized"),
    roomId: targetUuid(objectId, "room"),
    isolatedRoomId: targetUuid(objectId, "isolated-room"),
    objectId: targetUuid(objectId, "object"),
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function stageUtf8Source(input: {
  readonly object: ProgressiveContentTargetObject;
  readonly source: ProgressiveContentBoundedSource;
  readonly publish: (segment: StagedSegment) => Promise<void>;
}): Promise<{ readonly digest: string; readonly segments: number; readonly inline?: string }> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const digest = createHash("sha256");
  const inlineChunks: Uint8Array[] = [];
  let sourceOffset = 0;
  let publishedOffset = 0;
  let ordinal = 0;

  const publishText = async (text: string): Promise<void> => {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength === 0) return;
    if (bytes.byteLength > SOURCE_PAGE_BYTES) {
      throw new ProgressiveSqlTargetError("PROGRESSIVE_REALIZATION_READ_UNBOUNDED");
    }
    const segment: StagedSegment = {
      id: targetUuid(input.object.id, `segment:${ordinal}`),
      text,
      byteStart: publishedOffset,
      byteEnd: publishedOffset + bytes.byteLength,
      ordinal,
      sha256: sha256(bytes),
    };
    await input.publish(segment);
    if (input.object.byteLength <= SOURCE_PAGE_BYTES) inlineChunks.push(bytes);
    publishedOffset = segment.byteEnd;
    ordinal += 1;
  };

  while (sourceOffset < input.source.byteLength) {
    const page = await input.source.read(sourceOffset, SOURCE_READ_BYTES);
    if (
      !(page instanceof Uint8Array) ||
      page.byteLength === 0 ||
      page.byteLength > SOURCE_READ_BYTES ||
      page.byteLength > input.source.byteLength - sourceOffset
    ) {
      throw new ProgressiveSqlTargetError("PROGRESSIVE_REALIZATION_NO_PROGRESS");
    }
    digest.update(page);
    sourceOffset += page.byteLength;
    try {
      await publishText(decoder.decode(page, { stream: sourceOffset < input.source.byteLength }));
    } catch (cause) {
      if (cause instanceof ProgressiveSqlTargetError) throw cause;
      throw new ProgressiveSqlTargetError(
        "CONTENT_INVALID_UTF8",
        cause instanceof Error ? cause.message : "Source is not valid UTF-8"
      );
    }
  }
  const actualDigest = digest.digest("hex");
  if (actualDigest !== input.object.sourceSha256 || publishedOffset !== input.object.byteLength) {
    throw new ProgressiveSqlTargetError("PROGRESSIVE_REALIZATION_HASH_MISMATCH");
  }
  return {
    digest: actualDigest,
    segments: ordinal,
    ...(input.object.byteLength <= SOURCE_PAGE_BYTES
      ? { inline: Buffer.concat(inlineChunks).toString("utf8") }
      : {}),
  };
}

async function openAdapter(dataDir: string, agentId: UUID, migrate: boolean) {
  const manager = new PGliteClientManager({ dataDir });
  await manager.initialize();
  const adapter = new PgliteDatabaseAdapter(agentId, manager);
  await adapter.init();
  if (migrate) {
    const migrations = new DatabaseMigrationService();
    await migrations.initializeWithDatabase(adapter.getDatabase() as DrizzleDatabase);
    migrations.discoverAndRegisterPluginSchemas([
      { name: "@elizaos/plugin-sql", description: "SQL plugin", schema },
    ]);
    await migrations.runAllPluginMigrations();
  }
  return adapter;
}

async function seedAuthorization(adapter: PgliteDatabaseAdapter, ids: TargetIds): Promise<void> {
  const createdAt = Date.now();
  await adapter.createAgent({
    id: ids.agentId,
    name: "Progressive content target",
    createdAt,
    updatedAt: createdAt,
  });
  await adapter.createEntities([
    { id: ids.requesterId, agentId: ids.agentId, names: ["Target reader"] },
    { id: ids.unauthorizedId, agentId: ids.agentId, names: ["Denied reader"] },
  ]);
  await adapter.createRooms([
    {
      id: ids.roomId,
      agentId: ids.agentId,
      source: "progressive-content",
      type: "GROUP",
      name: "Authorized target room",
    },
    {
      id: ids.isolatedRoomId,
      agentId: ids.agentId,
      source: "progressive-content",
      type: "GROUP",
      name: "Isolated target room",
    },
  ]);
  await adapter.createRoomParticipants([ids.requesterId], ids.roomId);
}

function segmentMemory(input: {
  readonly family: ProgressiveSqlFamily;
  readonly ids: TargetIds;
  readonly segment: StagedSegment;
  readonly revision: string;
  readonly createdAt: number;
}): { readonly memory: Memory; readonly tableName: string } {
  if (input.family === "document") {
    return {
      tableName: "document_fragments",
      memory: {
        id: input.segment.id,
        agentId: input.ids.agentId,
        entityId: input.ids.requesterId,
        roomId: input.ids.roomId,
        createdAt: input.createdAt,
        content: { text: input.segment.text },
        metadata: {
          type: MemoryType.FRAGMENT,
          documentId: input.ids.objectId,
          documentRevision: 1,
          fragmentRole: "source-segment",
          position: input.segment.ordinal,
          sourceSegmentVersion: 1,
          sourceSegmentSha256: input.segment.sha256,
          sourceByteStart: input.segment.byteStart,
          sourceByteEnd: input.segment.byteEnd,
          sourceLineStart: 0,
          sourceLineEnd: 0,
          sourceLineStartBoundary: false,
          sourceLineEndBoundary: false,
          sourceFragmentStart: 0,
          sourceFragmentEnd: 0,
          sourceFragmentStartBoundary: false,
          sourceFragmentEndBoundary: false,
          timestamp: input.createdAt,
        } as unknown as Memory["metadata"],
      },
    };
  }
  return {
    tableName: "message_content_segments",
    memory: {
      id: input.segment.id,
      agentId: input.ids.agentId,
      entityId: input.ids.requesterId,
      roomId: input.ids.roomId,
      createdAt: input.createdAt,
      content: { text: input.segment.text },
      metadata: {
        type: "message-content-segment",
        messageId: input.ids.objectId,
        sourceKind: "message-text",
        sourceRevision: input.revision,
        segmentVersion: 1,
        ordinal: input.segment.ordinal,
        byteStart: input.segment.byteStart,
        byteEnd: input.segment.byteEnd,
        segmentSha256: input.segment.sha256,
        timestamp: input.createdAt,
      } as unknown as Memory["metadata"],
    },
  };
}

function parentMemory(input: {
  readonly family: ProgressiveSqlFamily;
  readonly object: ProgressiveContentTargetObject;
  readonly ids: TargetIds;
  readonly revision: string;
  readonly segmentCount: number;
  readonly inline?: string;
  readonly createdAt: number;
}): { readonly memory: Memory; readonly tableName: string } {
  if (input.family === "document") {
    return {
      tableName: "documents",
      memory: {
        id: input.ids.objectId,
        agentId: input.ids.agentId,
        entityId: input.ids.requesterId,
        roomId: input.ids.roomId,
        createdAt: input.createdAt,
        content:
          input.inline === undefined
            ? {
                documentSource: {
                  kind: "document-source",
                  storage: "segments",
                  byteLength: input.object.byteLength,
                  fingerprint: `sha256:${input.object.sourceSha256}`,
                },
              }
            : { text: input.inline },
        metadata: {
          type: MemoryType.DOCUMENT,
          documentId: input.ids.objectId,
          title: `Progressive content ${input.object.id}`,
          scope: "user-private",
          scopedToEntityId: input.ids.requesterId,
          documentRevision: 1,
          timestamp: input.createdAt,
          sourceSegmentVersion: 1,
          sourceSegmentCount: input.segmentCount,
          sourceByteLength: input.object.byteLength,
          sourceLineCount: 0,
          sourceFragmentCount: 0,
          sourceSha256: input.object.sourceSha256,
          sourceFingerprint: `sha256:${input.object.sourceSha256}`,
          sourceStorage: input.inline === undefined ? "segments" : "inline",
        } as unknown as Memory["metadata"],
      },
    };
  }
  const content: Content =
    input.inline === undefined
      ? {
          messageTextSource: {
            kind: "message-text",
            storage: "segments",
            version: 1,
            revision: input.revision,
            sha256: input.object.sourceSha256,
            byteLength: input.object.byteLength,
            segmentCount: input.segmentCount,
          },
        }
      : { text: input.inline };
  return {
    tableName: "messages",
    memory: {
      id: input.ids.objectId,
      agentId: input.ids.agentId,
      entityId: input.ids.requesterId,
      roomId: input.ids.roomId,
      createdAt: input.createdAt,
      content,
      metadata: {
        type: "message",
        scope: "room",
        source: input.family === "email" ? "email" : "memory",
      },
    },
  };
}

async function insertTargetMemory(
  tx: DrizzleDatabase,
  entry: { readonly memory: Memory; readonly tableName: string }
): Promise<void> {
  if (!entry.memory.id) throw new TypeError("progressive SQL target row requires an id");
  if (!entry.memory.agentId) {
    throw new TypeError("progressive SQL target row requires an agent id");
  }
  await tx.insert(memoryTable).values({
    id: entry.memory.id,
    type: entry.tableName,
    createdAt: new Date(entry.memory.createdAt ?? Date.now()),
    content: entry.memory.content,
    entityId: entry.memory.entityId,
    agentId: entry.memory.agentId,
    roomId: entry.memory.roomId,
    worldId: entry.memory.worldId,
    unique: true,
    metadata: entry.memory.metadata ?? {},
  });
}

function sliceInline(input: {
  readonly text: string;
  readonly offset: number;
  readonly limit: number;
}): { readonly bytes: Uint8Array; readonly end: number } {
  const bytes = Buffer.from(input.text, "utf8");
  if (
    input.offset > bytes.byteLength ||
    (input.offset < bytes.byteLength && (bytes[input.offset] & 0xc0) === 0x80)
  ) {
    throw new ProgressiveSqlTargetError("CONTENT_INVALID_RANGE");
  }
  let end = Math.min(input.offset + input.limit, bytes.byteLength);
  while (end > input.offset && end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) end -= 1;
  if (end === input.offset && input.offset < bytes.byteLength) {
    throw new ProgressiveSqlTargetError("CONTENT_INVALID_RANGE");
  }
  return { bytes: bytes.subarray(input.offset, end), end };
}

function referenceFor(
  family: ProgressiveSqlFamily,
  object: ProgressiveContentTargetObject,
  revision: string
) {
  return {
    kind: family,
    ref: `${family}:${sha256(object.id).slice(0, 40)}`,
    revision,
    resumability: "restart-safe" as const,
  };
}

function targetFactory(input: {
  readonly family: ProgressiveSqlFamily;
  readonly dataRoot: string;
  readonly injectBeforeParentCommit?: () => Promise<void>;
}): ProgressiveContentTargetFactory {
  const stores = {
    document: "document-store",
    memory: "memory-store",
    email: "message-store",
  } as const;
  return {
    schemaVersion: PROGRESSIVE_CONTENT_TARGET_FACTORY_SCHEMA_VERSION,
    family: input.family,
    adapterId: `plugin-sql-pglite-${input.family}-production-v1`,
    authoritativeStore: stores[input.family],
    productionMethod:
      input.family === "document"
        ? "DatabaseAdapter.readDocumentRange"
        : "DatabaseAdapter.readMessageContentRange",
    binaryPolicy: "typed-rejection",
    async create({ object, source }) {
      if (object.family !== input.family || source.byteLength !== object.byteLength) {
        throw new TypeError(`${input.family} target received a mismatched corpus object`);
      }
      if (object.format === "binary") {
        throw new ProgressiveSqlTargetError("CONTENT_BINARY_UNSUPPORTED");
      }
      const ids = idsFor(object.id);
      const dataDir = await fs.mkdtemp(path.join(input.dataRoot, `${input.family}-`));
      let adapter = await openAdapter(dataDir, ids.agentId, true);
      let active = true;
      let generation = 1;
      const createdAt = Date.now();
      const revision = `rev:${object.sourceSha256}`;
      const rowIds: UUID[] = [];
      try {
        await seedAuthorization(adapter, ids);
        await adapter.withEntityContext(ids.requesterId, async (tx) => {
          const staged = await stageUtf8Source({
            object,
            source,
            async publish(segment) {
              if (input.family !== "document" && object.byteLength <= SOURCE_PAGE_BYTES) {
                return;
              }
              const entry = segmentMemory({
                family: input.family,
                ids,
                segment,
                revision,
                createdAt,
              });
              await insertTargetMemory(tx as DrizzleDatabase, entry);
              rowIds.push(segment.id);
            },
          });
          const parent = parentMemory({
            family: input.family,
            object,
            ids,
            revision,
            segmentCount: staged.segments,
            ...(staged.inline === undefined ? {} : { inline: staged.inline }),
            createdAt,
          });
          // The parent is the visibility commit point in the same transaction
          // as every immutable segment. Source, digest, or commit failure rolls
          // back all rows, so process death cannot strand staged dependencies.
          await input.injectBeforeParentCommit?.();
          await insertTargetMemory(tx as DrizzleDatabase, parent);
          rowIds.push(ids.objectId);
        });
      } catch (error) {
        // error-policy:J2 verify the database transaction removed every staged
        // row before translating the realization failure at this test boundary.
        if (rowIds.length > 0) {
          const rollback = await (adapter.getDatabase() as DrizzleDatabase)
            .select({ rows: count(memoryTable.id) })
            .from(memoryTable)
            .where(inArray(memoryTable.id, rowIds));
          if (Number(rollback[0]?.rows ?? 0) !== 0) {
            await adapter.close();
            await fs.rm(dataDir, { recursive: true });
            throw new ProgressiveSqlTargetError(
              "PROGRESSIVE_STAGING_ROLLBACK_INCOMPLETE",
              "Failed progressive-content publication retained staged rows"
            );
          }
        }
        // error-policy:J6 rollback is verified; remove only the factory-owned
        // private database realization before preserving the original error.
        await adapter.close();
        await fs.rm(dataDir, { recursive: true });
        throw error;
      }

      const reference = referenceFor(input.family, object, revision);
      const nativeObject = {
        id: object.id,
        family: input.family,
        byteLength: object.byteLength,
        sourceSha256: object.sourceSha256,
        revision,
        authorizationScope: object.authorizationScope,
        canaries: object.canaries,
      };
      const read = async (request: Parameters<ProgressiveContentTarget["read"]>[0]) => {
        if (!active) throw new ProgressiveSqlTargetError("CONTENT_NOT_FOUND");
        if (request.expectedRevision && request.expectedRevision !== revision) {
          throw new ProgressiveSqlTargetError("CONTENT_STALE_REVISION");
        }
        if (request.access === "isolated") {
          throw new ProgressiveSqlTargetError("CONTENT_NOT_FOUND");
        }
        if (input.family === "document") {
          const result = await adapter.readDocumentRange({
            agentId: ids.agentId,
            requesterEntityId:
              request.access === "authorized" ? ids.requesterId : ids.unauthorizedId,
            requesterRoomIds: request.access === "authorized" ? [ids.roomId] : [],
            requesterRole: "USER",
            documentId: ids.objectId,
            unit: "byte",
            offset: request.offset,
            limit: request.limit,
          });
          if (!result) {
            throw new ProgressiveSqlTargetError(
              request.access === "authorized" ? "CONTENT_NOT_FOUND" : "CONTENT_ACCESS_DENIED"
            );
          }
          const bytes = Buffer.from(result.text, "utf8");
          return {
            bytes,
            view: buildReadView({
              reference,
              slice: {
                range: { unit: "byte", start: result.start, end: result.end, total: result.total },
                hasPrevious: result.start > 0,
                hasMore: result.end < result.total,
                ...(result.end < result.total ? { nextOffset: result.end } : {}),
                revision,
                completeness: result.end < result.total ? "partial-recoverable" : "complete",
                sliceSha256: sha256(bytes),
                sourceSha256: object.sourceSha256,
              },
            }),
            sourceWork: {
              readCalls: Math.max(1, result.sourceQueryCount - 1),
              bytesRead: result.returnedSourceSegments * SOURCE_PAGE_BYTES,
              rowsRead: result.returnedSourceSegments,
              parentScans: 0,
            },
          };
        }

        const message = await adapter.readMessageContentRange({
          agentId: ids.agentId,
          messageId: ids.objectId,
          authorizedRoomId: ids.roomId,
          accessContext: {
            requesterEntityId:
              request.access === "authorized" ? ids.requesterId : ids.unauthorizedId,
            role: "USER",
          },
          source: { kind: "message-text" },
          offset: request.offset,
          limit: request.limit,
          ...(request.expectedRevision ? { expectedRevision: request.expectedRevision } : {}),
        });
        if (message.status === "not_found")
          throw new ProgressiveSqlTargetError("CONTENT_NOT_FOUND");
        if (message.status === "forbidden") {
          throw new ProgressiveSqlTargetError("CONTENT_ACCESS_DENIED");
        }
        const page =
          message.status === "inline"
            ? (() => {
                const sliced = sliceInline({
                  text: message.text,
                  offset: request.offset,
                  limit: request.limit,
                });
                return {
                  bytes: sliced.bytes,
                  start: request.offset,
                  end: sliced.end,
                  total: object.byteLength,
                  sliceSha256: sha256(sliced.bytes),
                  rowsRead: 1,
                  bytesRead: Buffer.byteLength(message.text),
                };
              })()
            : {
                bytes: Buffer.from(message.page.text, "utf8"),
                start: message.page.start,
                end: message.page.end,
                total: message.page.total,
                sliceSha256: message.page.sliceSha256,
                rowsRead: message.page.returnedSegments,
                bytesRead: message.page.returnedSegments * SOURCE_PAGE_BYTES,
              };
        return {
          bytes: page.bytes,
          view: buildReadView({
            reference,
            slice: {
              range: { unit: "byte", start: page.start, end: page.end, total: page.total },
              hasPrevious: page.start > 0,
              hasMore: page.end < page.total,
              ...(page.end < page.total ? { nextOffset: page.end } : {}),
              revision,
              completeness: page.end < page.total ? "partial-recoverable" : "complete",
              sliceSha256: page.sliceSha256,
              sourceSha256: object.sourceSha256,
            },
          }),
          sourceWork: {
            readCalls: 1,
            bytesRead: page.bytesRead,
            rowsRead: page.rowsRead,
            parentScans: 0,
          },
        };
      };

      const target: ProgressiveContentTarget = {
        family: input.family,
        object: nativeObject,
        realization: {
          reference,
          sourceRevision: object.sourceRevision,
          authorizationMode: "principal",
          restartScope: "resolver",
          authorizationScopeDigest: sha256(object.authorizationScope),
          cleanupIdentity: `pglite:${sha256(dataDir)}`,
          resolverBindingSha256: sha256(
            `${input.family}:${ids.objectId}:${ids.agentId}:${object.sourceSha256}`
          ),
        },
        read,
        async restart() {
          if (!active) throw new ProgressiveSqlTargetError("CONTENT_NOT_FOUND");
          await adapter.close();
          adapter = await openAdapter(dataDir, ids.agentId, false);
          generation += 1;
        },
        async inspect() {
          if (!active) {
            return {
              resolverGeneration: `${input.family}:${generation}`,
              present: false,
              ownedBytes: 0,
              databaseRows: 0,
              temporaryArtifacts: 0,
              walBytes: 0,
            };
          }
          const db = adapter.getDatabase() as DrizzleDatabase;
          const aggregates = await db
            .select({
              rows: count(memoryTable.id),
              bytes: sum(sql<number>`octet_length(COALESCE(${memoryTable.content}->>'text', ''))`),
            })
            .from(memoryTable)
            .where(and(eq(memoryTable.agentId, ids.agentId), inArray(memoryTable.id, rowIds)));
          const rows = Number(aggregates[0]?.rows ?? 0);
          const bytes = Number(aggregates[0]?.bytes ?? 0);
          return {
            resolverGeneration: `${input.family}:${generation}`,
            present: rows === rowIds.length,
            ownedBytes: bytes,
            databaseRows: rows,
            temporaryArtifacts: 0,
            walBytes: 0,
          };
        },
        async cleanup() {
          if (!active) return;
          await adapter.deleteMemories(rowIds);
          await adapter.close();
          active = false;
          await fs.rm(dataDir, { recursive: true });
        },
      };
      return target;
    },
  };
}

/** Create the three SQL-owned target factories for the shared six-family harness. */
export async function createProgressiveSqlTargetFactories(input: {
  readonly dataRoot: string;
}): Promise<readonly ProgressiveContentTargetFactory[]> {
  await fs.mkdir(input.dataRoot, { recursive: true, mode: 0o700 });
  const dataRoot = await fs.realpath(input.dataRoot);
  return SQL_FAMILIES.map((family) => targetFactory({ family, dataRoot }));
}

/** Create one SQL-owned target factory for focused adapter and backend tests. */
export async function createProgressiveSqlTargetFactory(input: {
  readonly dataRoot: string;
  readonly family: ProgressiveContentTargetFamily;
  /** Test-only fault seam; the enclosing SQL transaction must roll back. */
  readonly injectBeforeParentCommit?: () => Promise<void>;
}): Promise<ProgressiveContentTargetFactory> {
  if (!SQL_FAMILIES.includes(input.family as ProgressiveSqlFamily)) {
    throw new TypeError(`plugin-sql does not own ${input.family}`);
  }
  await fs.mkdir(input.dataRoot, { recursive: true, mode: 0o700 });
  const dataRoot = await fs.realpath(input.dataRoot);
  return targetFactory({
    dataRoot,
    family: input.family as ProgressiveSqlFamily,
    ...(input.injectBeforeParentCommit
      ? { injectBeforeParentCommit: input.injectBeforeParentCommit }
      : {}),
  });
}
