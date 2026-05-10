import type { Memory } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { dbWrite } from "@/db/helpers";
import { memoriesRepository } from "@/db/repositories/agents";
import { DOCUMENT_CONSTANTS, isValidFilename } from "@/lib/constants/documents";
import { charactersService } from "@/lib/services/characters/characters";
import type { AppEnv, AuthedUser } from "@/types/cloud-worker-env";

export interface DocumentScope {
  agentId: string;
  roomId: string;
  characterId?: string;
}

export interface DocumentFileInput {
  filename: string;
  contentType: string;
  size: number;
  text: string;
}

export interface PendingDocumentFile {
  blobUrl: string;
  filename: string;
  contentType: string;
  size: number;
}

export function sanitizeFilename(filename: string): string {
  const trimmed = filename
    .trim()
    .replaceAll(/[/\\:*?"<>|]/g, "-")
    .replaceAll("..", ".");
  return isValidFilename(trimmed) ? trimmed : `document-${Date.now()}.txt`;
}

export function r2KeyFromBlobUrl(blobUrl: string): string | null {
  try {
    const url = new URL(blobUrl);
    const key = url.pathname.replace(/^\/+/, "");
    return key.startsWith("documents-pre-upload/") ? key : null;
  } catch {
    return null;
  }
}

export function publicBlobUrl(c: { env: AppEnv["Bindings"] }, key: string): string {
  const host =
    typeof c.env.R2_PUBLIC_HOST === "string" && c.env.R2_PUBLIC_HOST.trim()
      ? c.env.R2_PUBLIC_HOST.trim()
      : "blob.elizacloud.ai";
  return `https://${host.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/${key}`;
}

export async function resolveDocumentScope(
  user: AuthedUser,
  characterId?: string | null,
): Promise<DocumentScope | Response> {
  const normalizedCharacterId = characterId?.trim();
  if (!normalizedCharacterId) {
    return {
      agentId: user.id,
      roomId: user.id,
    };
  }

  const character = await charactersService.getByIdForUser(normalizedCharacterId, user.id);
  if (!character) {
    return Response.json({ success: false, error: "Character not found" }, { status: 404 });
  }

  return {
    agentId: normalizedCharacterId,
    roomId: normalizedCharacterId,
    characterId: normalizedCharacterId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function timestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return new Date(value).getTime();
  return Date.now();
}

function getMemoryStringField(memory: Memory, key: string): string | undefined {
  if (!(key in memory)) return undefined;
  const value = memory[key as keyof Memory];
  return typeof value === "string" ? value : undefined;
}

export function isStoredDocumentMemory(memory: Memory | null): memory is Memory & { id: string } {
  return (
    !!memory &&
    typeof memory.id === "string" &&
    getMemoryStringField(memory, "type") === "documents"
  );
}

export function toDocumentRecord(memory: Memory) {
  const contentMetadata = isRecord(memory.content.metadata) ? memory.content.metadata : undefined;
  const metadata = isRecord(memory.metadata) ? memory.metadata : (contentMetadata ?? {});
  return {
    id: memory.id ?? "",
    content: {
      text: memory.content?.text ?? "",
    },
    createdAt: timestamp(memory.createdAt),
    metadata,
  };
}

function fragmentTextChunks(text: string): string[] {
  const maxLength = 4000;
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += maxLength) {
    const chunk = text.slice(offset, offset + maxLength).trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks.length > 0 ? chunks : [text];
}

export async function listDocumentRecords(scope: DocumentScope, limit = 100, offset = 0) {
  const memories = await memoriesRepository.search({
    agentId: scope.agentId,
    roomId: scope.roomId,
    type: "documents",
    limit,
    offset,
  });

  return memories.map(toDocumentRecord);
}

export async function createDocumentRecord(
  user: AuthedUser,
  scope: DocumentScope,
  input: DocumentFileInput,
) {
  await ensureDocumentStorageGraph(user, scope);

  const id = crypto.randomUUID();
  const filename = sanitizeFilename(input.filename);
  const now = Date.now();
  const metadata = {
    type: "document",
    timestamp: now,
    scope: "user-private",
    scopedToEntityId: user.id,
    addedBy: user.id,
    addedByRole: "USER",
    addedFrom: "upload",
    source: "upload",
    filename,
    fileName: filename,
    originalFilename: input.filename,
    fileSize: input.size,
    contentType: input.contentType,
    uploadedBy: user.id,
    uploadedAt: now,
    characterId: scope.characterId,
  };
  const memory = await memoriesRepository.create({
    id,
    roomId: scope.roomId,
    entityId: user.id,
    agentId: scope.agentId,
    type: "documents",
    unique: false,
    content: {
      text: input.text,
      source: "documents",
    },
    metadata,
  });

  for (const [position, text] of fragmentTextChunks(input.text).entries()) {
    await memoriesRepository.create({
      id: crypto.randomUUID(),
      roomId: scope.roomId,
      entityId: user.id,
      agentId: scope.agentId,
      type: "document_fragments",
      unique: false,
      content: { text },
      metadata: {
        ...metadata,
        type: "fragment",
        documentId: id,
        position,
        timestamp: now,
      },
    });
  }

  return toDocumentRecord(memory);
}

async function ensureDocumentStorageGraph(user: AuthedUser, scope: DocumentScope): Promise<void> {
  const now = new Date();
  const agentName = scope.characterId ? `Documents ${scope.characterId}` : "User Documents";

  await dbWrite.execute(sql`
    INSERT INTO agents (id, name, enabled, created_at, updated_at)
    VALUES (${scope.agentId}::uuid, ${agentName}, true, ${now}, ${now})
    ON CONFLICT (id) DO NOTHING
  `);

  await dbWrite.execute(sql`
    INSERT INTO rooms (id, agent_id, source, type, name, metadata, created_at)
    VALUES (
      ${scope.roomId}::uuid,
      ${scope.agentId}::uuid,
      'documents',
      'DIRECT',
      'Documents',
      ${JSON.stringify({ characterId: scope.characterId, userId: user.id })}::jsonb,
      ${now}
    )
    ON CONFLICT (id) DO NOTHING
  `);

  await dbWrite.execute(sql`
    INSERT INTO entities (id, agent_id, names, metadata, created_at)
    VALUES (
      ${user.id}::uuid,
      ${scope.agentId}::uuid,
      ARRAY[${user.email ?? "User"}],
      ${JSON.stringify({ source: "documents" })}::jsonb,
      ${now}
    )
    ON CONFLICT (id) DO NOTHING
  `);
}

export function validateDocumentFiles(files: File[]): Response | null {
  if (files.length === 0) {
    return Response.json({ success: false, error: "No files provided" }, { status: 400 });
  }
  if (files.length > DOCUMENT_CONSTANTS.MAX_FILES_PER_REQUEST) {
    return Response.json(
      {
        success: false,
        error: `Upload at most ${DOCUMENT_CONSTANTS.MAX_FILES_PER_REQUEST} files at a time`,
      },
      { status: 400 },
    );
  }

  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > DOCUMENT_CONSTANTS.MAX_BATCH_SIZE) {
    return Response.json({ success: false, error: "Upload batch exceeds 5MB" }, { status: 413 });
  }

  const oversized = files.find((file) => file.size > DOCUMENT_CONSTANTS.MAX_FILE_SIZE);
  if (oversized) {
    return Response.json(
      { success: false, error: `"${oversized.name}" exceeds the 5MB file limit` },
      { status: 413 },
    );
  }

  return null;
}

export async function fileToDocumentInput(file: File): Promise<DocumentFileInput> {
  return {
    filename: sanitizeFilename(file.name || "document.txt"),
    contentType: file.type || "application/octet-stream",
    size: file.size,
    text: await file.text(),
  };
}

export function scoreDocumentText(text: string, query: string): number {
  const normalizedText = text.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  if (normalizedText.includes(normalizedQuery)) return 1;

  const terms = Array.from(new Set(normalizedQuery.split(/\s+/).filter((term) => term.length > 1)));
  if (terms.length === 0) return 0;

  const matches = terms.filter((term) => normalizedText.includes(term)).length;
  return matches / terms.length;
}
