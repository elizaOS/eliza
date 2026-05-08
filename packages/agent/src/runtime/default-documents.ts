import path from "node:path";
import {
  type AgentRuntime,
  logger,
  type Memory,
  MemoryType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";

const DOCUMENT_BATCH_SIZE = 100;
const DEFAULT_DOCUMENTS_SOURCE = "eliza-default-documents";
const DOCUMENTS_TABLE = "documents";
const DOCUMENT_FRAGMENTS_TABLE = "document_fragments";

type SeededMemory = Memory & { id: UUID };

export interface DefaultDocumentFragmentDefinition {
  text: string;
  embedding?: number[];
}

export interface DefaultDocumentDefinition {
  key: string;
  version: number;
  filename: string;
  contentType: string;
  text: string;
  fragments: readonly DefaultDocumentFragmentDefinition[];
  metadata?: Record<string, unknown>;
}

export const ELIZA_OVERVIEW_TEXT =
  "Eliza is an autonomous agent powered by elizaOS, the agent framework. Users can ask Eliza to write code, add new skills, and trigger recurring workflows with heartbeats that run at regular intervals. Eliza Cloud is an open source cloud backend that simplifies deploying and delivering Eliza.";

export const ELIZA_HISTORY_TEXT =
  "ELIZA was created by Joseph Weizenbaum at MIT in the mid-1960s and is widely regarded as one of the earliest chatbots. Its best-known script, DOCTOR, used pattern matching to imitate a Rogerian psychotherapist and showed how simple language rules could feel surprisingly conversational. ELIZA helped define the history of chatbots and influenced later work on conversational agents.";

export const ELIZA_CLOUD_BASICS_TEXT =
  "Eliza Cloud is the managed backend and app platform for Eliza when cloud mode is enabled. Builders can create an app, keep its appId, use Cloud login and redirect flows so app users can authenticate against Cloud, route chat and media APIs through Cloud, monetize app usage with inference markup and purchase-share settings, and deploy Docker containers when an app needs server-side execution.";

export const DEFAULT_DOCUMENTS: readonly DefaultDocumentDefinition[] = [
  {
    key: "eliza-overview",
    version: 1,
    filename: "eliza-overview.txt",
    contentType: "text/plain",
    text: ELIZA_OVERVIEW_TEXT,
    fragments: [
      {
        text: ELIZA_OVERVIEW_TEXT,
      },
    ],
  },
  {
    key: "eliza-history",
    version: 1,
    filename: "eliza-history.txt",
    contentType: "text/plain",
    text: ELIZA_HISTORY_TEXT,
    fragments: [
      {
        text: ELIZA_HISTORY_TEXT,
      },
    ],
  },
  {
    key: "eliza-cloud-basics",
    version: 1,
    filename: "eliza-cloud-basics.txt",
    contentType: "text/plain",
    text: ELIZA_CLOUD_BASICS_TEXT,
    fragments: [
      {
        text: ELIZA_CLOUD_BASICS_TEXT,
      },
    ],
  },
];

function getDocumentId(agentId: UUID, key: string): UUID {
  return stringToUuid(`eliza-default-knowledge:${agentId}:${key}:document`);
}

function getFragmentId(agentId: UUID, key: string, index: number): UUID {
  return stringToUuid(
    `eliza-default-knowledge:${agentId}:${key}:fragment:${index}`,
  );
}

function getExpectedEmbeddingDimensions(
  runtime: AgentRuntime,
): number | undefined {
  const raw = runtime.getSetting("EMBEDDING_DIMENSION");
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseInt(raw, 10)
        : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeProvidedEmbedding(
  runtime: AgentRuntime,
  document: DefaultDocumentDefinition,
  index: number,
  embedding: readonly number[] | undefined,
): number[] | undefined {
  if (!embedding || embedding.length === 0) {
    return undefined;
  }

  if (!embedding.every((value) => Number.isFinite(value))) {
    logger.warn(
      `[eliza] Ignoring bundled document embedding for ${document.filename} fragment ${index}: vector contains non-finite values.`,
    );
    return undefined;
  }

  const expectedDimensions = getExpectedEmbeddingDimensions(runtime);
  if (
    expectedDimensions !== undefined &&
    embedding.length !== expectedDimensions
  ) {
    logger.warn(
      `[eliza] Ignoring bundled document embedding for ${document.filename} fragment ${index}: expected ${expectedDimensions} dimensions, received ${embedding.length}.`,
    );
    return undefined;
  }

  return [...embedding];
}

function extractTimestamp(memory: Memory | null): number {
  const metadata = memory?.metadata as Record<string, unknown> | undefined;
  const timestamp = metadata?.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp)
    ? timestamp
    : Date.now();
}

function buildDocumentMetadata(
  document: DefaultDocumentDefinition,
  documentId: UUID,
  agentId: UUID,
  timestamp: number,
): Record<string, unknown> {
  const parsed = path.parse(document.filename);

  return {
    type: MemoryType.DOCUMENT,
    documentId,
    filename: document.filename,
    originalFilename: document.filename,
    title: parsed.name || document.filename,
    fileExt: parsed.ext.replace(/^\./, ""),
    fileType: document.contentType,
    contentType: document.contentType,
    fileSize: Buffer.byteLength(document.text, "utf8"),
    source: DEFAULT_DOCUMENTS_SOURCE,
    timestamp,
    scope: "global",
    scopedToEntityId: undefined,
    addedBy: agentId,
    addedByRole: "RUNTIME",
    addedFrom: "default-seed",
    addedAt: timestamp,
    bundledDocument: true,
    bundledDocumentKey: document.key,
    bundledDocumentVersion: document.version,
    ...(document.metadata ?? {}),
  };
}

function buildFragmentMetadata(
  document: DefaultDocumentDefinition,
  documentId: UUID,
  index: number,
  agentId: UUID,
  timestamp: number,
): Record<string, unknown> {
  return {
    type: MemoryType.FRAGMENT,
    documentId,
    position: index,
    source: DEFAULT_DOCUMENTS_SOURCE,
    timestamp,
    scope: "global",
    scopedToEntityId: undefined,
    addedBy: agentId,
    addedByRole: "RUNTIME",
    addedFrom: "default-seed",
    addedAt: timestamp,
    bundledDocument: true,
    bundledDocumentKey: document.key,
    bundledDocumentVersion: document.version,
  };
}

function embeddingsEqual(
  left: readonly number[] | undefined,
  right: readonly number[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function documentMatchesDefinition(
  existing: Memory | null,
  document: DefaultDocumentDefinition,
  documentId: UUID,
): boolean {
  if (!existing) return false;

  const metadata = existing.metadata as Record<string, unknown> | undefined;
  return (
    existing.content.text === document.text &&
    metadata?.type === MemoryType.DOCUMENT &&
    metadata?.documentId === documentId &&
    metadata?.filename === document.filename &&
    metadata?.contentType === document.contentType &&
    metadata?.bundledDocumentKey === document.key &&
    metadata?.bundledDocumentVersion === document.version
  );
}

function fragmentMatchesDefinition(
  existing: Memory | null,
  document: DefaultDocumentDefinition,
  documentId: UUID,
  index: number,
  text: string,
  embedding: readonly number[] | undefined,
): boolean {
  if (!existing) return false;

  const metadata = existing.metadata as Record<string, unknown> | undefined;
  const existingEmbedding = Array.isArray(existing.embedding)
    ? existing.embedding
    : undefined;

  return (
    existing.content.text === text &&
    metadata?.type === MemoryType.FRAGMENT &&
    metadata?.documentId === documentId &&
    metadata?.position === index &&
    metadata?.bundledDocumentKey === document.key &&
    metadata?.bundledDocumentVersion === document.version &&
    embeddingsEqual(existingEmbedding, embedding)
  );
}

async function listFragmentIdsForDocument(
  runtime: AgentRuntime,
  documentId: UUID,
): Promise<UUID[]> {
  const fragmentIds: UUID[] = [];
  let offset = 0;

  while (true) {
    const batch = await runtime.getMemories({
      tableName: DOCUMENT_FRAGMENTS_TABLE,
      roomId: runtime.agentId,
      limit: DOCUMENT_BATCH_SIZE,
      start: offset,
    });

    if (batch.length === 0) break;

    for (const memory of batch) {
      const metadata = memory.metadata as Record<string, unknown> | undefined;
      if (
        typeof memory.id === "string" &&
        metadata?.documentId === documentId
      ) {
        fragmentIds.push(memory.id as UUID);
      }
    }

    if (batch.length < DOCUMENT_BATCH_SIZE) break;
    offset += DOCUMENT_BATCH_SIZE;
  }

  return fragmentIds;
}

async function seedBundledDocument(
  runtime: AgentRuntime,
  document: DefaultDocumentDefinition,
): Promise<void> {
  const documentId = getDocumentId(runtime.agentId, document.key);
  const existingDocument = await runtime.getMemoryById(documentId);
  const documentTimestamp = extractTimestamp(existingDocument);
  const documentCreatedAt =
    typeof existingDocument?.createdAt === "number"
      ? existingDocument.createdAt
      : Date.now();

  const documentMemory: SeededMemory = {
    id: documentId,
    agentId: runtime.agentId,
    roomId: runtime.agentId,
    worldId: runtime.agentId,
    entityId: runtime.agentId,
    content: { text: document.text },
    metadata: buildDocumentMetadata(
      document,
      documentId,
      runtime.agentId,
      documentTimestamp,
    ),
    createdAt: documentCreatedAt,
  };

  let changed = false;

  if (!documentMatchesDefinition(existingDocument, document, documentId)) {
    if (existingDocument) {
      await runtime.updateMemory(documentMemory);
    } else {
      await runtime.createMemory(documentMemory, DOCUMENTS_TABLE);
    }
    changed = true;
  }

  const staleFragmentIds = new Set(
    await listFragmentIdsForDocument(runtime, documentId),
  );

  for (const [index, fragment] of document.fragments.entries()) {
    const fragmentId = getFragmentId(runtime.agentId, document.key, index);
    const existingFragment = await runtime.getMemoryById(fragmentId);
    const normalizedEmbedding = normalizeProvidedEmbedding(
      runtime,
      document,
      index,
      fragment.embedding,
    );
    const existingEmbedding =
      existingFragment?.content.text === fragment.text &&
      Array.isArray(existingFragment.embedding) &&
      existingFragment.embedding.length > 0
        ? [...existingFragment.embedding]
        : undefined;
    const fragmentEmbedding = normalizedEmbedding ?? existingEmbedding;
    const fragmentTimestamp = extractTimestamp(existingFragment);
    const fragmentCreatedAt =
      typeof existingFragment?.createdAt === "number"
        ? existingFragment.createdAt
        : Date.now();

    const fragmentMemory: SeededMemory = {
      id: fragmentId,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      worldId: runtime.agentId,
      entityId: runtime.agentId,
      content: { text: fragment.text },
      metadata: buildFragmentMetadata(
        document,
        documentId,
        index,
        runtime.agentId,
        fragmentTimestamp,
      ),
      ...(fragmentEmbedding ? { embedding: fragmentEmbedding } : {}),
      createdAt: fragmentCreatedAt,
    };

    if (!fragmentEmbedding) {
      await runtime.addEmbeddingToMemory(fragmentMemory);
    }

    if (
      !fragmentMatchesDefinition(
        existingFragment,
        document,
        documentId,
        index,
        fragment.text,
        fragmentMemory.embedding,
      )
    ) {
      if (existingFragment) {
        await runtime.updateMemory(fragmentMemory);
      } else {
        await runtime.createMemory(fragmentMemory, DOCUMENT_FRAGMENTS_TABLE);
      }
      changed = true;
    }

    staleFragmentIds.delete(fragmentId);
  }

  for (const fragmentId of staleFragmentIds) {
    await runtime.deleteMemory(fragmentId);
    changed = true;
  }

  if (changed) {
    logger.info(
      `[eliza] Seeded bundled document "${document.filename}" (${document.fragments.length} fragment${document.fragments.length === 1 ? "" : "s"}).`,
    );
  }
}

export async function seedBundledDocuments(
  runtime: AgentRuntime,
  documents: readonly DefaultDocumentDefinition[] = DEFAULT_DOCUMENTS,
): Promise<void> {
  for (const document of documents) {
    await seedBundledDocument(runtime, document);
  }
}
