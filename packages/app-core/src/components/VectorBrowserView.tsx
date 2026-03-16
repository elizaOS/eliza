/**
 * Vector Browser — explore agent memories and embeddings.
 *
 * Reads from the memories table (or similar vector-storage tables) using
 * the generic database APIs. Shows paginated memory records with content,
 * metadata, and embedding previews. Click any card to see full details.
 * Toggle to a 2D scatter-plot graph view of embeddings.
 */

import { Button, Input } from "@elizaos/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client, type QueryResult, type TableInfo } from "../api";
import { useApp } from "../state";
import { createVectorBrowserRenderer, THREE } from "./vector-browser-three";

const PAGE_SIZE = 25;
const MAX_THREE_PIXEL_RATIO = 2;

type ViewMode = "list" | "graph" | "3d";

/** The dimension columns in the elizaOS `embeddings` table. */
const DIM_COLUMNS = [
  "dim_384",
  "dim_512",
  "dim_768",
  "dim_1024",
  "dim_1536",
  "dim_3072",
] as const;

interface MemoryRecord {
  id: string;
  content: string;
  roomId: string;
  entityId: string;
  type: string;
  createdAt: string;
  unique: boolean;
  embedding: number[] | null;
  raw: Record<string, unknown>;
}

function hasEmbedding(
  memory: MemoryRecord,
): memory is MemoryRecord & { embedding: number[] } {
  return memory.embedding !== null;
}

interface VectorGraph2DBounds {
  minX: number;
  minY: number;
  rangeX: number;
  rangeY: number;
}

interface VectorGraph2DLayout {
  bounds: VectorGraph2DBounds;
  points: [number, number][];
  typeColors: Record<string, string>;
  withEmbeddings: Array<MemoryRecord & { embedding: number[] }>;
}

const VECTOR_GRAPH_2D_PALETTE = [
  "#6cf",
  "#f59e0b",
  "#10b981",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#84cc16",
];

/** Try to parse a JSON content field, returning the text content or the raw string. */
function parseContent(val: unknown): string {
  if (typeof val !== "string") return String(val ?? "");
  if (val.startsWith("{")) {
    try {
      const parsed = JSON.parse(val);
      if (parsed.text) return String(parsed.text);
      return val;
    } catch {
      return val;
    }
  }
  return val;
}

/** Parse an embedding from various storage formats (pgvector text, JSON, typed arrays). */
function parseEmbedding(val: unknown): number[] | null {
  if (!val) return null;
  if (Array.isArray(val)) return val as number[];
  // Handle typed arrays (Float32Array, Float64Array, Uint8Array etc.)
  if (ArrayBuffer.isView(val)) {
    return Array.from(val as Float64Array);
  }
  if (typeof val === "string" && val.length > 2) {
    const trimmed = val.trim();
    // pgvector text format: [0.1,0.2,0.3] — also valid JSON
    // Also handle without brackets: 0.1,0.2,0.3
    const inner =
      trimmed.startsWith("[") && trimmed.endsWith("]")
        ? trimmed.slice(1, -1)
        : trimmed;
    if (!inner) return null;
    // Fast path: split by comma and parse floats
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
}

function rowToMemory(row: Record<string, unknown>): MemoryRecord {
  // Try explicit embedding/vector column first, then check elizaOS dim_* columns
  let embeddingVal = row.embedding ?? row.vector ?? row.embeddings;
  if (!embeddingVal) {
    for (const dim of DIM_COLUMNS) {
      if (row[dim]) {
        embeddingVal = row[dim];
        break;
      }
    }
  }

  return {
    id: String(row.id ?? row.ID ?? row.memory_id ?? ""),
    content: parseContent(row.content ?? row.body ?? row.text ?? ""),
    roomId: String(row.roomId ?? row.room_id ?? row.roomID ?? ""),
    entityId: String(
      row.entityId ??
        row.entity_id ??
        row.entityID ??
        row.userId ??
        row.user_id ??
        "",
    ),
    type: String(row.type ?? row.memoryType ?? row.memory_type ?? ""),
    createdAt: String(row.createdAt ?? row.created_at ?? row.timestamp ?? ""),
    unique: row.unique === true || row.unique === 1 || row.isUnique === true,
    embedding: parseEmbedding(embeddingVal),
    raw: row,
  };
}

function buildVectorGraph2DLayout(
  memories: MemoryRecord[],
): VectorGraph2DLayout | null {
  const withEmbeddings = memories.filter(hasEmbedding);
  if (withEmbeddings.length < 2) {
    return null;
  }

  const points = projectTo2D(withEmbeddings.map((memory) => memory.embedding));
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const typeColors: Record<string, string> = {};
  const types = [...new Set(withEmbeddings.map((memory) => memory.type))];
  for (let index = 0; index < types.length; index += 1) {
    typeColors[types[index]] =
      VECTOR_GRAPH_2D_PALETTE[index % VECTOR_GRAPH_2D_PALETTE.length];
  }

  return {
    bounds: {
      minX,
      minY,
      rangeX: maxX - minX || 1,
      rangeY: maxY - minY || 1,
    },
    points,
    typeColors,
    withEmbeddings,
  };
}

function toVectorGraph2DScreenX(
  x: number,
  width: number,
  padding: number,
  bounds: VectorGraph2DBounds,
): number {
  return padding + ((x - bounds.minX) / bounds.rangeX) * (width - 2 * padding);
}

function toVectorGraph2DScreenY(
  y: number,
  height: number,
  padding: number,
  bounds: VectorGraph2DBounds,
): number {
  return padding + ((y - bounds.minY) / bounds.rangeY) * (height - 2 * padding);
}

// ── PCA projection utilities ───────────────────────────────────────────

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
  // Random init
  for (let d = 0; d < dims; d++) v[d] = Math.random() - 0.5;
  normalize(v);

  for (let iter = 0; iter < iters; iter++) {
    const w = new Float64Array(dims);
    for (const row of data) {
      const d = dot(row, v);
      for (let j = 0; j < dims; j++) w[j] += d * row[j];
    }
    normalize(w);
    for (let d = 0; d < dims; d++) v[d] = w[d];
  }
  return v;
}

