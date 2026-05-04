import crypto from "node:crypto";
import type http from "node:http";
import {
  type AgentRuntime,
  type Memory,
  MemoryType,
  type UUID,
} from "@elizaos/core";
import {
  estimateScratchpadTokenCount,
  SCRATCHPAD_MAX_TOPICS,
  SCRATCHPAD_TOPIC_SUMMARY_MAX_LENGTH,
  SCRATCHPAD_TOPIC_TOKEN_LIMIT,
  type ScratchpadCreateTopicRequest,
  type ScratchpadDeleteTopicResponse,
  type ScratchpadReplaceTopicRequest,
  type ScratchpadSearchResponse,
  type ScratchpadSummaryPreviewResponse,
  type ScratchpadTopicDto,
  type ScratchpadTopicMatchDto,
  type ScratchpadTopicResponse,
  type ScratchpadTopicsListResponse,
  scratchpadCreateTopicRequestSchema,
  scratchpadReplaceTopicRequestSchema,
  scratchpadSearchQuerySchema,
  scratchpadSummaryPreviewRequestSchema,
} from "@elizaos/shared/contracts";
import type { KnowledgeServiceLike } from "./service-loader.js";

const SCRATCHPAD_SOURCE = "scratchpad";
const SCRATCHPAD_KIND = "topic";
const SCRATCHPAD_METADATA_VERSION = 1;
const SCRATCHPAD_DOCUMENT_BATCH_SIZE = 500;
const SCRATCHPAD_FRAGMENT_BATCH_SIZE = 500;
const SCRATCHPAD_CONTENT_TYPE = "text/markdown";

export class ScratchpadTopicError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ScratchpadTopicError";
  }
}

interface ScratchpadTopicRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: object,
  ) => Promise<T | null>;
}

type ScratchpadMetadata = Record<string, unknown> & {
  source: typeof SCRATCHPAD_SOURCE;
  scratchpadKind: typeof SCRATCHPAD_KIND;
  scratchpadVersion: typeof SCRATCHPAD_METADATA_VERSION;
  title: string;
  summary: string;
  scratchpadCreatedAt: number;
  scratchpadUpdatedAt: number;
  type: typeof MemoryType.DOCUMENT;
  documentId?: UUID;
  filename: string;
  originalFilename: string;
  contentType: typeof SCRATCHPAD_CONTENT_TYPE;
  fileType: typeof SCRATCHPAD_CONTENT_TYPE;
  textBacked: true;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  throw new ScratchpadTopicError(
    500,
    `Scratchpad topic is missing ${fieldName}`,
  );
}

function readNumber(value: unknown, fieldName: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  throw new ScratchpadTopicError(
    500,
    `Scratchpad topic is missing ${fieldName}`,
  );
}

function isScratchpadMetadata(
  metadata: Record<string, unknown> | null,
): metadata is ScratchpadMetadata {
  return (
    metadata?.source === SCRATCHPAD_SOURCE &&
    metadata?.scratchpadKind === SCRATCHPAD_KIND
  );
}

function normalizeSummary(summary: string): string {
  const normalized = summary.replace(/\s+/g, " ").trim();
  return normalized.length <= SCRATCHPAD_TOPIC_SUMMARY_MAX_LENGTH
    ? normalized
    : normalized.slice(0, SCRATCHPAD_TOPIC_SUMMARY_MAX_LENGTH).trimEnd();
}

