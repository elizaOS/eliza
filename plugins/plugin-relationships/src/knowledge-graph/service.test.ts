/**
 * Tests for KnowledgeGraphService — runtime-owned entity/relationship graph.
 */
import { describe, expect, it, vi } from "vitest";
import { EntityStore } from "./entity-store.ts";
import { RelationshipStore } from "./relationship-store.ts";
import {
  KNOWLEDGE_GRAPH_SERVICE,
  KnowledgeGraphService,
  resolveKnowledgeGraphService,
} from "./service.ts";

describe("knowledge-graph/service", () => {
  it("exports KNOWLEDGE_GRAPH_SERVICE constant", () => {
    expect(KNOWLEDGE_GRAPH_SERVICE).toBe("eliza_knowledge_graph");
    expect(KnowledgeGraphService.serviceType).toBe(KNOWLEDGE_GRAPH_SERVICE);
  });

  it("has capabilityDescription", () => {
    const runtime = {
      agentId: "agent-1",
    } as unknown as import("@elizaos/core").IAgentRuntime;
    const svc = new KnowledgeGraphService(runtime);
    expect(svc.capabilityDescription).toContain("knowledge graph");
  });

  it("KnowledgeGraphService.start returns instance", async () => {
    const runtime = {
      agentId: "agent-1",
    } as unknown as import("@elizaos/core").IAgentRuntime;
    const svc = await KnowledgeGraphService.start(runtime);
    expect(svc).toBeInstanceOf(KnowledgeGraphService);
  });

  it("getEntityStore returns EntityStore with default agentId", () => {
    const runtime = {
      agentId: "agent-123",
    } as unknown as import("@elizaos/core").IAgentRuntime;
    const svc = new KnowledgeGraphService(runtime);
    const store = svc.getEntityStore();
    expect(store).toBeInstanceOf(EntityStore);
  });

  it("getEntityStore respects explicit agentId", () => {
    const runtime = {
      agentId: "agent-123",
    } as unknown as import("@elizaos/core").IAgentRuntime;
    const svc = new KnowledgeGraphService(runtime);
    const store = svc.getEntityStore("other-agent");
    expect(store).toBeInstanceOf(EntityStore);
  });

  it("getRelationshipStore returns RelationshipStore", () => {
    const runtime = {
      agentId: "agent-123",
    } as unknown as import("@elizaos/core").IAgentRuntime;
    const svc = new KnowledgeGraphService(runtime);
    const store = svc.getRelationshipStore();
    expect(store).toBeInstanceOf(RelationshipStore);
  });

  it("resolveKnowledgeGraphService returns null when not registered", () => {
    const runtime = {
      getService: vi.fn().mockReturnValue(null),
    } as unknown as import("@elizaos/core").IAgentRuntime;
    expect(resolveKnowledgeGraphService(runtime)).toBeNull();
    expect(runtime.getService).toHaveBeenCalledWith(KNOWLEDGE_GRAPH_SERVICE);
  });

  it("resolveKnowledgeGraphService returns service when registered", () => {
    const fakeService = {} as KnowledgeGraphService;
    const runtime = {
      getService: vi.fn().mockReturnValue(fakeService),
    } as unknown as import("@elizaos/core").IAgentRuntime;
    expect(resolveKnowledgeGraphService(runtime)).toBe(fakeService);
  });
});
