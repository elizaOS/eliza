/**
 * VectorBrowserView E2E tests — verifies the 3D vector visualization works correctly.
 *
 * Tests cover:
 *   - PCA projection functions (2D and 3D)
 *   - View mode switching (List / 2D / 3D)
 *   - Component rendering with mocked data
 *   - Error handling when database is unavailable
 */

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── PCA utility functions (copied from component for unit testing) ─────

function dot(a: number[], b: Float64Array | number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * (b[i] ?? 0);
  return s;
}

function powerIteration(
  data: number[][],
  dims: number,
  iters = 30,
): Float64Array {
  const v = new Float64Array(dims);
  for (let d = 0; d < dims; d++) v[d] = Math.random() - 0.5;
  let len = 0;
  for (let i = 0; i < v.length; i++) len += v[i] * v[i];
  len = Math.sqrt(len) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= len;

  for (let iter = 0; iter < iters; iter++) {
    const w = new Float64Array(dims);
    for (const row of data) {
      const d = dot(row, v);
      for (let j = 0; j < dims; j++) w[j] += d * row[j];
    }
    let wLen = 0;
    for (let i = 0; i < w.length; i++) wLen += w[i] * w[i];
    wLen = Math.sqrt(wLen) || 1;
    for (let i = 0; i < w.length; i++) w[i] /= wLen;
    for (let d = 0; d < dims; d++) v[d] = w[d];
  }
  return v;
}

function centerData(vectors: number[][]): {
  centered: number[][];
  mean: Float64Array;
} {
  const dims = vectors[0].length;
  const n = vectors.length;
  const mean = new Float64Array(dims);
  for (const v of vectors) {
    for (let d = 0; d < dims; d++) mean[d] += v[d];
  }
  for (let d = 0; d < dims; d++) mean[d] /= n;
  const centered = vectors.map((v) => v.map((x, d) => x - mean[d]));
  return { centered, mean };
}

function deflate(data: number[][], pc: Float64Array): number[][] {
  const proj = data.map((v) => dot(v, pc));
  return data.map((v, i) => v.map((x, d) => x - proj[i] * pc[d]));
}

function projectTo2D(vectors: number[][]): [number, number][] {
  if (vectors.length === 0) return [];
  const dims = vectors[0].length;
  const { centered } = centerData(vectors);
  const pc1 = powerIteration(centered, dims);
  const deflated1 = deflate(centered, pc1);
  const pc2 = powerIteration(deflated1, dims);
  return centered.map((v) => [dot(v, pc1), dot(v, pc2)] as [number, number]);
}

function projectTo3D(vectors: number[][]): [number, number, number][] {
  if (vectors.length === 0) return [];
  const dims = vectors[0].length;
  const { centered } = centerData(vectors);
  const pc1 = powerIteration(centered, dims);
  const deflated1 = deflate(centered, pc1);
  const pc2 = powerIteration(deflated1, dims);
  const deflated2 = deflate(deflated1, pc2);
  const pc3 = powerIteration(deflated2, dims);
  return centered.map(
    (v) => [dot(v, pc1), dot(v, pc2), dot(v, pc3)] as [number, number, number],
  );
}

// ── PCA Unit Tests ─────────────────────────────────────────────────────