function normalize(v: Float64Array) {
  let len = 0;
  for (let i = 0; i < v.length; i++) len += v[i] * v[i];
  len = Math.sqrt(len) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= len;
}

/** Compute mean and center data for PCA. */
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

/** Deflate data by removing projection onto a principal component. */
function deflate(data: number[][], pc: Float64Array): number[][] {
  const proj = data.map((v) => dot(v, pc));
  return data.map((v, i) => v.map((x, d) => x - proj[i] * pc[d]));
}

/** Project high-dimensional vectors to 2D using the first two principal axes. */
function projectTo2D(vectors: number[][]): [number, number][] {
  if (vectors.length === 0) return [];
  const dims = vectors[0].length;
  const { centered } = centerData(vectors);

  const pc1 = powerIteration(centered, dims);
  const deflated1 = deflate(centered, pc1);
  const pc2 = powerIteration(deflated1, dims);

  return centered.map((v) => [dot(v, pc1), dot(v, pc2)] as [number, number]);
}

/** Project high-dimensional vectors to 3D using the first three principal axes. */
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

// ── Graph sub-component ────────────────────────────────────────────────

function VectorGraph({
  memories,
  onSelect,
}: {
  memories: MemoryRecord[];
  onSelect: (mem: MemoryRecord) => void;
}) {
  const { t } = useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const graph = useMemo(() => buildVectorGraph2DLayout(memories), [memories]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !graph) return;

    const rect = container.getBoundingClientRect();
    const W = rect.width;
    const H = 500;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const pad = 40;

    // Background
    const style = getComputedStyle(document.documentElement);
    const bgColor = style.getPropertyValue("--bg").trim() || "#111";
    const borderColor = style.getPropertyValue("--border").trim() || "#333";
    const accentColor = style.getPropertyValue("--accent").trim() || "#6cf";
    const mutedColor = style.getPropertyValue("--muted").trim() || "#888";

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, W, H);

    // Grid lines
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const x = pad + (i / 4) * (W - 2 * pad);
      const y = pad + (i / 4) * (H - 2 * pad);
      ctx.beginPath();
      ctx.moveTo(x, pad);
      ctx.lineTo(x, H - pad);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(W - pad, y);
      ctx.stroke();
    }

    // Axis labels
    ctx.fillStyle = mutedColor;
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText("PC1", W / 2, H - 8);
    ctx.save();
    ctx.translate(12, H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("PC2", 0, 0);
    ctx.restore();

    // Draw points
    for (let i = 0; i < graph.points.length; i++) {
      const sx = toVectorGraph2DScreenX(
        graph.points[i][0],
        W,
        pad,
        graph.bounds,
      );
      const sy = toVectorGraph2DScreenY(
        graph.points[i][1],
        H,
        pad,
        graph.bounds,
      );
      const memory = graph.withEmbeddings[i];
      const color = graph.typeColors[memory.type] || accentColor;
      const isHovered = hoveredIdx === i;

      ctx.beginPath();
      ctx.arc(sx, sy, isHovered ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = isHovered ? 1 : 0.7;
      ctx.fill();
      ctx.globalAlpha = 1;

      if (isHovered) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // Tooltip for hovered point
    if (hoveredIdx !== null && hoveredIdx < graph.points.length) {
      const sx = toVectorGraph2DScreenX(
        graph.points[hoveredIdx][0],
        W,
        pad,
        graph.bounds,
      );
      const sy = toVectorGraph2DScreenY(
        graph.points[hoveredIdx][1],
        H,
        pad,
        graph.bounds,
      );
      const memory = graph.withEmbeddings[hoveredIdx];
      const label =
        memory.content.slice(0, 60) + (memory.content.length > 60 ? "..." : "");

      ctx.font = "11px sans-serif";
      const metrics = ctx.measureText(label);
      const tw = metrics.width + 12;
      const th = 22;
      let tx = sx + 10;
      let ty = sy - 10 - th;
      if (tx + tw > W) tx = sx - tw - 10;
      if (ty < 0) ty = sy + 10;

      ctx.fillStyle = "rgba(0,0,0,0.85)";
      ctx.fillRect(tx, ty, tw, th);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "left";
      ctx.fillText(label, tx + 6, ty + 15);
    }

    // Legend
    const types = Object.keys(graph.typeColors);
    if (types.length > 1) {
      let lx = pad;
      const ly = H - 4;
      ctx.font = "10px sans-serif";
      ctx.textAlign = "left";
      for (const type of types) {
        if (!type || type === "undefined") continue;
        ctx.fillStyle = graph.typeColors[type];
        ctx.fillRect(lx, ly - 8, 8, 8);
        ctx.fillStyle = mutedColor;
        ctx.fillText(type, lx + 11, ly);
        lx += ctx.measureText(type).width + 24;
      }
    }
  }, [graph, hoveredIdx]);

  // Mouse interaction
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !graph) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const W = rect.width;
      const H = rect.height;
      const pad = 40;

      let closest = -1;
      let closestDist = 15; // max pixel distance
      for (let i = 0; i < graph.points.length; i++) {
        const sx = toVectorGraph2DScreenX(
          graph.points[i][0],
          W,
          pad,
          graph.bounds,
        );
        const sy = toVectorGraph2DScreenY(
          graph.points[i][1],
          H,
          pad,
          graph.bounds,
        );
        const dist = Math.sqrt((mx - sx) ** 2 + (my - sy) ** 2);
        if (dist < closestDist) {
          closestDist = dist;
          closest = i;
        }
      }
      setHoveredIdx(closest >= 0 ? closest : null);
    },
    [graph],
  );

  const handleClick = useCallback(() => {
    if (
      graph &&
      hoveredIdx !== null &&
      hoveredIdx < graph.withEmbeddings.length
    ) {
      onSelect(graph.withEmbeddings[hoveredIdx]);
    }
  }, [graph, hoveredIdx, onSelect]);

  if (!graph) {
    const withEmbeddings = memories.filter(hasEmbedding);
    return (
      <div className="text-center py-16">
        <div className="text-[var(--muted)] text-sm mb-2">
          {t("vectorbrowserview.NotEnoughEmbedding")}
        </div>
        <div className="text-[var(--muted)] text-xs">
          {t("vectorbrowserview.NeedAtLeast2Memo")} {withEmbeddings.length}.
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full">
      <div className="text-[11px] text-[var(--muted)] mb-2">
        {graph.withEmbeddings.length}{" "}
        {t("vectorbrowserview.vectorsProjectedTo")}
      </div>
      <canvas
        ref={canvasRef}
        className="w-full border border-[var(--border)] cursor-crosshair"
        style={{ height: 500 }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredIdx(null)}
        onClick={handleClick}
      />
    </div>
  );
}