export function buildScratchpadSummary(text: string): string {
  const firstMarkdownHeading = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && /^#{1,6}\s+/.test(line));

  if (firstMarkdownHeading) {
    return normalizeSummary(firstMarkdownHeading.replace(/^#{1,6}\s+/, ""));
  }

  return normalizeSummary(text);
}

function slugTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : "topic";
}

function buildScratchpadMetadata(params: {
  title: string;
  summary: string;
  createdAt: number;
  updatedAt: number;
  originalFilename: string;
  documentId?: UUID;
}): ScratchpadMetadata {
  return {
    source: SCRATCHPAD_SOURCE,
    scratchpadKind: SCRATCHPAD_KIND,
    scratchpadVersion: SCRATCHPAD_METADATA_VERSION,
    type: MemoryType.DOCUMENT,
    ...(params.documentId ? { documentId: params.documentId } : {}),
    title: params.title,
    summary: params.summary,
    scratchpadCreatedAt: params.createdAt,
    scratchpadUpdatedAt: params.updatedAt,
    filename: params.title,
    originalFilename: params.originalFilename,
    contentType: SCRATCHPAD_CONTENT_TYPE,
    fileType: SCRATCHPAD_CONTENT_TYPE,
    fileExt: "md",
    textBacked: true,
  };
}

function formatSchemaError(
  issues: Array<{ path: PropertyKey[]; message: string }>,
) {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}

function parseTopicId(pathPart: string): UUID {
  const decoded = decodeURIComponent(pathPart).trim();
  if (decoded.length === 0) {
    throw new ScratchpadTopicError(400, "topic id is required");
  }
  return decoded as UUID;
}

export class ScratchpadTopicService {
  private readonly agentId: UUID;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly knowledgeService: KnowledgeServiceLike,
  ) {
    this.agentId = runtime.agentId as UUID;
  }

  async listTopics(): Promise<ScratchpadTopicDto[]> {
    const documents = await this.listTopicDocuments();
    const topics: ScratchpadTopicDto[] = [];

    for (const document of documents) {
      topics.push(await this.toTopicDto(document));
    }

    return topics.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createTopic(
    request: ScratchpadCreateTopicRequest,
  ): Promise<ScratchpadTopicDto> {
    this.assertTokenLimit(request.text);

    const existingTopics = await this.listTopicDocuments();
    if (existingTopics.length >= SCRATCHPAD_MAX_TOPICS) {
      throw new ScratchpadTopicError(
        409,
        `Scratchpad topic limit reached (${SCRATCHPAD_MAX_TOPICS})`,
      );
    }

    const now = Date.now();
    const summary = request.summary
      ? normalizeSummary(request.summary)
      : buildScratchpadSummary(request.text);
    const originalFilename = `scratchpad-${now}-${crypto.randomUUID()}-${slugTitle(
      request.title,
    )}.md`;

    const result = await this.knowledgeService.addKnowledge({
      agentId: this.agentId,
      worldId: this.agentId,
      roomId: this.agentId,
      entityId: this.agentId,
      clientDocumentId: "" as UUID,
      contentType: SCRATCHPAD_CONTENT_TYPE,
      originalFilename,
      content: request.text,
      metadata: buildScratchpadMetadata({
        title: request.title,
        summary,
        createdAt: now,
        updatedAt: now,
        originalFilename,
      }),
    });

    return this.readTopic(result.clientDocumentId as UUID);
  }

  async readTopic(topicId: UUID): Promise<ScratchpadTopicDto> {
    const document = await this.getOwnedTopicDocument(topicId);
    return this.toTopicDto(document);
  }

  async replaceTopic(
    topicId: UUID,
    request: ScratchpadReplaceTopicRequest,
  ): Promise<ScratchpadTopicDto> {
    this.assertTokenLimit(request.text);

    if (typeof this.knowledgeService.updateKnowledgeDocument !== "function") {
      throw new ScratchpadTopicError(
        503,
        "Scratchpad topic replacement is unavailable",
      );
    }

    const existingDocument = await this.getOwnedTopicDocument(topicId);
    const metadata = asRecord(existingDocument.metadata);
    const createdAt = readNumber(
      metadata?.scratchpadCreatedAt,
      "scratchpadCreatedAt",
    );
    const originalFilename = readString(
      metadata?.originalFilename,
      "originalFilename",
    );
    const updatedAt = Date.now();
    const summary = request.summary
      ? normalizeSummary(request.summary)
      : buildScratchpadSummary(request.text);

    await this.runtime.updateMemory({
      id: topicId,
      agentId: this.agentId,
      roomId: this.agentId,
      worldId: this.agentId,
      entityId: this.agentId,
      content: { text: request.text },
      metadata: buildScratchpadMetadata({
        title: request.title,
        summary,
        createdAt,
        updatedAt,
        originalFilename,
        documentId: topicId,
      }),
      createdAt: existingDocument.createdAt,
    });

    await this.knowledgeService.updateKnowledgeDocument({
      documentId: topicId,
      content: request.text,
    });

    return this.readTopic(topicId);
  }

  async deleteTopic(topicId: UUID): Promise<ScratchpadDeleteTopicResponse> {
    await this.getOwnedTopicDocument(topicId);
    const fragmentIds = await this.listFragmentIds(topicId);

    for (const fragmentId of fragmentIds) {
      await this.knowledgeService.deleteMemory(fragmentId);
    }
    await this.knowledgeService.deleteMemory(topicId);

    return {
      ok: true,
      topicId,
      deletedFragments: fragmentIds.length,
    };
  }

  async searchTopics(params: {
    q: string;
    limit?: number;
  }): Promise<ScratchpadSearchResponse> {
    const limit = params.limit ?? SCRATCHPAD_MAX_TOPICS;
    const searchMessage: Memory = {
      id: crypto.randomUUID() as UUID,
      entityId: this.agentId,
      agentId: this.agentId,
      roomId: this.agentId,
      content: { text: params.q },
      createdAt: Date.now(),
    };

    const matches = await this.knowledgeService.getKnowledge(searchMessage, {
      roomId: this.agentId,
      worldId: this.agentId,
      entityId: this.agentId,
    });

    const grouped = new Map<
      UUID,
      { score: number; matches: ScratchpadTopicMatchDto[] }
    >();

    for (const match of matches) {
      const metadata = asRecord(match.metadata);
      if (!isScratchpadMetadata(metadata)) continue;
      const documentId = metadata.documentId;
      if (typeof documentId !== "string" || documentId.length === 0) continue;
      if (
        typeof match.similarity !== "number" ||
        !Number.isFinite(match.similarity)
      ) {
        continue;
      }

      const existing = grouped.get(documentId);
      const position =
        typeof metadata.position === "number" &&
        Number.isFinite(metadata.position)
          ? Math.trunc(metadata.position)
          : undefined;
      const topicMatch: ScratchpadTopicMatchDto = {
        fragmentId: match.id,
        text: match.content.text ?? "",
        score: match.similarity,
        ...(position === undefined ? {} : { position }),
      };

      if (existing) {
        existing.score = Math.max(existing.score, match.similarity);
        existing.matches.push(topicMatch);
      } else {
        grouped.set(documentId, {
          score: match.similarity,
          matches: [topicMatch],
        });
      }
    }

    const results: ScratchpadSearchResponse["results"] = [];
    for (const [topicId, result] of grouped) {
      let topic: ScratchpadTopicDto;
      try {
        topic = await this.readTopic(topicId);
      } catch (err) {
        if (err instanceof ScratchpadTopicError && err.status === 404) {
          continue;
        }
        throw err;
      }
      result.matches.sort((a, b) => {
        const posA = a.position;
        const posB = b.position;
        if (posA !== undefined && posB !== undefined) return posA - posB;
        if (posA !== undefined) return -1;
        if (posB !== undefined) return 1;
        return b.score - a.score;
      });
      results.push({
        topic,
        score: result.score,
        matches: result.matches,
      });
    }

    results.sort((a, b) => b.score - a.score);

    return {
      query: params.q,
      results: results.slice(0, limit),
      count: Math.min(results.length, limit),
      limit,
    };
  }

  previewSummary(text: string): ScratchpadSummaryPreviewResponse {
    this.assertTokenLimit(text);
    return {
      summary: buildScratchpadSummary(text),
      tokenCount: estimateScratchpadTokenCount(text),
    };
  }

  private assertTokenLimit(text: string): void {
    const tokenCount = estimateScratchpadTokenCount(text);
    if (tokenCount > SCRATCHPAD_TOPIC_TOKEN_LIMIT) {
      throw new ScratchpadTopicError(
        400,
        `Scratchpad topic exceeds ${SCRATCHPAD_TOPIC_TOKEN_LIMIT} approximate tokens`,
      );
    }
  }

  private async listTopicDocuments(): Promise<Memory[]> {
    const documents: Memory[] = [];
    let offset = 0;

    while (true) {
      const batch = await this.knowledgeService.getMemories({
        tableName: "documents",
        count: SCRATCHPAD_DOCUMENT_BATCH_SIZE,
        offset,
      });

      for (const memory of batch) {
        if (this.isOwnedTopicDocument(memory)) {
          documents.push(memory);
        }
      }

      if (batch.length < SCRATCHPAD_DOCUMENT_BATCH_SIZE) {
        break;
      }
      offset += SCRATCHPAD_DOCUMENT_BATCH_SIZE;
    }

    return documents;
  }

  private async getOwnedTopicDocument(topicId: UUID): Promise<Memory> {
    const document = await this.runtime.getMemoryById(topicId);
    if (!document || !this.isOwnedTopicDocument(document)) {
      throw new ScratchpadTopicError(404, "Scratchpad topic not found");
    }
    return document;
  }

  private isOwnedTopicDocument(memory: Memory): boolean {
    const metadata = asRecord(memory.metadata);
    return (
      typeof memory.id === "string" &&
      memory.agentId === this.agentId &&
      memory.roomId === this.agentId &&
      memory.worldId === this.agentId &&
      memory.entityId === this.agentId &&
      isScratchpadMetadata(metadata) &&
      metadata.type === MemoryType.DOCUMENT
    );
  }

  private async toTopicDto(memory: Memory): Promise<ScratchpadTopicDto> {
    const metadata = asRecord(memory.metadata);
    if (!isScratchpadMetadata(metadata)) {
      throw new ScratchpadTopicError(
        500,
        "Scratchpad topic metadata is invalid",
      );
    }
    if (typeof memory.id !== "string" || memory.id.length === 0) {
      throw new ScratchpadTopicError(500, "Scratchpad topic is missing id");
    }
    const text = readString(memory.content?.text, "text");

    return {
      id: memory.id,
      title: readString(metadata.title, "title"),
      text,
      tokenCount: estimateScratchpadTokenCount(text),
      summary: readString(metadata.summary, "summary"),
      createdAt: readNumber(
        metadata.scratchpadCreatedAt,
        "scratchpadCreatedAt",
      ),
      updatedAt: readNumber(
        metadata.scratchpadUpdatedAt,
        "scratchpadUpdatedAt",
      ),
      fragmentCount: await this.countFragments(memory.id),
    };
  }

  private async countFragments(topicId: UUID): Promise<number> {
    let offset = 0;
    let count = 0;

    while (true) {
      const batch = await this.knowledgeService.getMemories({
        tableName: "knowledge",
        roomId: this.agentId,
        count: SCRATCHPAD_FRAGMENT_BATCH_SIZE,
        offset,
      });

      for (const memory of batch) {
        const metadata = asRecord(memory.metadata);
        if (
          isScratchpadMetadata(metadata) &&
          metadata.documentId === topicId &&
          memory.agentId === this.agentId &&
          memory.roomId === this.agentId
        ) {
          count += 1;
        }
      }

      if (batch.length < SCRATCHPAD_FRAGMENT_BATCH_SIZE) {
        break;
      }
      offset += SCRATCHPAD_FRAGMENT_BATCH_SIZE;
    }

    return count;
  }

  private async listFragmentIds(topicId: UUID): Promise<UUID[]> {
    let offset = 0;
    const fragmentIds: UUID[] = [];

    while (true) {
      const batch = await this.knowledgeService.getMemories({
        tableName: "knowledge",
        roomId: this.agentId,
        count: SCRATCHPAD_FRAGMENT_BATCH_SIZE,
        offset,
      });

      for (const memory of batch) {
        const metadata = asRecord(memory.metadata);
        if (
          typeof memory.id === "string" &&
          isScratchpadMetadata(metadata) &&
          metadata.documentId === topicId &&
          memory.agentId === this.agentId &&
          memory.roomId === this.agentId
        ) {
          fragmentIds.push(memory.id);
        }
      }

      if (batch.length < SCRATCHPAD_FRAGMENT_BATCH_SIZE) {
        break;
      }
      offset += SCRATCHPAD_FRAGMENT_BATCH_SIZE;
    }

    return fragmentIds;
  }
}

export async function handleScratchpadTopicRoutes(
  ctx: ScratchpadTopicRouteContext,
  scratchpad: ScratchpadTopicService,
): Promise<boolean> {
  const { req, res, method, pathname, url, json, error, readJsonBody } = ctx;

  if (!pathname.startsWith("/api/knowledge/scratchpad")) return false;

  try {
    if (method === "GET" && pathname === "/api/knowledge/scratchpad/topics") {
      const topics = await scratchpad.listTopics();
      const response: ScratchpadTopicsListResponse = {
        topics,
        count: topics.length,
        maxTopics: SCRATCHPAD_MAX_TOPICS,
        maxTokensPerTopic: SCRATCHPAD_TOPIC_TOKEN_LIMIT,
      };
      json(res, response);
      return true;
    }

    if (method === "POST" && pathname === "/api/knowledge/scratchpad/topics") {
      const body = await readJsonBody<Record<string, unknown>>(req, res);
      if (!body) return true;
      const parsed = scratchpadCreateTopicRequestSchema.safeParse(body);
      if (!parsed.success) {
        error(res, formatSchemaError(parsed.error.issues), 400);
        return true;
      }
      const topic = await scratchpad.createTopic(parsed.data);
      const response: ScratchpadTopicResponse = { topic };
      json(res, response, 201);
      return true;
    }

    if (method === "GET" && pathname === "/api/knowledge/scratchpad/search") {
      const parsed = scratchpadSearchQuerySchema.safeParse({
        q: url.searchParams.get("q") ?? "",
        limit: url.searchParams.get("limit") ?? undefined,
      });
      if (!parsed.success) {
        error(res, formatSchemaError(parsed.error.issues), 400);
        return true;
      }
      json(res, await scratchpad.searchTopics(parsed.data));
      return true;
    }

    if (
      method === "POST" &&
      pathname === "/api/knowledge/scratchpad/summary-preview"
    ) {
      const body = await readJsonBody<Record<string, unknown>>(req, res);
      if (!body) return true;
      const parsed = scratchpadSummaryPreviewRequestSchema.safeParse(body);
      if (!parsed.success) {
        error(res, formatSchemaError(parsed.error.issues), 400);
        return true;
      }
      json(res, scratchpad.previewSummary(parsed.data.text));
      return true;
    }

    const topicMatch = /^\/api\/knowledge\/scratchpad\/topics\/([^/]+)$/.exec(
      pathname,
    );
    if (topicMatch && method === "GET") {
      const topic = await scratchpad.readTopic(parseTopicId(topicMatch[1]));
      const response: ScratchpadTopicResponse = { topic };
      json(res, response);
      return true;
    }

    if (topicMatch && method === "PUT") {
      const body = await readJsonBody<Record<string, unknown>>(req, res);
      if (!body) return true;
      const parsed = scratchpadReplaceTopicRequestSchema.safeParse(body);
      if (!parsed.success) {
        error(res, formatSchemaError(parsed.error.issues), 400);
        return true;
      }
      const topic = await scratchpad.replaceTopic(
        parseTopicId(topicMatch[1]),
        parsed.data,
      );
      const response: ScratchpadTopicResponse = { topic };
      json(res, response);
      return true;
    }

    if (topicMatch && method === "DELETE") {
      json(res, await scratchpad.deleteTopic(parseTopicId(topicMatch[1])));
      return true;
    }
  } catch (err) {
    if (err instanceof ScratchpadTopicError) {
      error(res, err.message, err.status);
      return true;
    }
    throw err;
  }

  return false;
}
