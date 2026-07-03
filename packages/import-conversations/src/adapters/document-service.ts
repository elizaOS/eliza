import { createHash } from "node:crypto";
import type {
  DocumentScope,
  DocumentSink,
  SinkAddResult,
  SinkDocument,
} from "../core/sink.ts";

type OpaqueId = string;

export interface DocumentServiceAddOptions {
  agentId?: OpaqueId;
  worldId: OpaqueId;
  roomId: OpaqueId;
  entityId: OpaqueId;
  clientDocumentId: OpaqueId;
  contentType: string;
  originalFilename: string;
  content: string;
  scope?: DocumentScope;
  scopedToEntityId?: OpaqueId;
  addedBy?: OpaqueId;
  addedByRole?: string;
  addedFrom?: string;
  metadata?: Record<string, unknown>;
}

export interface DocumentServiceAddResult {
  clientDocumentId?: OpaqueId;
  storedDocumentMemoryId?: OpaqueId;
  fragmentCount?: number;
}

export interface DocumentServiceLike {
  addDocument(
    options: DocumentServiceAddOptions,
  ): Promise<DocumentServiceAddResult>;
  deleteDocument(documentId: OpaqueId): Promise<void>;
}

export interface DocumentServiceSinkContext {
  agentId?: OpaqueId;
  worldId: OpaqueId;
  roomId: OpaqueId;
  entityId: OpaqueId;
  scopedToEntityId?: OpaqueId;
  addedBy?: OpaqueId;
  addedByRole?: string;
  addedFrom?: string;
}

export interface CreateDocumentServiceSinkOptions
  extends DocumentServiceSinkContext {
  clientDocumentId?: (doc: SinkDocument) => OpaqueId;
  statusFromResult?: (
    result: DocumentServiceAddResult,
    doc: SinkDocument,
  ) => SinkAddResult["status"];
}

function asUuidFromHash(input: string): string {
  const hex = createHash("sha256").update(input).digest("hex");
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80)
    .toString(16)
    .padStart(2, "0");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

export function defaultImportClientDocumentId(doc: SinkDocument): string {
  return asUuidFromHash(
    [
      doc.contentType,
      doc.originalFilename,
      doc.scope ?? "",
      doc.scopedToEntityId ?? "",
      doc.content,
    ].join("\0"),
  );
}

function resultId(result: DocumentServiceAddResult): string {
  const id = result.storedDocumentMemoryId ?? result.clientDocumentId;
  if (!id) {
    throw new Error(
      "DocumentService sink: addDocument result must include storedDocumentMemoryId or clientDocumentId",
    );
  }
  return id;
}

export function createDocumentServiceSink(
  service: DocumentServiceLike,
  options: CreateDocumentServiceSinkOptions,
): DocumentSink {
  const idFor = options.clientDocumentId ?? defaultImportClientDocumentId;
  const statusFor = options.statusFromResult ?? (() => "stored" as const);

  return {
    async addDocument(doc: SinkDocument): Promise<SinkAddResult> {
      const result = await service.addDocument({
        agentId: options.agentId,
        worldId: options.worldId,
        roomId: options.roomId,
        entityId: options.entityId,
        clientDocumentId: idFor(doc),
        contentType: doc.contentType,
        originalFilename: doc.originalFilename,
        content: doc.content,
        scope: doc.scope,
        scopedToEntityId: doc.scopedToEntityId ?? options.scopedToEntityId,
        addedBy: options.addedBy,
        addedByRole: options.addedByRole,
        addedFrom: doc.addedFrom ?? options.addedFrom ?? "import",
        metadata: doc.metadata,
      });
      return {
        id: resultId(result),
        status: statusFor(result, doc),
      };
    },
    deleteDocument(documentId: string): Promise<void> {
      return service.deleteDocument(documentId);
    },
  };
}