describe("PCA Projection Functions", () => {
  it("projectTo2D returns empty array for empty input", () => {
    const result = projectTo2D([]);
    expect(result).toEqual([]);
  });

  it("projectTo3D returns empty array for empty input", () => {
    const result = projectTo3D([]);
    expect(result).toEqual([]);
  });

  it("projectTo2D preserves vector count", () => {
    const vectors = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
      [1, 1, 0, 0],
    ];
    const result = projectTo2D(vectors);
    expect(result.length).toBe(5);
    result.forEach((point) => {
      expect(point.length).toBe(2);
      expect(typeof point[0]).toBe("number");
      expect(typeof point[1]).toBe("number");
      expect(Number.isFinite(point[0])).toBe(true);
      expect(Number.isFinite(point[1])).toBe(true);
    });
  });

  it("projectTo3D preserves vector count", () => {
    const vectors = [
      [1, 0, 0, 0, 0],
      [0, 1, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 1, 0],
      [0, 0, 0, 0, 1],
      [1, 1, 1, 0, 0],
    ];
    const result = projectTo3D(vectors);
    expect(result.length).toBe(6);
    result.forEach((point) => {
      expect(point.length).toBe(3);
      expect(typeof point[0]).toBe("number");
      expect(typeof point[1]).toBe("number");
      expect(typeof point[2]).toBe("number");
      expect(Number.isFinite(point[0])).toBe(true);
      expect(Number.isFinite(point[1])).toBe(true);
      expect(Number.isFinite(point[2])).toBe(true);
    });
  });

  it("projectTo2D handles high-dimensional vectors", () => {
    // Simulate 384-dimensional embeddings (common size)
    const dims = 384;
    const vectors = Array.from({ length: 10 }, () =>
      Array.from({ length: dims }, () => Math.random() - 0.5),
    );
    const result = projectTo2D(vectors);
    expect(result.length).toBe(10);
    result.forEach((point) => {
      expect(point.length).toBe(2);
      expect(Number.isFinite(point[0])).toBe(true);
      expect(Number.isFinite(point[1])).toBe(true);
    });
  });

  it("projectTo3D handles high-dimensional vectors", () => {
    // Simulate 768-dimensional embeddings (common size)
    const dims = 768;
    const vectors = Array.from({ length: 10 }, () =>
      Array.from({ length: dims }, () => Math.random() - 0.5),
    );
    const result = projectTo3D(vectors);
    expect(result.length).toBe(10);
    result.forEach((point) => {
      expect(point.length).toBe(3);
      expect(Number.isFinite(point[0])).toBe(true);
      expect(Number.isFinite(point[1])).toBe(true);
      expect(Number.isFinite(point[2])).toBe(true);
    });
  });

  it("similar vectors cluster together in 2D projection", () => {
    // Create two clusters of vectors
    const cluster1 = [
      [1, 0, 0, 0],
      [0.9, 0.1, 0, 0],
      [0.8, 0.2, 0, 0],
    ];
    const cluster2 = [
      [0, 0, 1, 0],
      [0, 0.1, 0.9, 0],
      [0, 0.2, 0.8, 0],
    ];
    const vectors = [...cluster1, ...cluster2];
    const projected = projectTo2D(vectors);

    // Calculate centroid of each cluster in projected space
    const centroid1 = [
      (projected[0][0] + projected[1][0] + projected[2][0]) / 3,
      (projected[0][1] + projected[1][1] + projected[2][1]) / 3,
    ];
    const centroid2 = [
      (projected[3][0] + projected[4][0] + projected[5][0]) / 3,
      (projected[3][1] + projected[4][1] + projected[5][1]) / 3,
    ];

    // Calculate distance between centroids
    const interClusterDist = Math.sqrt(
      (centroid1[0] - centroid2[0]) ** 2 + (centroid1[1] - centroid2[1]) ** 2,
    );

    // Calculate average intra-cluster distance
    const intraCluster1 = projected
      .slice(0, 3)
      .map((p) =>
        Math.sqrt((p[0] - centroid1[0]) ** 2 + (p[1] - centroid1[1]) ** 2),
      );
    const avgIntraCluster = intraCluster1.reduce((a, b) => a + b, 0) / 3;

    // Inter-cluster distance should be greater than intra-cluster
    expect(interClusterDist).toBeGreaterThan(avgIntraCluster);
  });

  it("similar vectors cluster together in 3D projection", () => {
    // Create two clusters
    const cluster1 = [
      [1, 0, 0, 0, 0],
      [0.9, 0.1, 0, 0, 0],
      [0.8, 0.2, 0, 0, 0],
    ];
    const cluster2 = [
      [0, 0, 0, 1, 0],
      [0, 0, 0.1, 0.9, 0],
      [0, 0, 0.2, 0.8, 0],
    ];
    const vectors = [...cluster1, ...cluster2];
    const projected = projectTo3D(vectors);

    // Calculate 3D centroids
    const centroid1 = [
      (projected[0][0] + projected[1][0] + projected[2][0]) / 3,
      (projected[0][1] + projected[1][1] + projected[2][1]) / 3,
      (projected[0][2] + projected[1][2] + projected[2][2]) / 3,
    ];
    const centroid2 = [
      (projected[3][0] + projected[4][0] + projected[5][0]) / 3,
      (projected[3][1] + projected[4][1] + projected[5][1]) / 3,
      (projected[3][2] + projected[4][2] + projected[5][2]) / 3,
    ];

    // Calculate 3D distance between centroids
    const interClusterDist = Math.sqrt(
      (centroid1[0] - centroid2[0]) ** 2 +
        (centroid1[1] - centroid2[1]) ** 2 +
        (centroid1[2] - centroid2[2]) ** 2,
    );

    // Expect clusters to be separated
    expect(interClusterDist).toBeGreaterThan(0);
  });
});

// ── Mock setup for component tests ─────────────────────────────────────

const { mockUseApp } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
}));

