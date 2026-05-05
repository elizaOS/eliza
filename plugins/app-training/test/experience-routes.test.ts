import type http from "node:http";
import type { AgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleExperienceRoutes } from "../src/routes/experience-routes.js";

interface RecordedResponse {
  status: number;
  body: unknown;
}

interface TestExperience {
  id: UUID;
  agentId: UUID;
  type: string;
  outcome: string;
  context: string;
  action: string;
  result: string;
  learning: string;
  domain: string;
  tags: string[];
  keywords: string[];
  associatedEntityIds: string[];
  confidence: number;
  importance: number;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number;
  embedding: number[];
}

interface TestExperienceService {
  recordExperience(
    experienceData: Partial<TestExperience>,
  ): Promise<TestExperience>;
  listExperiences(query?: Record<string, unknown>): Promise<TestExperience[]>;
  getExperience(id: UUID): Promise<TestExperience | null>;
  updateExperience(
    id: UUID,
    updates: Partial<TestExperience>,
  ): Promise<TestExperience | null>;
  deleteExperience(id: UUID): Promise<boolean>;
  getExperienceGraph(query?: Record<string, unknown>): Promise<unknown>;
  consolidateDuplicateExperiences(options?: {
    deleteDuplicates?: boolean;
    limit?: number;
  }): Promise<unknown>;
}

function makeExperience(id: string): TestExperience {
  return {
    id: id as UUID,
    agentId: "agent-001" as UUID,
    type: "learning",
    outcome: "neutral",
    context: "Context",
    action: "Action",
    result: "Result",
    learning: "Learning",
    domain: "general",
    tags: ["memory"],
    keywords: ["memory"],
    associatedEntityIds: [],
    confidence: 0.7,
    importance: 0.8,
    createdAt: 1_710_000_000_000,
    updatedAt: 1_710_000_000_000,
    accessCount: 2,
    lastAccessedAt: 1_710_000_100_000,
    embedding: [0.1, 0.2, 0.3],
  };
}

function makeExperienceService(
  overrides: Partial<TestExperienceService>,
): TestExperienceService {
  return {
    recordExperience: async () => makeExperience("exp-created"),
    listExperiences: async () => [],
    getExperience: async () => null,
    updateExperience: async () => null,
    deleteExperience: async () => false,
    getExperienceGraph: async () => ({ nodes: [], links: [] }),
    consolidateDuplicateExperiences: async () => ({ merged: 0, deleted: 0 }),
    ...overrides,
  };
}

function makeContext(options: {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  service?: Partial<TestExperienceService> | null;
}): {
  recorded: RecordedResponse;
  ctx: Parameters<typeof handleExperienceRoutes>[0];
} {
  const recorded: RecordedResponse = { status: 200, body: undefined };
  const req = {
    method: options.method,
    url: options.path,
  } as unknown as http.IncomingMessage;
  const res = {
    statusCode: 200,
  } as unknown as http.ServerResponse;
  const service =
    options.service === undefined || options.service === null
      ? null
      : makeExperienceService(options.service);
  const runtime = options.service
    ? ({
        getService: vi.fn((serviceName: string) =>
          serviceName === "EXPERIENCE" ? service : null,
        ),
      } as unknown as AgentRuntime)
    : null;

  return {
    recorded,
    ctx: {
      req,
      res,
      method: options.method,
      pathname: options.path.split("?")[0] ?? options.path,
      runtime,
      url: new URL(`http://localhost${options.path}`),
      json: (_res: http.ServerResponse, data: unknown, status?: number) => {
        recorded.status = status ?? 200;
        recorded.body = data;
      },
      error: (_res: http.ServerResponse, message: string, status?: number) => {
        recorded.status = status ?? 500;
        recorded.body = { error: message };
      },
      readJsonBody: async <T extends object>(): Promise<T | null> =>
        (options.body as T | undefined) ?? null,
    },
  };
}

