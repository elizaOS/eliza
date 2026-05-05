import type http from "node:http";
import {
  type AgentRuntime,
  type Memory,
  MemoryType,
  type UUID,
} from "@elizaos/core";
import {
  SCRATCHPAD_MAX_TOPICS,
  SCRATCHPAD_TOPIC_TOKEN_LIMIT,
} from "@elizaos/shared/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  handleScratchpadTopicRoutes,
  type ScratchpadTopicError,
  ScratchpadTopicService,
} from "../src/scratchpad-topics";
import type { KnowledgeServiceLike } from "../src/service-loader";

const AGENT_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const OTHER_AGENT_ID = "00000000-0000-4000-8000-000000000002" as UUID;

function uuid(index: number): UUID {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` as UUID;
}

class ScratchpadKnowledgeHarness implements KnowledgeServiceLike {
  private nextId = 10;
  readonly documents = new Map<UUID, Memory>();
  readonly fragments = new Map<UUID, Memory>();

  readonly runtime = {
    agentId: AGENT_ID,
    getMemoryById: async (id: UUID) =>
      this.documents.get(id) ?? this.fragments.get(id) ?? null,
    updateMemory: async (memory: Memory) => {
      const existing = this.documents.get(memory.id as UUID);
      if (!existing) throw new Error(`missing memory ${memory.id}`);
      this.documents.set(memory.id as UUID, {
        ...existing,
        ...memory,
        content: memory.content ?? existing.content,
        metadata: memory.metadata ?? existing.metadata,
        createdAt: memory.createdAt ?? existing.createdAt,
      });
    },
  } as unknown as AgentRuntime;

  async addKnowledge(
    options: Parameters<KnowledgeServiceLike["addKnowledge"]>[0],
  ) {
    const id = uuid(this.nextId++);
    const now = Date.now();
    const document: Memory = {
      id,
      agentId: options.agentId ?? AGENT_ID,
      roomId: options.roomId,
      worldId: options.worldId,
      entityId: options.entityId,
      content: { text: options.content },
      metadata: {
        ...options.metadata,
        type: MemoryType.DOCUMENT,
        documentId: id,
      },
      createdAt: now,
    };
    this.documents.set(id, document);
    const fragmentCount = this.regenerateFragments(document);
    return {
      clientDocumentId: id,
      storedDocumentMemoryId: id,
      fragmentCount,
    };
  }

  async getKnowledge(message: Memory) {
    const query = message.content.text?.toLowerCase() ?? "";
    return Array.from(this.fragments.values())
      .filter((fragment) => {
        const text = fragment.content.text?.toLowerCase() ?? "";
        const metadata = fragment.metadata as Record<string, unknown>;
        const title =
          typeof metadata.title === "string"
            ? metadata.title.toLowerCase()
            : "";
        return text.includes(query) || title.includes(query);
      })
      .map((fragment, index) => ({
        id: fragment.id as UUID,
        content: { text: fragment.content.text },
        similarity: 0.95 - index * 0.01,
        metadata: fragment.metadata as Record<string, unknown>,
      }));
  }

  async getMemories(params: {
    tableName: string;
    roomId?: UUID;
    count?: number;
    offset?: number;
  }) {
    const source =
      params.tableName === "documents"
        ? Array.from(this.documents.values())
        : Array.from(this.fragments.values());
    const filtered = params.roomId
      ? source.filter((memory) => memory.roomId === params.roomId)
      : source;
    const offset = params.offset ?? 0;
    const count = params.count ?? filtered.length;
    return filtered.slice(offset, offset + count);
  }

  async countMemories(params: { tableName: string; roomId?: UUID }) {
    return (
      await this.getMemories({
        tableName: params.tableName,
        roomId: params.roomId,
      })
    ).length;
  }

  async updateKnowledgeDocument(options: {
    documentId: UUID;
    content: string;
  }) {
    const existing = this.documents.get(options.documentId);
    if (!existing) throw new Error(`missing document ${options.documentId}`);
    this.documents.set(options.documentId, {
      ...existing,
      content: { text: options.content },
      metadata: {
        ...(existing.metadata as Record<string, unknown>),
        type: MemoryType.DOCUMENT,
        documentId: options.documentId,
      },
    });
    for (const fragment of Array.from(this.fragments.values())) {
      const metadata = fragment.metadata as Record<string, unknown>;
      if (metadata.documentId === options.documentId) {
        this.fragments.delete(fragment.id as UUID);
      }
    }
    const fragmentCount = this.regenerateFragments(
      this.documents.get(options.documentId) as Memory,
    );
    return {
      documentId: options.documentId,
      fragmentCount,
    };
  }

  async deleteMemory(memoryId: UUID) {
    this.documents.delete(memoryId);
    this.fragments.delete(memoryId);
  }

  fragmentIdsFor(documentId: UUID): UUID[] {
    return Array.from(this.fragments.values())
      .filter((fragment) => {
        const metadata = fragment.metadata as Record<string, unknown>;
        return metadata.documentId === documentId;
      })
      .map((fragment) => fragment.id as UUID);
  }

  addForeignScratchpadTopic() {
    const id = uuid(900);
    const now = Date.now();
    const document: Memory = {
      id,
      agentId: OTHER_AGENT_ID,
      roomId: OTHER_AGENT_ID,
      worldId: OTHER_AGENT_ID,
      entityId: OTHER_AGENT_ID,
      content: { text: "alpha belongs to another owner" },
      metadata: {
        source: "scratchpad",
        scratchpadKind: "topic",
        scratchpadVersion: 1,
        type: MemoryType.DOCUMENT,
        documentId: id,
        title: "Foreign alpha",
        summary: "Foreign alpha",
        scratchpadCreatedAt: now,
        scratchpadUpdatedAt: now,
        filename: "Foreign alpha",
        originalFilename: "foreign-alpha.md",
        contentType: "text/markdown",
        fileType: "text/markdown",
        textBacked: true,
      },
      createdAt: now,
    };
    this.documents.set(id, document);
    this.regenerateFragments(document);
    return id;
  }

  private regenerateFragments(document: Memory): number {
    const text = document.content.text ?? "";
    const chunks = text.match(/[\s\S]{1,40}/g) ?? [];
    for (const [index, chunk] of chunks.entries()) {
      const fragmentId = uuid(this.nextId++);
      this.fragments.set(fragmentId, {
        id: fragmentId,
        agentId: document.agentId,
        roomId: document.roomId,
        worldId: document.worldId,
        entityId: document.entityId,
        content: { text: chunk },
        metadata: {
          ...(document.metadata as Record<string, unknown>),
          type: MemoryType.FRAGMENT,
          documentId: document.id,
          position: index,
        },
        createdAt: Date.now(),
      });
    }
    return chunks.length;
  }
}

function createService() {
  const harness = new ScratchpadKnowledgeHarness();
  return {
    harness,
    service: new ScratchpadTopicService(harness.runtime, harness),
  };
}

function overLimitText(): string {
  return "x".repeat(SCRATCHPAD_TOPIC_TOKEN_LIMIT * 4 + 1);
}

async function expectScratchpadError(
  promise: Promise<unknown>,
  status: number,
) {
  await expect(promise).rejects.toMatchObject({
    name: "ScratchpadTopicError",
    status,
  } satisfies Partial<ScratchpadTopicError>);
}

describe("ScratchpadTopicService", () => {
  it("enforces topic count and token caps before writing knowledge", async () => {
    const { service } = createService();

    for (let index = 0; index < SCRATCHPAD_MAX_TOPICS; index += 1) {
      await service.createTopic({
        title: `Topic ${index + 1}`,
        text: `topic body ${index + 1}`,
      });
    }

    await expectScratchpadError(
      service.createTopic({ title: "Overflow", text: "one too many" }),
      409,
    );

    const oversized = overLimitText();
    await expectScratchpadError(
      createService().service.createTopic({
        title: "Oversized",
        text: oversized,
      }),
      400,
    );
    expect(() => createService().service.previewSummary(oversized)).toThrow(
      `Scratchpad topic exceeds ${SCRATCHPAD_TOPIC_TOKEN_LIMIT} approximate tokens`,
    );
  });

  it("replaces topics in place and regenerates fragments", async () => {
    const { harness, service } = createService();

    const created = await service.createTopic({
      title: "Launch notes",
      text: "alpha ".repeat(25),
    });
    const originalFragments = harness.fragmentIdsFor(created.id);

    const replaced = await service.replaceTopic(created.id, {
      title: "Launch checklist",
      text: "beta ".repeat(45),
    });

    expect(replaced.id).toBe(created.id);
    expect(replaced.title).toBe("Launch checklist");
    expect(replaced.text).toContain("beta");
    expect(replaced.fragmentCount).toBeGreaterThan(0);
    expect(harness.fragmentIdsFor(created.id)).not.toEqual(originalFragments);
    for (const fragmentId of originalFragments) {
      expect(harness.fragments.has(fragmentId)).toBe(false);
    }
  });

  it("deletes topic documents and their generated fragments", async () => {
    const { harness, service } = createService();
    const created = await service.createTopic({
      title: "Delete me",
      text: "remove ".repeat(20),
    });
    const fragmentCount = harness.fragmentIdsFor(created.id).length;

    const deleted = await service.deleteTopic(created.id);

    expect(deleted).toEqual({
      ok: true,
      topicId: created.id,
      deletedFragments: fragmentCount,
    });
    expect(harness.documents.has(created.id)).toBe(false);
    expect(harness.fragmentIdsFor(created.id)).toEqual([]);
    await expectScratchpadError(service.readTopic(created.id), 404);
  });

  it("scopes list, read, and search to the owning agent topic set", async () => {
    const { service, harness } = createService();
    const own = await service.createTopic({
      title: "Alpha project",
      text: "alpha launch sequence",
    });
    const foreignId = harness.addForeignScratchpadTopic();

    await expectScratchpadError(service.readTopic(foreignId), 404);
    expect((await service.listTopics()).map((topic) => topic.id)).toEqual([
      own.id,
    ]);

    const results = await service.searchTopics({ q: "alpha" });
    expect(results.count).toBe(1);
    expect(results.results[0].topic.id).toBe(own.id);
    expect(results.results[0].matches.length).toBeGreaterThan(0);
  });

  it("validates route payloads against shared scratchpad limits", async () => {
    const { service } = createService();
    const json = vi.fn();
    const error = vi.fn();
    const res = {} as http.ServerResponse;

    await expect(
      handleScratchpadTopicRoutes(
        {
          req: {} as http.IncomingMessage,
          res,
          method: "POST",
          pathname: "/api/knowledge/scratchpad/topics",
          url: new URL("http://127.0.0.1/api/knowledge/scratchpad/topics"),
          json,
          error,
          readJsonBody: async <T extends object>() =>
            ({ title: "Too long", text: overLimitText() }) as T,
        },
        service,
      ),
    ).resolves.toBe(true);

    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      res,
      `text: text exceeds ${SCRATCHPAD_TOPIC_TOKEN_LIMIT} approximate tokens`,
      400,
    );
  });
});