// Mock renderer wrapper to avoid WebGL issues in tests.
vi.mock("@elizaos/app-core/components/vector-browser-three", () => {
  const mockVector2 = class {
    x = 0;
    y = 0;
    constructor(x = 0, y = 0) {
      this.x = x;
      this.y = y;
    }
  };
  const mockVector3 = class {
    x = 0;
    y = 0;
    z = 0;
    set(x: number, y: number, z: number) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
  };
  const mockColor = class {};
  const mockMaterial = class {
    opacity = 1;
    transparent = false;
    dispose() {}
  };
  const mockGeometry = class {
    setAttribute() {}
    dispose() {}
  };
  const mockMesh = class {
    position = new mockVector3();
    scale = { setScalar: vi.fn() };
    userData = {};
    material = new mockMaterial();
  };
  const mockScene = class {
    background = null;
    add() {}
    remove() {}
  };
  const mockCamera = class {
    position = new mockVector3();
    aspect = 1;
    lookAt() {}
    updateProjectionMatrix() {}
  };
  const mockRenderer = class {
    domElement = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
      }),
    };
    setSize() {}
    setPixelRatio() {}
    render() {}
    dispose() {}
  };
  const mockRaycaster = class {
    setFromCamera() {}
    intersectObjects() {
      return [];
    }
  };

  return {
    THREE: {
      Scene: mockScene,
      PerspectiveCamera: mockCamera,
      SphereGeometry: mockGeometry,
      BufferGeometry: mockGeometry,
      MeshBasicMaterial: mockMaterial,
      LineBasicMaterial: mockMaterial,
      Mesh: mockMesh,
      LineSegments: mockMesh,
      GridHelper: mockMesh,
      Vector2: mockVector2,
      Vector3: mockVector3,
      Color: mockColor,
      Raycaster: mockRaycaster,
      BufferAttribute: class {},
    },
    createVectorBrowserRenderer: async () => new mockRenderer(),
  };
});

// Mock api-client
vi.mock("@elizaos/app-core/api", () => ({
  client: {
    getDatabaseTables: vi.fn(),
    executeDatabaseQuery: vi.fn(),
  },
}));

import { client } from "@elizaos/app-core/api";
import { VectorBrowserView } from "@elizaos/app-core/components/VectorBrowserView";

// ── Component Tests ────────────────────────────────────────────────────

function nodeText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : ""))
    .join("")
    .trim();
}