describe("handleExperienceRoutes", () => {
  it("lists experiences through /api/experiences with parsed query filters", async () => {
    const listExperiences = vi.fn(async () => [makeExperience("exp-001")]);
    const { ctx, recorded } = makeContext({
      method: "GET",
      path: "/api/experiences?type=learning&tag=memory&limit=5&includeRelated=true",
      service: {
        listExperiences,
      },
    });

    const handled = await handleExperienceRoutes(ctx);
    expect(handled).toBe(true);
    expect(listExperiences).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "learning",
        tags: ["memory"],
        limit: 5,
        includeRelated: true,
      }),
    );
    expect(recorded.status).toBe(200);
    expect(recorded.body).toMatchObject({
      data: [
        expect.objectContaining({
          id: "exp-001",
          learning: "Learning",
          keywords: ["memory"],
          associatedEntityIds: [],
          embeddingDimensions: 3,
        }),
      ],
      total: 1,
    });
    expect(
      (recorded.body as { data: Array<Record<string, unknown>> }).data[0],
    ).not.toHaveProperty("embedding");
  });

  it("creates, updates, and deletes experiences through the character hub alias", async () => {
    const created = makeExperience("exp-002");
    const updated = {
      ...created,
      learning: "Updated learning",
      domain: "shell",
    };

    const recordExperience = vi.fn(async () => created);
    const updateExperience = vi.fn(async () => updated);
    const deleteExperience = vi.fn(async () => true);

    const create = makeContext({
      method: "POST",
      path: "/api/character/experiences",
      body: {
        learning: "Learning",
        confidence: 0,
        importance: 0,
      },
      service: {
        recordExperience,
      },
    });
    await handleExperienceRoutes(create.ctx);
    expect(recordExperience).toHaveBeenCalledWith(
      expect.objectContaining({
        learning: "Learning",
        confidence: 0,
        importance: 0,
      }),
    );
    expect(create.recorded.status).toBe(201);

    const update = makeContext({
      method: "PATCH",
      path: "/api/character/experiences/exp-002",
      body: {
        learning: "Updated learning",
        domain: "shell",
        previousBelief: null,
      },
      service: {
        updateExperience,
      },
    });
    await handleExperienceRoutes(update.ctx);
    expect(updateExperience).toHaveBeenCalledWith(
      "exp-002",
      expect.objectContaining({
        learning: "Updated learning",
        domain: "shell",
        previousBelief: undefined,
      }),
    );
    expect(update.recorded.status).toBe(200);
    expect(update.recorded.body).toMatchObject({
      data: expect.objectContaining({
        id: "exp-002",
        learning: "Updated learning",
        domain: "shell",
      }),
    });

    const remove = makeContext({
      method: "DELETE",
      path: "/api/character/experiences/exp-002",
      service: {
        deleteExperience,
      },
    });
    await handleExperienceRoutes(remove.ctx);
    expect(deleteExperience).toHaveBeenCalledWith("exp-002");
    expect(remove.recorded.status).toBe(200);
    expect(remove.recorded.body).toMatchObject({
      ok: true,
      id: "exp-002",
    });
  });

  it("returns graph snapshots and runs explicit maintenance", async () => {
    const getExperienceGraph = vi.fn(async () => ({
      generatedAt: 1,
      totalExperiences: 1,
      nodes: [
        {
          id: "exp-001",
          label: "Learning",
          type: "learning",
          outcome: "neutral",
          domain: "general",
          keywords: ["memory"],
          associatedEntityIds: [],
          confidence: 0.7,
          importance: 0.8,
          timeWeight: 1,
          x: 0.5,
          y: 0.5,
        },
      ],
      links: [],
    }));
    const consolidateDuplicateExperiences = vi.fn(async () => ({
      inspected: 4,
      groups: [
        {
          primaryId: "exp-001",
          duplicateIds: ["exp-002"],
          mergedKeywords: ["memory"],
          reason: "duplicate learning text",
        },
      ],
      merged: 1,
      deleted: 0,
    }));

    const graph = makeContext({
      method: "GET",
      path: "/api/character/experiences/graph?q=wallet&limit=20",
      service: {
        getExperienceGraph,
      },
    });
    await handleExperienceRoutes(graph.ctx);
    expect(getExperienceGraph).toHaveBeenCalledWith(
      expect.objectContaining({ query: "wallet", limit: 20 }),
    );
    expect(graph.recorded.body).toMatchObject({
      data: expect.objectContaining({
        nodes: [expect.objectContaining({ id: "exp-001" })],
      }),
    });

    const maintenance = makeContext({
      method: "POST",
      path: "/api/character/experiences/maintenance",
      body: { deleteDuplicates: false, limit: 4 },
      service: {
        consolidateDuplicateExperiences,
      },
    });
    await handleExperienceRoutes(maintenance.ctx);
    expect(consolidateDuplicateExperiences).toHaveBeenCalledWith({
      deleteDuplicates: false,
      limit: 4,
    });
    expect(maintenance.recorded.body).toMatchObject({
      data: expect.objectContaining({ merged: 1, deleted: 0 }),
    });
  });
});