// ── 3D Graph sub-component (Three.js) ──────────────────────────────────

function VectorGraph3D({
  memories,
  onSelect,
}: {
  memories: MemoryRecord[];
  onSelect: (mem: MemoryRecord) => void;
}) {
  const { t } = useApp();
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const spheresRef = useRef<THREE.Mesh[]>([]);
  const animationRef = useRef<number>(0);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [rendererUnavailable, setRendererUnavailable] = useState(false);
  const isDraggingRef = useRef(false);
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const withEmbeddings = useMemo(
    () => memories.filter(hasEmbedding),
    [memories],
  );

  const points3D = useMemo(() => {
    if (withEmbeddings.length < 2) return [];
    const vecs = withEmbeddings.map((m) => m.embedding);
    return projectTo3D(vecs);
  }, [withEmbeddings]);

  // Color palette for types
  const typeColors = useMemo(() => {
    const types = [...new Set(withEmbeddings.map((m) => m.type))];
    const palette = [
      0x6699ff, 0xf59e0b, 0x10b981, 0xef4444, 0x8b5cf6, 0xec4899, 0x06b6d4,
      0x84cc16,
    ];
    const map: Record<string, number> = {};
    types.forEach((t, i) => {
      map[t] = palette[i % palette.length];
    });
    return map;
  }, [withEmbeddings]);

  // Initialize Three.js scene
  useEffect(() => {
    const container = containerRef.current;
    if (!container || points3D.length === 0) return;

    let cancelled = false;
    cleanupRef.current = null;
    setRendererUnavailable(false);

    // Async renderer creation — tries WebGPU, falls back to WebGL.
    // All scene setup runs inside this async IIFE so the useEffect callback
    // itself remains synchronous (required for React cleanup return).
    void (async () => {
      const W = container.clientWidth;
      const H = 550;

      // Scene
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x111111);
      sceneRef.current = scene;

      // Camera
      const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 1000);
      camera.position.set(0, 0, 5);
      cameraRef.current = camera;

      let renderer: THREE.WebGLRenderer;
      try {
        renderer = await createVectorBrowserRenderer();
      } catch {
        if (!cancelled) {
          setRendererUnavailable(true);
        }
        return;
      }

      // Guard: if the effect was cleaned up while awaiting WebGPU init, abort.
      if (cancelled) {
        renderer.dispose();
        return;
      }

      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      const geometry = new THREE.SphereGeometry(0.06, 16, 16);
      const spheres: THREE.Mesh[] = [];
      let gridHelper: THREE.GridHelper | null = null;
      let axisGeom: THREE.BufferGeometry | null = null;
      let axisMat: THREE.LineBasicMaterial | null = null;
      let onMouseDown: ((e: MouseEvent) => void) | null = null;
      let onMouseUp: (() => void) | null = null;
      let onMouseMove: ((e: MouseEvent) => void) | null = null;
      let onClick: ((e: MouseEvent) => void) | null = null;
      let onWheel: ((e: WheelEvent) => void) | null = null;
      let onMouseLeave: (() => void) | null = null;
      let handleResize: (() => void) | null = null;
      let cleanedUp = false;

      cleanupRef.current = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        cancelAnimationFrame(animationRef.current);
        if (handleResize) {
          window.removeEventListener("resize", handleResize);
        }
        if (onMouseDown) {
          renderer.domElement.removeEventListener("mousedown", onMouseDown);
        }
        if (onMouseUp) {
          renderer.domElement.removeEventListener("mouseup", onMouseUp);
        }
        if (onMouseMove) {
          renderer.domElement.removeEventListener("mousemove", onMouseMove);
        }
        if (onClick) {
          renderer.domElement.removeEventListener("click", onClick);
        }
        if (onWheel) {
          renderer.domElement.removeEventListener("wheel", onWheel);
        }
        if (onMouseLeave) {
          renderer.domElement.removeEventListener("mouseleave", onMouseLeave);
        }
        geometry.dispose();
        axisGeom?.dispose();
        axisMat?.dispose();
        if (gridHelper) {
          const gridMaterial = Array.isArray(gridHelper.material)
            ? gridHelper.material
            : [gridHelper.material];
          for (const material of gridMaterial) {
            material.dispose();
          }
          gridHelper.geometry.dispose();
        }
        for (const sphere of spheres) {
          const material = sphere.material;
          if (Array.isArray(material)) {
            for (const entry of material) {
              entry.dispose();
            }
          } else {
            material.dispose();
          }
        }
        renderer.dispose();
        rendererRef.current = null;
        sceneRef.current = null;
        cameraRef.current = null;
        spheresRef.current = [];
        if (container.contains(renderer.domElement)) {
          container.removeChild(renderer.domElement);
        }
      };

      renderer.setSize(W, H);
      renderer.setPixelRatio(
        Math.min(window.devicePixelRatio || 1, MAX_THREE_PIXEL_RATIO),
      );
      container.appendChild(renderer.domElement);
      rendererRef.current = renderer;
      if (cancelled) {
        cleanupRef.current?.();
        cleanupRef.current = null;
        return;
      }

      // Compute bounds for scaling
      let minX = Infinity,
        maxX = -Infinity;
      let minY = Infinity,
        maxY = -Infinity;
      let minZ = Infinity,
        maxZ = -Infinity;
      for (const [x, y, z] of points3D) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      const rangeX = maxX - minX || 1;
      const rangeY = maxY - minY || 1;
      const rangeZ = maxZ - minZ || 1;
      const maxRange = Math.max(rangeX, rangeY, rangeZ);
      const scale = 3 / maxRange;
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const centerZ = (minZ + maxZ) / 2;

      for (let i = 0; i < points3D.length; i++) {
        const [x, y, z] = points3D[i];
        const mem = withEmbeddings[i];
        const color = typeColors[mem.type] ?? 0x6699ff;
        const material = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.85,
        });
        const sphere = new THREE.Mesh(geometry, material);
        sphere.position.set(
          (x - centerX) * scale,
          (y - centerY) * scale,
          (z - centerZ) * scale,
        );
        sphere.userData = { index: i };
        scene.add(sphere);
        spheres.push(sphere);
      }
      spheresRef.current = spheres;

      // Add subtle grid helper
      gridHelper = new THREE.GridHelper(6, 12, 0x333333, 0x222222);
      gridHelper.position.y = -2;
      scene.add(gridHelper);

      // Add axis lines
      const axisLength = 2.5;
      axisGeom = new THREE.BufferGeometry();
      const axisPositions = new Float32Array([
        -axisLength,
        0,
        0,
        axisLength,
        0,
        0, // X axis
        0,
        -axisLength,
        0,
        0,
        axisLength,
        0, // Y axis
        0,
        0,
        -axisLength,
        0,
        0,
        axisLength, // Z axis
      ]);
      axisGeom.setAttribute(
        "position",
        new THREE.BufferAttribute(axisPositions, 3),
      );
      axisMat = new THREE.LineBasicMaterial({ color: 0x444444 });
      const axisLines = new THREE.LineSegments(axisGeom, axisMat);
      scene.add(axisLines);

      // Simple orbit controls (manual implementation)
      let theta = 0;
      let phi = Math.PI / 4;
      let radius = 5;
      let targetTheta = theta;
      let targetPhi = phi;
      let targetRadius = radius;
      const updatePointerFromEvent = (e: MouseEvent) => {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.set(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1,
        );
        return rect;
      };

      const updateCamera = () => {
        theta += (targetTheta - theta) * 0.1;
        phi += (targetPhi - phi) * 0.1;
        radius += (targetRadius - radius) * 0.1;
        phi = Math.max(0.1, Math.min(Math.PI - 0.1, phi));
        camera.position.x = radius * Math.sin(phi) * Math.cos(theta);
        camera.position.y = radius * Math.cos(phi);
        camera.position.z = radius * Math.sin(phi) * Math.sin(theta);
        camera.lookAt(0, 0, 0);
      };

      onMouseDown = (e: MouseEvent) => {
        isDraggingRef.current = true;
        mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
      };

      onMouseUp = () => {
        isDraggingRef.current = false;
        mouseDownPosRef.current = null;
      };

      onMouseMove = (e: MouseEvent) => {
        if (isDraggingRef.current) {
          targetTheta -= e.movementX * 0.01;
          targetPhi -= e.movementY * 0.01;
        }

        // Raycasting for hover
        const rect = updatePointerFromEvent(e);
        raycaster.setFromCamera(pointer, camera);
        const intersects = raycaster.intersectObjects(spheres);

        if (intersects.length > 0) {
          const idx = intersects[0].object.userData.index;
          setHoveredIdx(idx);
          setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
          // Highlight hovered sphere
          spheres.forEach((s, i) => {
            const mat = s.material as THREE.MeshBasicMaterial;
            mat.opacity = i === idx ? 1 : 0.5;
            s.scale.setScalar(i === idx ? 1.5 : 1);
          });
        } else {
          setHoveredIdx(null);
          setTooltipPos(null);
          spheres.forEach((s) => {
            const mat = s.material as THREE.MeshBasicMaterial;
            mat.opacity = 0.85;
            s.scale.setScalar(1);
          });
        }
      };

      onClick = (e: MouseEvent) => {
        // Only trigger click if we didn't drag much
        if (mouseDownPosRef.current) {
          const dx = Math.abs(e.clientX - mouseDownPosRef.current.x);
          const dy = Math.abs(e.clientY - mouseDownPosRef.current.y);
          if (dx > 5 || dy > 5) return; // Was a drag, not a click
        }

        updatePointerFromEvent(e);
        raycaster.setFromCamera(pointer, camera);
        const intersects = raycaster.intersectObjects(spheres);
        if (intersects.length > 0) {
          const idx = intersects[0].object.userData.index;
          if (idx < withEmbeddings.length) {
            onSelect(withEmbeddings[idx]);
          }
        }
      };

      onWheel = (e: WheelEvent) => {
        e.preventDefault();
        targetRadius += e.deltaY * 0.005;
        targetRadius = Math.max(2, Math.min(15, targetRadius));
      };

      onMouseLeave = () => {
        isDraggingRef.current = false;
        setHoveredIdx(null);
        setTooltipPos(null);
      };

      renderer.domElement.addEventListener("mousedown", onMouseDown);
      renderer.domElement.addEventListener("mouseup", onMouseUp);
      renderer.domElement.addEventListener("mousemove", onMouseMove);
      renderer.domElement.addEventListener("click", onClick);
      renderer.domElement.addEventListener("wheel", onWheel, {
        passive: false,
      });
      renderer.domElement.addEventListener("mouseleave", onMouseLeave);
      if (cancelled) {
        cleanupRef.current?.();
        cleanupRef.current = null;
        return;
      }

      // Animation loop
      const animate = () => {
        updateCamera();
        renderer.render(scene, camera);
        animationRef.current = requestAnimationFrame(animate);
      };
      animate();

      // Resize handler
      handleResize = () => {
        const newW = container.clientWidth;
        camera.aspect = newW / H;
        camera.updateProjectionMatrix();
        renderer.setSize(newW, H);
      };
      window.addEventListener("resize", handleResize);
    })(); // end async IIFE

    return () => {
      cancelled = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [points3D, withEmbeddings, typeColors, onSelect]);

  if (withEmbeddings.length < 2) {
    return (
      <div className="text-center py-16">
        <div className="text-[var(--muted)] text-sm mb-2">
          {t("vectorbrowserview.NotEnoughEmbedding1")}
        </div>
        <div className="text-[var(--muted)] text-xs">
          {t("vectorbrowserview.NeedAtLeast2Memo")} {withEmbeddings.length}.
        </div>
      </div>
    );
  }

  if (rendererUnavailable) {
    return (
      <div className="border border-[var(--border)] bg-[var(--card)] px-4 py-10 text-center">
        <div className="text-sm text-[var(--txt)]">
          3D view unavailable in this environment.
        </div>
        <div className="mt-2 text-xs text-[var(--muted)]">
          The current runtime could not initialize a renderer.
        </div>
      </div>
    );
  }

  const hoveredMem = hoveredIdx !== null ? withEmbeddings[hoveredIdx] : null;

  return (
    <div className="relative">
      <div className="text-[11px] text-[var(--muted)] mb-2">
        {withEmbeddings.length} {t("vectorbrowserview.vectorsProjectedTo1")}
      </div>
      <div
        ref={containerRef}
        className="w-full border border-[var(--border)] cursor-grab active:cursor-grabbing"
        style={{ height: 550 }}
      />
      {/* Tooltip */}
      {hoveredMem && tooltipPos && (
        <div
          className="absolute pointer-events-none bg-black/90 text-white text-[11px] px-3 py-2 max-w-[300px] z-10"
          style={{
            left: tooltipPos.x + 15,
            top: tooltipPos.y + 15,
            transform: tooltipPos.x > 400 ? "translateX(-100%)" : undefined,
          }}
        >
          <div className="font-medium mb-1 truncate">
            {hoveredMem.type && hoveredMem.type !== "undefined" && (
              <span className="px-1.5 py-0.5 bg-[var(--accent)]/30 text-[var(--accent)] mr-2 text-[10px]">
                {hoveredMem.type}
              </span>
            )}
            {hoveredMem.id.slice(0, 12)}...
          </div>
          <div className="text-[var(--muted)] line-clamp-3">
            {hoveredMem.content.slice(0, 150)}
            {hoveredMem.content.length > 150 ? "..." : ""}
          </div>
        </div>
      )}
      {/* Legend */}
      <div className="flex flex-wrap gap-3 mt-2 text-[10px]">
        {Object.entries(typeColors).map(
          ([type, color]) =>
            type &&
            type !== "undefined" && (
              <div key={type} className="flex items-center gap-1.5">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{
                    backgroundColor: `#${color.toString(16).padStart(6, "0")}`,
                  }}
                />
                <span className="text-[var(--muted)]">{type}</span>
              </div>
            ),
        )}
      </div>
    </div>
  );
}