function findButtonByText(
  root: TestRenderer.ReactTestInstance,
  label: string,
): TestRenderer.ReactTestInstance | null {
  const matches = root.findAll(
    (node) => node.type === "button" && nodeText(node) === label,
  );
  return matches[0] ?? null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("VectorBrowserView Component", () => {
  beforeEach(() => {
    mockUseApp.mockReset();
    mockUseApp.mockReturnValue({ uiLanguage: "en", t: (k: string) => k });
    vi.mocked(client.getDatabaseTables).mockReset();
    vi.mocked(client.executeDatabaseQuery).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows connection error when database is unavailable", async () => {
    vi.mocked(client.getDatabaseTables).mockRejectedValue(
      new Error("Failed to fetch"),
    );

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(VectorBrowserView));
    });
    await flush();

    const root = tree?.root;
    const errorText = root.findAll(
      (node) =>
        typeof node.children[0] === "string" &&
        node.children[0].includes("vectorbrowserview.DatabaseNotAvailab"),
    );
    expect(errorText.length).toBeGreaterThan(0);

    // Should show retry button
    const retryButton = findButtonByText(
      root,
      "vectorbrowserview.RetryConnection",
    );
    expect(retryButton).not.toBeNull();
  });

  it("renders view mode toggle buttons including 3D", async () => {
    vi.mocked(client.getDatabaseTables).mockResolvedValue({
      tables: [
        { name: "memories", schema: "public", rowCount: 10, columns: [] },
      ],
    });
    vi.mocked(client.executeDatabaseQuery).mockResolvedValue({
      columns: ["id", "content"],
      rows: [],
      rowCount: 0,
      durationMs: 1,
    });

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(VectorBrowserView));
    });
    await flush();

    const root = tree?.root;

    // Should have List, 2D, and 3D buttons
    const listButton = findButtonByText(root, "vectorbrowserview.List");
    const graph2DButton = findButtonByText(root, "2D");
    const graph3DButton = findButtonByText(root, "3D");

    expect(listButton).not.toBeNull();
    expect(graph2DButton).not.toBeNull();
    expect(graph3DButton).not.toBeNull();
  });

  it("switches to 3D view mode when 3D button is clicked", async () => {
    vi.mocked(client.getDatabaseTables).mockResolvedValue({
      tables: [
        { name: "memories", schema: "public", rowCount: 10, columns: [] },
      ],
    });
    vi.mocked(client.executeDatabaseQuery).mockResolvedValue({
      columns: ["id", "content", "embedding"],
      rows: [
        { id: "1", content: "test1", embedding: "[0.1,0.2,0.3,0.4]" },
        { id: "2", content: "test2", embedding: "[0.2,0.3,0.4,0.5]" },
        { id: "3", content: "test3", embedding: "[0.3,0.4,0.5,0.6]" },
      ],
      rowCount: 3,
      durationMs: 1,
    });

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(VectorBrowserView));
    });
    await flush();

    const root = tree?.root;
    const graph3DButton = findButtonByText(root, "3D");
    expect(graph3DButton).not.toBeNull();

    // Click the 3D button
    await act(async () => {
      graph3DButton?.props.onClick();
    });
    await flush();

    // 3D button should now be active (has default variant styling, bg-primary)
    const updatedButton = findButtonByText(root, "3D");
    expect(updatedButton?.props.className).toContain("bg-primary");
  });

  it("displays empty state when no memories found", async () => {
    vi.mocked(client.getDatabaseTables).mockResolvedValue({
      tables: [
        { name: "memories", schema: "public", rowCount: 0, columns: [] },
      ],
    });
    vi.mocked(client.executeDatabaseQuery).mockResolvedValue({
      columns: [],
      rows: [],
      rowCount: 0,
      durationMs: 1,
    });

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(VectorBrowserView));
    });
    await flush();

    const root = tree?.root;
    const noMemoriesText = root.findAll(
      (node) =>
        typeof node.children[0] === "string" &&
        node.children[0].includes("vectorbrowserview.NoMemoriesFound"),
    );
    expect(noMemoriesText.length).toBeGreaterThan(0);
  });

  it("renders memory list items when data is available", async () => {
    vi.mocked(client.getDatabaseTables).mockResolvedValue({
      tables: [
        { name: "memories", schema: "public", rowCount: 100, columns: [] },
      ],
    });
    vi.mocked(client.executeDatabaseQuery).mockImplementation(
      async (sql: string) => {
        if (sql.includes("COUNT")) {
          return {
            columns: ["cnt"],
            rows: [{ cnt: 2 }],
            rowCount: 1,
            durationMs: 1,
          };
        }
        return {
          columns: ["id", "content", "type", "createdAt"],
          rows: [
            {
              id: "1",
              content: "first test memory",
              type: "message",
              createdAt: "2024-01-01",
            },
            {
              id: "2",
              content: "second test memory",
              type: "message",
              createdAt: "2024-01-02",
            },
          ],
          rowCount: 2,
          durationMs: 1,
        };
      },
    );

    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(VectorBrowserView));
    });
    await flush();

    const root = tree?.root;

    // Should find memory content in the list
    const memoryItems = root.findAll(
      (node) =>
        typeof node.children[0] === "string" &&
        (node.children[0].includes("first test memory") ||
          node.children[0].includes("second test memory")),
    );
    expect(memoryItems.length).toBeGreaterThan(0);
  });
});

// ── Integration Tests ──────────────────────────────────────────────────

describe("Vector Browser Integration", () => {
  it("parses embedding strings correctly", () => {
    // Test the embedding parsing logic
    const parseEmbedding = (val: unknown): number[] | null => {
      if (!val) return null;
      if (Array.isArray(val)) return val as number[];
      if (typeof val === "string" && val.length > 2) {
        const trimmed = val.trim();
        const inner =
          trimmed.startsWith("[") && trimmed.endsWith("]")
            ? trimmed.slice(1, -1)
            : trimmed;
        if (!inner) return null;
        const parts = inner.split(",");
        if (parts.length < 2) return null;
        const nums: number[] = [];
        for (const p of parts) {
          const n = Number.parseFloat(p);
          if (Number.isNaN(n)) return null;
          nums.push(n);
        }
        return nums;
      }
      return null;
    };

    // pgvector format
    expect(parseEmbedding("[0.1,0.2,0.3]")).toEqual([0.1, 0.2, 0.3]);

    // Without brackets
    expect(parseEmbedding("0.1,0.2,0.3")).toEqual([0.1, 0.2, 0.3]);

    // Array input
    expect(parseEmbedding([0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3]);

    // Invalid inputs
    expect(parseEmbedding(null)).toBeNull();
    expect(parseEmbedding("")).toBeNull();
    expect(parseEmbedding("invalid")).toBeNull();
    expect(parseEmbedding("[0.1]")).toBeNull(); // Too short
  });

  it("handles typed arrays for embeddings", () => {
    const parseEmbedding = (val: unknown): number[] | null => {
      if (!val) return null;
      if (Array.isArray(val)) return val as number[];
      if (ArrayBuffer.isView(val)) {
        return Array.from(val as Float64Array);
      }
      return null;
    };

    const float32 = new Float32Array([0.1, 0.2, 0.3]);
    const result = parseEmbedding(float32);
    expect(result).toHaveLength(3);
    expect(result?.[0]).toBeCloseTo(0.1, 5);
  });
});
