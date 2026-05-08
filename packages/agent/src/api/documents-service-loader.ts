import type { AgentRuntime, Memory, Service, UUID } from "@elizaos/core";

// Canonical union types for the documents service surface.
// Plugin packages (e.g. @elizaos/app-documents) re-export these so route
// helpers and presenters share one type vocabulary across the workspace.
export type DocumentVisibilityScope =
  | "global"
  | "owner-private"
  | "user-private"
  | "agent-private";

export type DocumentAddedByRole =
  | "OWNER"
  | "ADMIN"
  | "USER"
  | "AGENT"
  | "RUNTIME";

export type DocumentAddedFrom =
  | "chat"
  | "upload"
  | "url"
  | "file"
  | "agent-autonomous"
  | "runtime-internal"
  | "lifeops"
  | "default-seed"
  | "character";

export type DocumentSearchMode = "hybrid" | "vector" | "keyword";

export interface DocumentsServiceLike {
  addDocument(options: {
    agentId?: UUID;
    worldId: UUID;
    roomId: UUID;
    entityId: UUID;
    clientDocumentId: UUID;
    contentType: string;
    originalFilename: string;
    content: string;
    metadata?: Record<string, unknown>;
    scope?: DocumentVisibilityScope;
    scopedToEntityId?: UUID;
    addedBy?: UUID;
    addedByRole?: DocumentAddedByRole;
    addedFrom?: DocumentAddedFrom;
  }): Promise<{
    clientDocumentId: string;
    storedDocumentMemoryId: UUID;
    fragmentCount: number;
  }>;
  searchDocuments(
    message: Memory,
    scope?: { roomId?: UUID; worldId?: UUID; entityId?: UUID },
    searchMode?: DocumentSearchMode,
  ): Promise<
    Array<{
      id: UUID;
      content: { text?: string };
      similarity?: number;
      metadata?: Record<string, unknown>;
      worldId?: UUID;
    }>
  >;
  listDocuments?(
    message?: Memory,
    options?: Record<string, unknown>,
  ): Promise<Memory[]>;
  getDocumentById?(documentId: UUID, message?: Memory): Promise<Memory | null>;
  getMemories(params: {
    tableName: string;
    roomId?: UUID;
    count?: number;
    offset?: number;
    end?: number;
  }): Promise<Memory[]>;
  countMemories(params: {
    tableName: string;
    roomId?: UUID;
    unique?: boolean;
  }): Promise<number>;
  updateDocument(options: {
    documentId: UUID;
    content: string;
    message?: Memory;
  }): Promise<{
    documentId: UUID;
    fragmentCount: number;
  }>;
  deleteDocument?(documentId: UUID, message?: Memory): Promise<void>;
  deleteMemory(memoryId: UUID): Promise<void>;
}

/** Alias kept for backwards-compatible plugin imports. */
export type DocumentServiceLike = DocumentsServiceLike;

export type DocumentsLoadFailReason =
  | "timeout"
  | "runtime_unavailable"
  | "not_registered";

export interface DocumentsServiceResult {
  service: DocumentsServiceLike | null;
  reason?: DocumentsLoadFailReason;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

export function getDocumentsServiceTimeoutMs(): number {
  const envVal = process.env.DOCUMENTS_SERVICE_TIMEOUT_MS;
  if (!envVal) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(envVal, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

/** Alias kept for backwards-compatible plugin imports. */
export const getDocumentsTimeoutMs = getDocumentsServiceTimeoutMs;

export async function getDocumentsService(
  runtime: AgentRuntime | null,
): Promise<DocumentsServiceResult> {
  if (!runtime) {
    return { service: null, reason: "runtime_unavailable" };
  }

  let service = runtime.getService<Service & DocumentsServiceLike>("documents");
  if (service) return { service };

  try {
    const servicePromise = runtime.getServiceLoadPromise("documents");
    const timeoutMs = getDocumentsServiceTimeoutMs();
    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("documents service timeout")),
        timeoutMs,
      );
    });
    await Promise.race([servicePromise, timeout]);
    service = runtime.getService<Service & DocumentsServiceLike>("documents");
    if (service) return { service };
    return { service: null, reason: "not_registered" };
  } catch {
    return { service: null, reason: "timeout" };
  }
}