// ── Detail modal ───────────────────────────────────────────────────────

function MemoryDetailModal({
  memory,
  onClose,
}: {
  memory: MemoryRecord;
  onClose: () => void;
}) {
  const { t } = useApp();
  return (
    <div
      className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-8"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClose();
        }
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-[var(--card)] border border-[var(--border)] max-w-[700px] w-full max-h-[90vh] overflow-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b border-[var(--border)]">
          <div className="text-xs font-medium text-[var(--txt)]">
            {t("vectorbrowserview.MemoryDetail")}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="text-[var(--muted)] hover:text-[var(--txt)] hover:bg-transparent h-6 w-6 text-lg"
            onClick={onClose}
          >
            ×
          </Button>
        </div>

        {/* Content */}
        <div className="p-4">
          <div className="text-[11px] text-[var(--muted)] mb-1 uppercase font-bold">
            {t("vectorbrowserview.Content")}
          </div>
          <div className="text-xs text-[var(--txt)] whitespace-pre-wrap break-words mb-4 p-2 bg-[var(--bg)] border border-[var(--border)] max-h-[200px] overflow-auto">
            {memory.content || "(empty)"}
          </div>

          {/* Metadata */}
          <div className="text-[11px] text-[var(--muted)] mb-1 uppercase font-bold">
            {t("vectorbrowserview.Metadata")}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-4">
            <span className="text-[var(--muted)]">ID</span>
            <span className="text-[var(--txt)] font-mono truncate">
              {memory.id || "—"}
            </span>
            <span className="text-[var(--muted)]">
              {t("vectorbrowserview.Type")}
            </span>
            <span className="text-[var(--txt)]">{memory.type || "—"}</span>
            <span className="text-[var(--muted)]">
              {t("vectorbrowserview.Room")}
            </span>
            <span className="text-[var(--txt)] font-mono truncate">
              {memory.roomId || "—"}
            </span>
            <span className="text-[var(--muted)]">
              {t("vectorbrowserview.Entity")}
            </span>
            <span className="text-[var(--txt)] font-mono truncate">
              {memory.entityId || "—"}
            </span>
            <span className="text-[var(--muted)]">
              {t("vectorbrowserview.Created")}
            </span>
            <span className="text-[var(--txt)]">{memory.createdAt || "—"}</span>
            <span className="text-[var(--muted)]">
              {t("vectorbrowserview.Unique")}
            </span>
            <span className="text-[var(--txt)]">
              {memory.unique ? "Yes" : "No"}
            </span>
          </div>

          {/* Embedding */}
          {memory.embedding && (
            <>
              <div className="text-[11px] text-[var(--muted)] mb-1 uppercase font-bold">
                {t("vectorbrowserview.Embedding")}
                {memory.embedding.length} {t("vectorbrowserview.dimensions")}
              </div>
              <div className="p-2 bg-[var(--bg)] border border-[var(--border)] text-[10px] font-mono text-[var(--muted)] max-h-[150px] overflow-auto break-all mb-4">
                [{memory.embedding.map((v) => v.toFixed(6)).join(", ")}]
              </div>
            </>
          )}

          {/* Raw data */}
          <details>
            <summary className="text-[11px] text-[var(--muted)] cursor-pointer hover:text-[var(--txt)] uppercase font-bold mb-1">
              {t("vectorbrowserview.RawRecord")}
            </summary>
            <div className="p-2 bg-[var(--bg)] border border-[var(--border)] text-[10px] font-mono text-[var(--muted)] max-h-[200px] overflow-auto break-all">
              {JSON.stringify(memory.raw, null, 2)}
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────

export function VectorBrowserView() {
  const { t } = useApp();
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selectedTable, setSelectedTable] = useState("");
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [selectedMemory, setSelectedMemory] = useState<MemoryRecord | null>(
    null,
  );
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [graphMemories, setGraphMemories] = useState<MemoryRecord[]>([]);
  const [graphLoading, setGraphLoading] = useState(false);
  const [stats, setStats] = useState<{
    total: number;
    dimensions: number;
    uniqueCount: number;
  } | null>(null);

  // Track whether the `embeddings` table exists for JOIN queries
  const [hasEmbeddingsTable, setHasEmbeddingsTable] = useState(false);

  // Discover vector/memory tables
  const loadTables = useCallback(async () => {
    try {
      const { tables: allTables } = await client.getDatabaseTables();
      const vectorTables = allTables.filter((t) => {
        const n = t.name.toLowerCase();
        return (
          n.includes("memor") ||
          n.includes("embed") ||
          n.includes("vector") ||
          n.includes("knowledge")
        );
      });
      const available = vectorTables.length > 0 ? vectorTables : allTables;
      setTables(available);

      // Check for separate embeddings table (elizaOS stores vectors there)
      const embTbl = allTables.find((t) => t.name === "embeddings");
      setHasEmbeddingsTable(!!embTbl);

      if (available.length > 0 && !selectedTable) {
        const preferred =
          available.find((t) => t.name.toLowerCase() === "memories") ??
          available.find((t) => t.name.toLowerCase().includes("memor"));
        setSelectedTable(preferred?.name ?? available[0].name);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      if (msg === "Failed to fetch" || msg.includes("fetch")) {
        setError("Cannot connect to database. Make sure the agent is running.");
      } else {
        setError(`Failed to load tables: ${msg}`);
      }
    }
  }, [selectedTable]);

  // Build a SELECT that casts any vector/embedding column to text so the raw
  // driver returns a parseable string instead of a binary blob.
  const buildSelect = useCallback(async (table: string): Promise<string> => {
    try {
      const colResult: QueryResult = await client.executeDatabaseQuery(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${table.replace(/'/g, "''")}' AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY ordinal_position`,
      );
      const cols = colResult.rows.map((r) => {
        const name = String(r.column_name);
        const dtype = String(r.data_type).toLowerCase();
        // Cast USER-DEFINED types (pgvector) and bytea to text
        if (
          dtype === "user-defined" ||
          dtype === "bytea" ||
          dtype === "vector"
        ) {
          return `"${name}"::text AS "${name}"`;
        }
        return `"${name}"`;
      });
      if (cols.length > 0) return cols.join(", ");
    } catch {
      // fall through to SELECT *
    }
    return "*";
  }, []);

  /**
   * Build a query that JOINs memories with the embeddings table when applicable.
   * The embeddings table stores vectors in dim_* columns (pgvector), which we
   * cast to ::text so the driver returns a parseable string.
   */
  const buildJoinQuery = useCallback(
    (opts: { where?: string; limit: number; offset?: number }): string => {
      const isMemories = selectedTable === "memories" && hasEmbeddingsTable;
      const { where, limit, offset } = opts;

      if (isMemories) {
        // Build dim column selects with ::text cast
        const dimCols = DIM_COLUMNS.map((d) => `e."${d}"::text AS "${d}"`).join(
          ", ",
        );
        return [
          `SELECT m.*, ${dimCols}`,
          `FROM "memories" m`,
          `LEFT JOIN "embeddings" e ON e."memory_id" = m."id"`,
          where ? `WHERE ${where}` : "",
          `ORDER BY m."created_at" DESC`,
          `LIMIT ${limit}`,
          offset ? `OFFSET ${offset}` : "",
        ]
          .filter(Boolean)
          .join(" ");
      }

      // For other tables, use buildSelect to cast any vector columns
      return ""; // signal to caller to use the old path
    },
    [selectedTable, hasEmbeddingsTable],
  );

  // Load memory records for list view
  const loadMemories = useCallback(async () => {
    if (!selectedTable) return;
    setLoading(true);
    setError("");
    try {
      const offset = page * PAGE_SIZE;
      const searchEscaped = search.replace(/'/g, "''");
      const countWhere = search
        ? ` WHERE "content"::text LIKE '%${searchEscaped}%'`
        : "";
      const joinWhere = search
        ? `m."content"::text LIKE '%${searchEscaped}%'`
        : undefined;

      const countResult: QueryResult = await client.executeDatabaseQuery(
        `SELECT COUNT(*) as cnt FROM "${selectedTable}"${countWhere}`,
      );
      const total = Number(countResult.rows[0]?.cnt ?? 0);
      setTotalCount(total);

      // Try JOIN path for memories + embeddings
      const joinSql = buildJoinQuery({
        where: joinWhere,
        limit: PAGE_SIZE,
        offset,
      });
      let result: QueryResult;

      if (joinSql) {
        result = await client.executeDatabaseQuery(joinSql);
      } else {
        const selectCols = await buildSelect(selectedTable);
        const plainWhere = search
          ? ` WHERE "content"::text LIKE '%${searchEscaped}%'`
          : "";
        result = await client.executeDatabaseQuery(
          `SELECT ${selectCols} FROM "${selectedTable}"${plainWhere} LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
        );
      }
      setMemories(result.rows.map(rowToMemory));

      // Stats on first load
      if (page === 0 && !search) {
        let dims = 0;
        let uniqueCount = 0;

        if (result.rows.length > 0) {
          const sample = rowToMemory(result.rows[0]);
          if (sample.embedding) dims = sample.embedding.length;
        }

        try {
          const uniqueResult: QueryResult = await client.executeDatabaseQuery(
            `SELECT COUNT(*) as cnt FROM "${selectedTable}" WHERE "unique" = true OR "unique" = 1`,
          );
          uniqueCount = Number(uniqueResult.rows[0]?.cnt ?? 0);
        } catch {
          // column might not exist
        }

        setStats({ total, dimensions: dims, uniqueCount });
      }
    } catch (err) {
      setError(
        `Failed to load memories: ${err instanceof Error ? err.message : "error"}`,
      );
    }
    setLoading(false);
  }, [selectedTable, page, search, buildSelect, buildJoinQuery]);

  // Load embeddings for graph view (fetch more rows to make graph useful)
  // Only include rows that actually have embeddings (INNER JOIN or filter).
  const loadGraphData = useCallback(async () => {
    if (!selectedTable) return;
    setGraphLoading(true);
    try {
      const isMemories = selectedTable === "memories" && hasEmbeddingsTable;
      let result: QueryResult;

      if (isMemories) {
        // INNER JOIN ensures only rows with embeddings are returned
        const dimCols = DIM_COLUMNS.map((d) => `e."${d}"::text AS "${d}"`).join(
          ", ",
        );
        result = await client.executeDatabaseQuery(
          `SELECT m.*, ${dimCols} FROM "memories" m INNER JOIN "embeddings" e ON e."memory_id" = m."id" ORDER BY m."created_at" DESC LIMIT 500`,
        );
      } else {
        const selectCols = await buildSelect(selectedTable);
        result = await client.executeDatabaseQuery(
          `SELECT ${selectCols} FROM "${selectedTable}" LIMIT 500`,
        );
      }
      setGraphMemories(result.rows.map(rowToMemory));
    } catch (err) {
      setError(
        `Failed to load graph data: ${err instanceof Error ? err.message : "error"}`,
      );
    }
    setGraphLoading(false);
  }, [selectedTable, buildSelect, hasEmbeddingsTable]);

  useEffect(() => {
    loadTables();
  }, [loadTables]);

  useEffect(() => {
    if (viewMode === "list") loadMemories();
  }, [loadMemories, viewMode]);

  useEffect(() => {
    if (viewMode === "graph" || viewMode === "3d") loadGraphData();
  }, [loadGraphData, viewMode]);

  const handleSearch = () => {
    setSearch(searchInput);
    setPage(0);
  };

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  // Show connection error state prominently
  const isConnectionError = error?.includes("agent is running");

  return (
    <div>
      {/* Stats bar */}
      {stats && !isConnectionError && (
        <div className="flex gap-4 mb-4 text-[11px] text-[var(--muted)]">
          <span>
            {Number(stats.total).toLocaleString()}{" "}
            {t("vectorbrowserview.memories")}
          </span>
          {Number(stats.uniqueCount) > 0 && (
            <span>
              {Number(stats.uniqueCount).toLocaleString()}{" "}
              {t("vectorbrowserview.unique")}
            </span>
          )}
          {Number(stats.dimensions) > 0 && (
            <span>
              {stats.dimensions} {t("vectorbrowserview.dimensions1")}
            </span>
          )}
        </div>
      )}

      {/* Toolbar - hide when not connected */}
      {!isConnectionError && (
        <div className="flex flex-wrap items-center gap-3 mb-4">
          {viewMode === "list" && (
            <div className="flex gap-1">
              <Input
                type="text"
                placeholder={t("vectorbrowserview.SearchContent")}
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                className="w-[220px] bg-card text-xs"
              />
              <Button variant="default" size="sm" onClick={handleSearch}>
                {t("vectorbrowserview.Search")}
              </Button>
            </div>
          )}

          {tables.length > 1 && (
            <select
              value={selectedTable}
              onChange={(e) => {
                setSelectedTable(e.target.value);
                setPage(0);
                setSearch("");
                setSearchInput("");
              }}
              className="px-2 py-1.5 border border-[var(--border)] bg-[var(--card)] text-[var(--txt)] text-xs"
            >
              {tables.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} (
                  {typeof t.rowCount === "object"
                    ? JSON.stringify(t.rowCount)
                    : t.rowCount}
                  )
                </option>
              ))}
            </select>
          )}

          {/* View mode toggle */}
          <div className="flex gap-1 ml-auto">
            <Button
              variant={viewMode === "list" ? "default" : "outline"}
              size="sm"
              onClick={() => setViewMode("list")}
            >
              {t("vectorbrowserview.List")}
            </Button>
            <Button
              variant={viewMode === "graph" ? "default" : "outline"}
              size="sm"
              onClick={() => setViewMode("graph")}
            >
              2D
            </Button>
            <Button
              variant={viewMode === "3d" ? "default" : "outline"}
              size="sm"
              onClick={() => setViewMode("3d")}
            >
              3D
            </Button>
          </div>

          {viewMode === "list" && (
            <span className="text-[11px] text-[var(--muted)]">
              {Number(totalCount) > 0
                ? `${page * PAGE_SIZE + 1}-${Math.min((page + 1) * PAGE_SIZE, Number(totalCount))} of ${Number(totalCount).toLocaleString()}`
                : ""}
            </span>
          )}
        </div>
      )}

      {error &&
        (error.includes("agent is running") ? (
          <div className="text-center py-16">
            <div className="text-[var(--muted)] text-sm mb-2">
              {t("vectorbrowserview.DatabaseNotAvailab")}
            </div>
            <div className="text-[var(--muted)] text-xs mb-4">
              {t("vectorbrowserview.StartTheAgentToB")}
            </div>
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                setError("");
                loadTables();
              }}
            >
              {t("vectorbrowserview.RetryConnection")}
            </Button>
          </div>
        ) : (
          <div className="p-2.5 border border-[var(--danger)] text-[var(--danger)] text-xs mb-3">
            {error}
          </div>
        ))}

      {/* 2D Graph view */}
      {viewMode === "graph" &&
        (graphLoading ? (
          <div className="text-center py-16 text-[var(--muted)] text-sm italic">
            {t("vectorbrowserview.LoadingEmbeddings")}
          </div>
        ) : (
          <VectorGraph memories={graphMemories} onSelect={setSelectedMemory} />
        ))}

      {/* 3D Graph view */}
      {viewMode === "3d" &&
        (graphLoading ? (
          <div className="text-center py-16 text-[var(--muted)] text-sm italic">
            {t("vectorbrowserview.LoadingEmbeddings")}
          </div>
        ) : (
          <VectorGraph3D
            memories={graphMemories}
            onSelect={setSelectedMemory}
          />
        ))}

      {/* List view */}
      {viewMode === "list" &&
        (loading ? (
          <div className="text-center py-16 text-[var(--muted)] text-sm italic">
            {t("vectorbrowserview.LoadingMemories")}
          </div>
        ) : memories.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-[var(--muted)] text-sm mb-2">
              {t("vectorbrowserview.NoMemoriesFound")}
            </div>
            <div className="text-[var(--muted)] text-xs">
              {search
                ? "No records match your search query."
                : "No memory records detected in the database."}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {memories.map((mem) => (
              <Button
                key={mem.id || `${mem.content.slice(0, 30)}-${mem.createdAt}`}
                variant="outline"
                className="justify-start items-start text-left h-auto p-3 hover:border-accent w-full flex flex-col"
                onClick={() => setSelectedMemory(mem)}
              >
                {/* Content preview */}
                <div className="text-xs text-[var(--txt)] mb-2 whitespace-pre-wrap break-words">
                  {mem.content.length > 200
                    ? `${mem.content.slice(0, 200)}...`
                    : mem.content}
                </div>

                {/* Metadata row */}
                <div className="flex flex-wrap items-center gap-3 text-[10px] text-[var(--muted)]">
                  {mem.type && mem.type !== "undefined" && (
                    <span className="px-1.5 py-0.5 bg-[var(--accent)]/10 text-[var(--accent)]">
                      {mem.type}
                    </span>
                  )}
                  {mem.roomId && mem.roomId !== "undefined" && (
                    <span>
                      {t("vectorbrowserview.Room1")} {mem.roomId.slice(0, 12)}
                    </span>
                  )}
                  {mem.entityId && mem.entityId !== "undefined" && (
                    <span>
                      {t("vectorbrowserview.Entity1")}{" "}
                      {mem.entityId.slice(0, 12)}
                    </span>
                  )}
                  {mem.createdAt && mem.createdAt !== "undefined" && (
                    <span>{mem.createdAt}</span>
                  )}
                  {mem.unique && (
                    <span className="px-1.5 py-0.5 bg-green-500/20 text-green-400 font-bold">
                      {t("vectorbrowserview.unique")}
                    </span>
                  )}
                  {mem.embedding && (
                    <span className="font-mono">[{mem.embedding.length}d]</span>
                  )}
                </div>
              </Button>
            ))}
          </div>
        ))}

      {/* Pagination (list view only) */}
      {viewMode === "list" && totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-4 pb-4">
          <Button
            variant="default"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            {t("vectorbrowserview.Prev")}
          </Button>
          <span className="text-[11px] text-[var(--muted)]">
            {t("vectorbrowserview.Page")} {page + 1} of {totalPages}
          </span>
          <Button
            variant="default"
            size="sm"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            {t("vectorbrowserview.Next")}
          </Button>
        </div>
      )}

      {/* Detail modal */}
      {selectedMemory && (
        <MemoryDetailModal
          memory={selectedMemory}
          onClose={() => setSelectedMemory(null)}
        />
      )}
    </div>
  );
}
