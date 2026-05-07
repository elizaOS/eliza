import type { AgentRuntime, Memory, Service, UUID } from "@elizaos/core";

export interface DocumentsServiceLike {
  addKnowledge(options: {
    agentId?: UUID;
    worldId: UUID;
    roomId: UUID;
    entityId: UUID;
    clientDocumentId: UUID;
    contentType: string;
    originalFilename: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    clientDocumentId: string;
    storedDocumentMemoryId: UUID;
    fragmentCount: number;
  }>;
  getKnowledge(
    message: Memory,
    scope?: { roomId?: UUID; worldId?: UUID; entityId?: UUID },
  ): Promise<
    Array<{
      id: UUID;
      content: { text?: string };
      similarity?: number;
      metadata?: Record<string, unknown>;
    }>
  >;
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
  updateKnowledgeDocument?(options: {
    documentId: UUID;
    content: string;
  }): Promise<{
    documentId: UUID;
    fragmentCount: number;
  }>;
  deleteMemory(memoryId: UUID): Promise<void>;
}

/** @deprecated Use DocumentsServiceLike */
export type KnowledgeServiceLike = DocumentsServiceLike;

export type DocumentsLoadFailReason =
  | "timeout"
  | "runtime_unavailable"
  | "not_registered";

/** @deprecated Use DocumentsLoadFailReason */
export type KnowledgeLoadFailReason = DocumentsLoadFailReason;

export interface DocumentsServiceResult {
  service: DocumentsServiceLike | null;
  reason?: DocumentsLoadFailReason;
}

/** @deprecated Use DocumentsServiceResult */
export type KnowledgeServiceResult = DocumentsServiceResult;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

export function getDocumentsServiceTimeoutMs(): number {
  const envVal = process.env.KNOWLEDGE_SERVICE_TIMEOUT_MS;
  if (!envVal) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(envVal, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

/** @deprecated Use getDocumentsServiceTimeoutMs */
export const getKnowledgeTimeoutMs = getDocumentsServiceTimeoutMs;

export async function getDocumentsService(
  runtime: AgentRuntime | null,
): Promise<DocumentsServiceResult> {
  if (!runtime) {
    return { service: null, reason: "runtime_unavailable" };
  }

  let service = runtime.getService<Service & DocumentsServiceLike>("knowledge");
  if (service) return { service };

  try {
    const servicePromise = runtime.getServiceLoadPromise("knowledge");
    const timeoutMs = getDocumentsServiceTimeoutMs();
    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("documents service timeout")),
        timeoutMs,
      );
    });
    await Promise.race([servicePromise, timeout]);
    service = runtime.getService<Service & DocumentsServiceLike>("knowledge");
    if (service) return { service };
    return { service: null, reason: "not_registered" };
  } catch {
    return { service: null, reason: "timeout" };
  }
}

/** @deprecated Use getDocumentsService */
export const getKnowledgeService = getDocumentsService;
