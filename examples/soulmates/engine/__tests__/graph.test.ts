import { describe, expect, it } from "vitest";
import {
  addGraphEdge,
  buildAdjacency,
  expandGraphCandidates,
  normalizeGraphWeights,
} from "../graph";
import type { MatchGraph } from "../types";

describe("buildAdjacency", () => {
  it("should build bidirectional adjacency from edges", () => {
    const graph: MatchGraph = {
      edges: [
        {
          from: 0,
          to: 1,
          weight: 0.8,
          type: "match",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
        {
          from: 1,
          to: 2,
          weight: 0.6,
          type: "feedback_positive",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
      ],
    };
    const adjacency = buildAdjacency(graph);
    expect(adjacency["0"]).toBeDefined();
    expect(adjacency["1"]).toBeDefined();
    expect(adjacency["2"]).toBeDefined();
    expect(adjacency["0"].length).toBe(1);
    expect(adjacency["1"].length).toBe(2);
    expect(adjacency["2"].length).toBe(1);
  });

  it("should handle empty graph", () => {
    const graph: MatchGraph = { edges: [] };
    const adjacency = buildAdjacency(graph);
    expect(Object.keys(adjacency).length).toBe(0);
  });

  it("should create reverse edges", () => {
    const graph: MatchGraph = {
      edges: [
        {
          from: 0,
          to: 1,
          weight: 0.8,
          type: "match",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
      ],
    };
    const adjacency = buildAdjacency(graph);
    const reverseEdge = adjacency["1"].find((e) => e.to === 0);
    expect(reverseEdge).toBeDefined();
    expect(reverseEdge?.from).toBe(1);
    expect(reverseEdge?.to).toBe(0);
  });
});

describe("expandGraphCandidates", () => {
  it("should expand to direct neighbors (1 hop)", () => {
    const graph: MatchGraph = {
      edges: [
        {
          from: 0,
          to: 1,
          weight: 0.8,
          type: "match",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
        {
          from: 0,
          to: 2,
          weight: 0.6,
          type: "match",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
        {
          from: 1,
          to: 3,
          weight: 0.5,
          type: "match",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
      ],
    };
    const adjacency = buildAdjacency(graph);
    const candidates = expandGraphCandidates(0, adjacency, 1, 10);
    expect(candidates).toContain(1);
    expect(candidates).toContain(2);
    expect(candidates).not.toContain(3);
  });

  it("should expand to second-degree neighbors (2 hops)", () => {
    const graph: MatchGraph = {
      edges: [
        {
          from: 0,
          to: 1,
          weight: 0.8,
          type: "match",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
        {
          from: 1,
          to: 2,
          weight: 0.6,
          type: "match",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
      ],
    };
    const adjacency = buildAdjacency(graph);
    const candidates = expandGraphCandidates(0, adjacency, 2, 10);
    expect(candidates).toContain(1);
    expect(candidates).toContain(2);
  });

  it("should not include source persona in results", () => {
    const graph: MatchGraph = {
      edges: [
        {
          from: 0,
          to: 1,
          weight: 0.8,
          type: "match",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
      ],
    };
    const adjacency = buildAdjacency(graph);
    const candidates = expandGraphCandidates(0, adjacency, 2, 10);
    expect(candidates).not.toContain(0);
  });

  it("should return empty array for 0 hops", () => {
    const graph: MatchGraph = {
      edges: [
        {
          from: 0,
          to: 1,
          weight: 0.8,
          type: "match",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
      ],
    };
    const adjacency = buildAdjacency(graph);
    const candidates = expandGraphCandidates(0, adjacency, 0, 10);
    expect(candidates.length).toBe(0);
  });

  it("should respect maxCandidates limit", () => {
    const graph: MatchGraph = {
      edges: [
        {
          from: 0,
          to: 1,
          weight: 0.8,
          type: "match",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
        {
          from: 0,
          to: 2,
          weight: 0.7,
          type: "match",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
        {
          from: 0,
          to: 3,
          weight: 0.6,
          type: "match",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
        {
          from: 0,
          to: 4,
          weight: 0.5,
          type: "match",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
      ],
    };
    const adjacency = buildAdjacency(graph);
    const candidates = expandGraphCandidates(0, adjacency, 1, 2);
    expect(candidates.length).toBeLessThanOrEqual(2);
  });

  it("should weight edges by type", () => {
    const graph: MatchGraph = {
      edges: [
        {
          from: 0,
          to: 1,
          weight: 0.5,
          type: "feedback_positive",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
        {
          from: 0,
          to: 2,
          weight: 0.5,
          type: "feedback_negative",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
      ],
    };
    const adjacency = buildAdjacency(graph);
    const candidates = expandGraphCandidates(0, adjacency, 1, 10);
    expect(candidates[0]).toBe(1);
  });

  it("should decay weight by hop distance", () => {
    const graph: MatchGraph = {
      edges: [
        {
          from: 0,
          to: 1,
          weight: 1,
          type: "match",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
        {
          from: 1,
          to: 2,
          weight: 1,
          type: "match",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
        {
          from: 0,
          to: 3,
          weight: 0.5,
          type: "match",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
      ],
    };
    const adjacency = buildAdjacency(graph);
    const candidates = expandGraphCandidates(0, adjacency, 2, 10);
    expect(candidates.indexOf(1)).toBeLessThan(candidates.indexOf(2));
  });
});

describe("addGraphEdge", () => {
  it("should add edge to graph", () => {
    const graph: MatchGraph = { edges: [] };
    addGraphEdge(graph, {
      from: 0,
      to: 1,
      weight: 0.8,
      type: "match",
      createdAt: "2026-01-18T12:00:00.000Z",
    });
    expect(graph.edges.length).toBe(1);
    expect(graph.edges[0].from).toBe(0);
    expect(graph.edges[0].to).toBe(1);
  });

  it("should trim old edges when exceeding maxEdges", () => {
    const graph: MatchGraph = { edges: [] };
    for (let i = 0; i < 6; i++) {
      addGraphEdge(
        graph,
        {
          from: 0,
          to: i,
          weight: 0.5,
          type: "match",
          createdAt: `2026-01-18T12:00:0${i}.000Z`,
        },
        5,
      );
    }
    expect(graph.edges.length).toBe(5);
    expect(graph.edges[0].createdAt).toBe("2026-01-18T12:00:01.000Z");
  });
});

describe("normalizeGraphWeights", () => {
  it("should normalize weights to [0, 1] range", () => {
    const graph: MatchGraph = {
      edges: [
        {
          from: 0,
          to: 1,
          weight: 5,
          type: "match",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
        {
          from: 1,
          to: 2,
          weight: 10,
          type: "match",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
        {
          from: 2,
          to: 3,
          weight: 2,
          type: "match",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
      ],
    };
    normalizeGraphWeights(graph);
    const max = Math.max(...graph.edges.map((e) => e.weight));
    expect(max).toBe(1);
    for (const edge of graph.edges) {
      expect(edge.weight).toBeGreaterThanOrEqual(0);
      expect(edge.weight).toBeLessThanOrEqual(1);
    }
  });

  it("should handle empty graph", () => {
    const graph: MatchGraph = { edges: [] };
    normalizeGraphWeights(graph);
    expect(graph.edges.length).toBe(0);
  });

  it("should handle graph with zero weights", () => {
    const graph: MatchGraph = {
      edges: [
        {
          from: 0,
          to: 1,
          weight: 0,
          type: "match",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
        {
          from: 1,
          to: 2,
          weight: 0,
          type: "match",
          createdAt: "2026-01-18T12:00:00.000Z",
        },
      ],
    };
    normalizeGraphWeights(graph);
    expect(graph.edges.every((e) => e.weight === 0)).toBe(true);
  });
});
