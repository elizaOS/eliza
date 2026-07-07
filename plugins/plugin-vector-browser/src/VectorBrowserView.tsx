import { useAgentElement } from "@elizaos/ui/agent-surface";
import { client, type QueryResult, type TableInfo } from "@elizaos/ui/api";
import { PagePanel } from "@elizaos/ui/components/composites/page-panel";
import { MemoryDetailPanel } from "@elizaos/ui/components/pages/MemoryDetailPanel";
import {
  buildVectorGraph2DLayout,
  DIM_COLUMNS,
  hasEmbedding,
  MAX_THREE_PIXEL_RATIO,
  type MemoryRecord,
  PAGE_SIZE,
  projectTo3D,
  rowToMemory,
  toVectorGraph2DScreenX,
  toVectorGraph2DScreenY,
  type ViewMode,
} from "@elizaos/ui/components/pages/vector-browser-utils";
import { Button } from "@elizaos/ui/components/ui/button";
import { Input } from "@elizaos/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/ui/components/ui/select";
import { ListSkeleton } from "@elizaos/ui/components/ui/skeleton-layouts";
import { getBootConfig } from "@elizaos/ui/config";
import { useRenderGuard } from "@elizaos/ui/hooks";
import { WorkspaceLayout } from "@elizaos/ui/layouts";
import { Escape } from "@elizaos/ui/spatial";
import { useAppSelector } from "@elizaos/ui/state";
import { Clock3, Database, Hash, Layers3 } from "lucide-react";
import type { ReactNode } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type * as Three from "three";
import {
  type VectorBrowserSnapshot,
  VectorBrowserSpatialView,
} from "./VectorBrowserSpatialView.tsx";

type VectorBrowserRuntime = {
  THREE: typeof Three;
  createVectorBrowserRenderer: () => Promise<Three.WebGLRenderer>;
};

// Derive the boot-config type from getBootConfig's return rather than importing
// the `AppBootConfig` type name: it is re-exported from @elizaos/ui/config only
// through a multi-hop `export *` chain that tsgo does not resolve as a type
// member, while the value export (getBootConfig) resolves fine. ReturnType is
// the same type and immune to the chain quirk.
type AppBootConfig = ReturnType<typeof getBootConfig>;

type VectorBrowserBootConfig = AppBootConfig & {
  companionVectorBrowser?: VectorBrowserRuntime;
};

function resolveConfiguredVectorBrowserRuntime(): VectorBrowserRuntime | null {
  const runtime = (getBootConfig() as VectorBrowserBootConfig)
    .companionVectorBrowser;
  if (!runtime) {
    return null;
  }
  return runtime;
}

let defaultVectorBrowserRuntimePromise: Promise<VectorBrowserRuntime> | null =
  null;

function getDefaultVectorBrowserRuntime(): Promise<VectorBrowserRuntime> {
  defaultVectorBrowserRuntimePromise ??= (async () => {
    const THREE = await import("three");
    return {
      THREE,
      createVectorBrowserRenderer: async () => {
        try {
          if (
            typeof navigator !== "undefined" &&
            "gpu" in navigator &&
            navigator.gpu
          ) {
            const webgpuModule = (await import("three/webgpu")) as Record<
              string,
              unknown
            >;
            const WebGPURenderer = webgpuModule.WebGPURenderer as
              | (new (options: {
                  antialias?: boolean;
                }) => Three.WebGLRenderer & { init?: () => Promise<void> })
              | undefined;
            if (WebGPURenderer) {
              const renderer = new WebGPURenderer({ antialias: true });
              if (typeof renderer.init === "function") {
                await renderer.init();
              }
              return renderer;
            }
          }
        } catch {
          // Fall back to WebGL below.
        }
        return new THREE.WebGLRenderer({ antialias: true });
      },
    };
  })();
  return defaultVectorBrowserRuntimePromise;
}

function formatMemoryDate(value: string | null | undefined): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 16);
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function VectorMetric({
  icon,
  value,
  label,
  tone,
}: {
  icon: ReactNode;
  value: string;
  label: string;
  tone: "accent" | "neutral";
}) {
  return (
    <div className="flex min-h-12 items-center gap-2 px-1">
      <span
        className={`shrink-0 ${tone === "accent" ? "text-accent" : "text-muted"}`}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-txt">
          {value}
        </span>
        <span className="block truncate text-xs text-muted">{label}</span>
      </span>
    </div>
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
  const t = useAppSelector((s) => s.t);
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
    const bgColor = style.getPropertyValue("--bg").trim() || "#eef8ff";
    const cardColor = style.getPropertyValue("--card").trim() || bgColor;
    const borderColor = style.getPropertyValue("--border").trim() || "#e2e8f0";
    const accentColor = style.getPropertyValue("--accent").trim() || "#ff8a24";
    const mutedColor = style.getPropertyValue("--muted").trim() || "#888888";
    const textColor =
      style.getPropertyValue("--text").trim() ||
      style.getPropertyValue("--txt").trim() ||
      "#f5f5f5";

    ctx.fillStyle = cardColor;
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
    ctx.font = '10px "Poppins", Arial, system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.fillText("PC1", W / 2, H - 8);
    ctx.save();
    ctx.translate(12, H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("PC2", 0, 0);
    ctx.restore();
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
        ctx.strokeStyle = textColor;
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

      ctx.fillStyle = cardColor;
      ctx.fillRect(tx, ty, tw, th);
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(tx, ty, tw, th);
      ctx.fillStyle = textColor;
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
        <div className="text-muted text-sm mb-2">
          {t("vectorbrowserview.NotEnoughEmbedding")}
        </div>
        <div className="text-muted text-xs">
          {t("vectorbrowserview.NeedAtLeast2Memo")} {withEmbeddings.length}.
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full">
      <div className="text-xs-tight text-muted mb-2">
        {graph.withEmbeddings.length}{" "}
        {t("vectorbrowserview.vectorsProjectedTo")}
      </div>
      <canvas
        ref={canvasRef}
        className="w-full cursor-crosshair"
        style={{ height: 500 }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredIdx(null)}
        onClick={handleClick}
      />
    </div>
  );
}

// ── 3D Graph sub-component (Three.js) ──────────────────────────────────

export function VectorGraph3D({
  memories,
  onSelect,
  createRenderer,
}: {
  memories: MemoryRecord[];
  onSelect: (mem: MemoryRecord) => void;
  createRenderer?: () => Promise<Three.WebGLRenderer>;
}) {
  const t = useAppSelector((s) => s.t);
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Three.WebGLRenderer | null>(null);
  const sceneRef = useRef<Three.Scene | null>(null);
  const cameraRef = useRef<Three.PerspectiveCamera | null>(null);
  const spheresRef = useRef<Three.Mesh[]>([]);
  const animationRef = useRef<number>(0);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [rendererUnavailable, setRendererUnavailable] = useState(false);
  const isDraggingRef = useRef(false);
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const configuredVectorRuntime = useMemo(
    resolveConfiguredVectorBrowserRuntime,
    [],
  );

  const withEmbeddings = useMemo(
    () => memories.filter(hasEmbedding),
    [memories],
  );

  const points3D = useMemo(() => {
    if (withEmbeddings.length < 2) return [];
    const vecs = withEmbeddings.map((m) => m.embedding);
    return projectTo3D(vecs);
  }, [withEmbeddings]);

  // Per-type colors as an on-brand orange→neutral ramp (no decorative hues).
  // First type is full brand orange; the rest step down through dimmed orange
  // and neutral grays so categories stay distinguishable without going off-brand.
  const typeColors = useMemo(() => {
    const types = [...new Set(withEmbeddings.map((m) => m.type))];
    const ramp = [0xff8a24, 0xc26a1d, 0x8a8a8a, 0x6b6b6b, 0x4f4f4f, 0x3a3a3a];
    const map: Record<string, number> = {};
    types.forEach((t, i) => {
      map[t] = ramp[i % ramp.length];
    });
    return map;
  }, [withEmbeddings]);

  // Initialize Three.js scene
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || points3D.length === 0) return;

    let cancelled = false;
    cleanupRef.current = null;
    setRendererUnavailable(false);

    // Async renderer creation — tries WebGPU, falls back to WebGL.
    // All scene setup runs inside this async IIFE so the useEffect callback
    // itself remains synchronous (required for React cleanup return).
    void (async () => {
      let vectorRuntime: VectorBrowserRuntime;
      try {
        vectorRuntime =
          configuredVectorRuntime ?? (await getDefaultVectorBrowserRuntime());
      } catch {
        if (!cancelled) {
          setRendererUnavailable(true);
        }
        return;
      }
      if (cancelled) return;

      const THREE = vectorRuntime.THREE;
      const resolvedCreateRenderer =
        createRenderer ?? vectorRuntime.createVectorBrowserRenderer;
      const W = container.clientWidth;
      const H = 550;

      // Scene
      const scene = new THREE.Scene();
      const bgColor =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--bg")
          .trim() || "#eef8ff";
      scene.background = new THREE.Color(bgColor);
      sceneRef.current = scene;

      // Camera
      const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 1000);
      camera.position.set(0, 0, 5);
      cameraRef.current = camera;

      let renderer: Three.WebGLRenderer;
      try {
        renderer = await resolvedCreateRenderer();
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
      const spheres: Three.Mesh[] = [];
      let gridHelper: Three.GridHelper | null = null;
      let axisGeom: Three.BufferGeometry | null = null;
      let axisMat: Three.LineBasicMaterial | null = null;
      let onMouseDown: ((e: MouseEvent) => void) | null = null;
      let onMouseUp: (() => void) | null = null;
      let onMouseMove: ((e: MouseEvent) => void) | null = null;
      let onClick: ((e: MouseEvent) => void) | null = null;
      let onWheel: ((e: WheelEvent) => void) | null = null;
      let onMouseLeave: (() => void) | null = null;
      let handleResize: (() => void) | null = null;
      let visibilityHandler: (() => void) | null = null;
      let cleanedUp = false;
      let rafActive =
        typeof document === "undefined" ||
        document.visibilityState === "visible";

      cleanupRef.current = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        cancelAnimationFrame(animationRef.current);
        if (handleResize) {
          window.removeEventListener("resize", handleResize);
        }
        if (visibilityHandler) {
          document.removeEventListener("visibilitychange", visibilityHandler);
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
        const color = typeColors[mem.type] ?? 0xff8a24;
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
      const borderColor3d =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--border")
          .trim() || "#333333";
      const borderColorHex = new THREE.Color(borderColor3d).getHex();
      gridHelper = new THREE.GridHelper(
        6,
        12,
        borderColorHex,
        Math.round(borderColorHex * 0.6),
      );
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
        const rect = updatePointerFromEvent(e);
        raycaster.setFromCamera(pointer, camera);
        const intersects = raycaster.intersectObjects(spheres);

        if (intersects.length > 0) {
          const idx = intersects[0].object.userData.index;
          setHoveredIdx(idx);
          setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
          spheres.forEach((s, i) => {
            const mat = s.material as Three.MeshBasicMaterial;
            mat.opacity = i === idx ? 1 : 0.5;
            s.scale.setScalar(i === idx ? 1.5 : 1);
          });
        } else {
          setHoveredIdx(null);
          setTooltipPos(null);
          spheres.forEach((s) => {
            const mat = s.material as Three.MeshBasicMaterial;
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

      // Animation loop — pause while tab is hidden to save GPU.
      const animate = () => {
        if (!rafActive || cleanedUp) return;
        updateCamera();
        renderer.render(scene, camera);
        animationRef.current = requestAnimationFrame(animate);
      };
      visibilityHandler = () => {
        if (document.visibilityState === "hidden") {
          rafActive = false;
          cancelAnimationFrame(animationRef.current);
          animationRef.current = 0;
        } else {
          rafActive = true;
          animationRef.current = requestAnimationFrame(animate);
        }
      };
      document.addEventListener("visibilitychange", visibilityHandler);
      if (rafActive) {
        animate();
      }

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
  }, [
    configuredVectorRuntime,
    createRenderer,
    points3D,
    withEmbeddings,
    typeColors,
    onSelect,
  ]);

  if (withEmbeddings.length < 2) {
    return (
      <div className="text-center py-16">
        <div className="text-muted text-sm mb-2">
          {t("vectorbrowserview.NotEnoughEmbedding1")}
        </div>
        <div className="text-muted text-xs">
          {t("vectorbrowserview.NeedAtLeast2Memo")} {withEmbeddings.length}.
        </div>
      </div>
    );
  }

  if (rendererUnavailable) {
    return (
      <div className="px-4 py-10 text-center">
        <div className="text-sm text-txt">
          {t("vectorbrowserview.RendererUnavailable", {
            defaultValue: "Unavailable",
          })}
        </div>
        <div className="sr-only mt-2 text-xs text-muted">
          {t("vectorbrowserview.RendererUnavailableDescription", {
            defaultValue:
              "The current runtime could not initialize a renderer.",
          })}
        </div>
      </div>
    );
  }

  const hoveredMem = hoveredIdx !== null ? withEmbeddings[hoveredIdx] : null;

  return (
    <div className="relative">
      <div className="text-xs-tight text-muted mb-2">
        {withEmbeddings.length} {t("vectorbrowserview.vectorsProjectedTo1")}
      </div>
      <div
        ref={containerRef}
        className="w-full cursor-grab active:cursor-grabbing"
        style={{ height: 550 }}
      />
      {/* Tooltip */}
      {hoveredMem && tooltipPos && (
        <div
          className="pointer-events-none absolute z-10 max-w-[300px] bg-bg/95 px-3 py-2 text-txt text-xs-tight backdrop-blur-sm"
          style={{
            left: tooltipPos.x + 15,
            top: tooltipPos.y + 15,
            transform: tooltipPos.x > 400 ? "translateX(-100%)" : undefined,
          }}
        >
          <div className="font-medium mb-1 truncate">
            {hoveredMem.type && hoveredMem.type !== "undefined" && (
              <span className="mr-2 px-1.5 py-0.5 text-2xs text-accent">
                {hoveredMem.type}
              </span>
            )}
            {hoveredMem.id.slice(0, 12)}...
          </div>
          <div className="text-muted line-clamp-3">
            {hoveredMem.content.slice(0, 150)}
            {hoveredMem.content.length > 150 ? "..." : ""}
          </div>
        </div>
      )}
      {/* Legend */}
      <div className="flex flex-wrap gap-3 mt-2 text-2xs">
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
                <span className="text-muted">{type}</span>
              </div>
            ),
        )}
      </div>
    </div>
  );
}

// ── Rich GUI/XR surface (the Escape child) ─────────────────────────────

export function VectorBrowserRichView({
  leftNav,
  contentHeader,
}: {
  leftNav?: ReactNode;
  contentHeader?: ReactNode;
}) {
  useRenderGuard("VectorBrowserRichView");
  const t = useAppSelector((s) => s.t);
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
  // Presentation-only flag: which face of the single column is showing in list
  // mode — the master record list (false) or the selected record's detail
  // (true). Keeps the column to one pane at a time instead of master+detail.
  const [detailOpen, setDetailOpen] = useState(false);
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
      const { tables: rawTables } = await client.getDatabaseTables();
      const allTables = Array.isArray(rawTables) ? rawTables : [];
      const vectorTables = allTables.filter((t) => {
        const n = t.name.toLowerCase();
        return (
          n.includes("memor") ||
          n.includes("embed") ||
          n.includes("vector") ||
          n.includes("document")
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
        setError(
          t("vectorbrowserview.DatabaseConnectionError", {
            defaultValue:
              "Cannot connect to database. Make sure the agent is running.",
          }),
        );
      } else {
        setError(
          t("databaseview.FailedToLoadTables", {
            message: msg,
            defaultValue: "Failed to load tables: {{message}}",
          }),
        );
      }
    }
  }, [selectedTable, t]);

  // Build a SELECT that casts any vector/embedding column to text so the raw
  // driver returns a parseable string instead of a binary blob.
  const buildSelect = useCallback(async (table: string): Promise<string> => {
    try {
      const colResult: QueryResult = await client.executeDatabaseQuery(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${table.replace(/'/g, "''")}' AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY ordinal_position`,
      );
      const rows = Array.isArray(colResult.rows) ? colResult.rows : [];
      const cols = rows.map((r) => {
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
      const countRows = Array.isArray(countResult.rows) ? countResult.rows : [];
      const total = Number(countRows[0]?.cnt ?? 0);
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
      const rows = Array.isArray(result.rows) ? result.rows : [];
      setMemories(rows.map(rowToMemory));

      // Stats on first load
      if (page === 0 && !search) {
        let dims = 0;
        let uniqueCount = 0;

        if (rows.length > 0) {
          const sample = rowToMemory(rows[0]);
          if (sample.embedding) dims = sample.embedding.length;
        }

        try {
          const uniqueResult: QueryResult = await client.executeDatabaseQuery(
            `SELECT COUNT(*) as cnt FROM "${selectedTable}" WHERE "unique" = true OR "unique" = 1`,
          );
          const uniqueRows = Array.isArray(uniqueResult.rows)
            ? uniqueResult.rows
            : [];
          uniqueCount = Number(uniqueRows[0]?.cnt ?? 0);
        } catch {
          // column might not exist
        }

        setStats({ total, dimensions: dims, uniqueCount });
      }
    } catch (err) {
      setError(
        t("vectorbrowserview.LoadFailed", {
          message: err instanceof Error ? err.message : "error",
          defaultValue: "Failed to load memories: {{message}}",
        }),
      );
    }
    setLoading(false);
  }, [buildJoinQuery, buildSelect, page, search, selectedTable, t]);

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
      const rows = Array.isArray(result.rows) ? result.rows : [];
      setGraphMemories(rows.map(rowToMemory));
    } catch (err) {
      setError(
        t("vectorbrowserview.GraphLoadFailed", {
          message: err instanceof Error ? err.message : "error",
          defaultValue: "Failed to load graph data: {{message}}",
        }),
      );
    }
    setGraphLoading(false);
  }, [buildSelect, hasEmbeddingsTable, selectedTable, t]);

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

  useEffect(() => {
    if (viewMode !== "list") return;
    if (memories.length === 0) {
      setSelectedMemory(null);
      return;
    }
    if (
      !selectedMemory ||
      !memories.some((memory) => memory.id === selectedMemory.id)
    ) {
      setSelectedMemory(memories[0]);
    }
  }, [memories, selectedMemory, viewMode]);

  // Leaving list mode collapses the detail face so returning lands on the list.
  useEffect(() => {
    if (viewMode !== "list") setDetailOpen(false);
  }, [viewMode]);

  // Show connection error state prominently
  const isConnectionError = error?.includes("agent is running");

  const tableSelect = useAgentElement<HTMLButtonElement>({
    id: "vector-table",
    role: "select",
    label: t("common.vectors", { defaultValue: "Vectors" }),
    group: "vector-browser-toolbar",
    description: "Select which vector/memory table to browse",
    getValue: () => selectedTable,
    options: tables.map((table) => table.name),
    onFill: (value) => {
      setSelectedTable(value);
      setPage(0);
      setSearch("");
      setSearchInput("");
      setSelectedMemory(null);
    },
  });

  const listTab = useAgentElement<HTMLButtonElement>({
    id: "vector-view-list",
    role: "tab",
    label: t("vectorbrowserview.List"),
    group: "vector-browser-views",
    status: viewMode === "list" ? "active" : "inactive",
    description: "Show vectors as a list",
    onActivate: () => setViewMode("list"),
  });

  const graph2dTab = useAgentElement<HTMLButtonElement>({
    id: "vector-view-2d",
    role: "tab",
    label: t("vectorbrowserview.2D", { defaultValue: "2D" }),
    group: "vector-browser-views",
    status: viewMode === "graph" ? "active" : "inactive",
    description: "Show vectors as a 2D projection graph",
    onActivate: () => setViewMode("graph"),
  });

  const graph3dTab = useAgentElement<HTMLButtonElement>({
    id: "vector-view-3d",
    role: "tab",
    label: t("vectorbrowserview.3D", { defaultValue: "3D" }),
    group: "vector-browser-views",
    status: viewMode === "3d" ? "active" : "inactive",
    description: "Show vectors as a 3D projection graph",
    onActivate: () => setViewMode("3d"),
  });

  const searchField = useAgentElement<HTMLInputElement>({
    id: "vector-search",
    role: "text-input",
    label: t("vectorbrowserview.SearchContent"),
    group: "vector-browser-toolbar",
    description: "Search memory content",
    getValue: () => searchInput,
    onFill: (value) => setSearchInput(value),
  });

  const searchButton = useAgentElement<HTMLButtonElement>({
    id: "vector-search-run",
    role: "button",
    label: t("common.search"),
    group: "vector-browser-toolbar",
    description: "Run the content search",
    onActivate: handleSearch,
  });

  const prevPageButton = useAgentElement<HTMLButtonElement>({
    id: "vector-page-prev",
    role: "button",
    label: t("common.prev"),
    group: "vector-browser-pagination",
    description: "Go to the previous page of memories",
    onActivate: () => setPage((p) => p - 1),
  });

  const nextPageButton = useAgentElement<HTMLButtonElement>({
    id: "vector-page-next",
    role: "button",
    label: t("common.next"),
    group: "vector-browser-pagination",
    description: "Go to the next page of memories",
    onActivate: () => setPage((p) => p + 1),
  });

  const retryButton = useAgentElement<HTMLButtonElement>({
    id: "vector-retry-connection",
    role: "button",
    label: t("vectorbrowserview.RetryConnection"),
    group: "vector-browser-toolbar",
    description: "Retry connecting to the database",
    onActivate: () => {
      setError("");
      loadTables();
    },
  });

  // Selecting a record in list mode swaps the single column over to its detail.
  const openDetail = (mem: MemoryRecord) => {
    setSelectedMemory(mem);
    setDetailOpen(true);
  };

  const summaryHeader = (
    <div className="flex flex-col gap-2">
      {leftNav}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 truncate text-base font-semibold text-txt">
          {selectedTable ||
            t("common.vectors", {
              defaultValue: "Vectors",
            })}
        </div>
        {stats ? (
          <div className="text-xs text-muted">
            {Number(stats.total).toLocaleString()}{" "}
            {t("vectorbrowserview.memories")}
          </div>
        ) : null}
      </div>
    </div>
  );

  const toolbar = (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
        {tables.length > 1 && (
          <Select
            value={selectedTable}
            onValueChange={(value: string) => {
              setSelectedTable(value);
              setPage(0);
              setSearch("");
              setSearchInput("");
              setSelectedMemory(null);
              setDetailOpen(false);
            }}
          >
            <SelectTrigger
              ref={(node) => {
                tableSelect.ref.current = node as HTMLButtonElement | null;
              }}
              {...tableSelect.agentProps}
              className="h-9 w-full border-border bg-transparent px-2.5 py-1.5 text-xs transition-[border-color,box-shadow,background-color] focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {tables.map((table) => (
                <SelectItem key={table.name} value={table.name}>
                  {table.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <div className="inline-flex w-full gap-1 md:w-auto">
          <Button
            ref={listTab.ref}
            {...listTab.agentProps}
            aria-current={viewMode === "list" ? "true" : undefined}
            variant="ghost"
            size="sm"
            className={`h-auto min-h-[1.75rem] flex-1 px-3 py-1 text-xs font-medium transition-all duration-300 md:flex-none ${
              viewMode === "list"
                ? "text-accent "
                : "text-muted-strong hover:text-txt"
            }`}
            onClick={() => setViewMode("list")}
          >
            {t("vectorbrowserview.List")}
          </Button>
          <Button
            ref={graph2dTab.ref}
            {...graph2dTab.agentProps}
            aria-current={viewMode === "graph" ? "true" : undefined}
            variant="ghost"
            size="sm"
            className={`h-auto min-h-[1.75rem] flex-1 px-3 py-1 text-xs font-medium transition-all duration-300 md:flex-none ${
              viewMode === "graph"
                ? "text-accent "
                : "text-muted-strong hover:text-txt"
            }`}
            onClick={() => setViewMode("graph")}
          >
            {t("vectorbrowserview.2D", { defaultValue: "2D" })}
          </Button>
          <Button
            ref={graph3dTab.ref}
            {...graph3dTab.agentProps}
            aria-current={viewMode === "3d" ? "true" : undefined}
            variant="ghost"
            size="sm"
            className={`h-auto min-h-[1.75rem] flex-1 px-3 py-1 text-xs font-medium transition-all duration-300 md:flex-none ${
              viewMode === "3d"
                ? "text-accent "
                : "text-muted-strong hover:text-txt"
            }`}
            onClick={() => setViewMode("3d")}
          >
            {t("vectorbrowserview.3D", { defaultValue: "3D" })}
          </Button>
        </div>
      </div>

      {viewMode === "list" ? (
        <div className="flex gap-1.5">
          <Input
            ref={searchField.ref}
            {...searchField.agentProps}
            type="search"
            placeholder={t("vectorbrowserview.SearchContent")}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="h-10 min-w-0 flex-1 border-border/60 bg-transparent px-3 py-2 text-sm placeholder:text-muted/65 transition-[border-color,box-shadow,background-color] focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent"
          />
          <Button
            ref={searchButton.ref}
            {...searchButton.agentProps}
            variant="outline"
            size="sm"
            onClick={handleSearch}
          >
            {t("common.search")}
          </Button>
        </div>
      ) : null}

      {stats ? (
        <div className="grid grid-cols-3 gap-2">
          <VectorMetric
            icon={<Database className="h-3.5 w-3.5" aria-hidden />}
            value={Number(stats.total).toLocaleString()}
            label={t("vectorbrowserview.memories")}
            tone="accent"
          />
          <VectorMetric
            icon={<Layers3 className="h-3.5 w-3.5" aria-hidden />}
            value={
              Number(stats.dimensions) > 0
                ? `${Number(stats.dimensions).toLocaleString()}D`
                : "—"
            }
            label="embed"
            tone="neutral"
          />
          <VectorMetric
            icon={<Hash className="h-3.5 w-3.5" aria-hidden />}
            value={Number(stats.uniqueCount).toLocaleString()}
            label={t("vectorbrowserview.unique")}
            tone="neutral"
          />
        </div>
      ) : null}
    </div>
  );

  const masterList = (
    <div className="flex flex-col gap-1.5">
      {loading ? (
        <div className="px-4 py-10 text-center text-sm text-muted">
          {t("vectorbrowserview.LoadingMemories")}
        </div>
      ) : memories.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted">
          {search
            ? t("vectorbrowserview.NoRecordsMatchSearchQuery", {
                defaultValue: "None",
              })
            : t("vectorbrowserview.NoMemoryRecordsDetected", {
                defaultValue: "None",
              })}
        </div>
      ) : (
        memories.map((mem) => {
          const isActive = selectedMemory?.id === mem.id;
          const createdLabel = formatMemoryDate(mem.createdAt);
          return (
            <button
              type="button"
              key={mem.id || `${mem.content.slice(0, 30)}-${mem.createdAt}`}
              onClick={() => openDetail(mem)}
              className={`flex w-full items-center gap-3 px-2 py-2 text-left transition-colors ${
                isActive ? "bg-accent/12 text-txt" : "hover:bg-bg-hover"
              }`}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center text-xs font-semibold uppercase text-muted">
                {mem.type && mem.type !== "undefined"
                  ? mem.type.slice(0, 1)
                  : "M"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-1 block text-sm font-medium text-txt">
                  {mem.content || "(empty)"}
                </span>
                <span className="mt-1 flex flex-wrap gap-1.5 text-2xs text-muted">
                  {mem.embedding ? (
                    <span className="inline-flex items-center gap-1 px-1 py-0.5">
                      <Layers3 className="h-3 w-3" aria-hidden />
                      {mem.embedding.length}D
                    </span>
                  ) : null}
                  {createdLabel ? (
                    <span className="inline-flex items-center gap-1 px-1 py-0.5">
                      <Clock3 className="h-3 w-3" aria-hidden />
                      {createdLabel}
                    </span>
                  ) : null}
                </span>
              </span>
            </button>
          );
        })
      )}

      {totalPages > 1 ? (
        <div className="mt-3 flex items-center justify-between gap-2 pt-3">
          <Button
            ref={prevPageButton.ref}
            {...prevPageButton.agentProps}
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            {t("common.prev")}
          </Button>
          <span className="text-xs-tight text-muted">
            {t("vectorbrowserview.Page")} {page + 1} / {totalPages}
          </span>
          <Button
            ref={nextPageButton.ref}
            {...nextPageButton.agentProps}
            variant="outline"
            size="sm"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            {t("common.next")}
          </Button>
        </div>
      ) : null}
    </div>
  );

  let mainSection: ReactNode;
  if (viewMode === "graph") {
    mainSection = (
      <>
        <PagePanel variant="inset" className="p-3">
          {graphLoading ? (
            <ListSkeleton rows={5} rowClassName="h-16" />
          ) : (
            <VectorGraph
              memories={graphMemories}
              onSelect={setSelectedMemory}
            />
          )}
        </PagePanel>
        <div className="max-h-[42vh] min-h-[14rem] overflow-auto">
          <MemoryDetailPanel memory={selectedMemory} />
        </div>
      </>
    );
  } else if (viewMode === "3d") {
    mainSection = (
      <>
        <PagePanel variant="inset" className="p-3">
          {graphLoading ? (
            <ListSkeleton rows={5} rowClassName="h-16" />
          ) : (
            <VectorGraph3D
              memories={graphMemories}
              onSelect={setSelectedMemory}
            />
          )}
        </PagePanel>
        <div className="max-h-[42vh] min-h-[14rem] overflow-auto">
          <MemoryDetailPanel memory={selectedMemory} />
        </div>
      </>
    );
  } else if (detailOpen && selectedMemory) {
    mainSection = (
      <>
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDetailOpen(false)}
          >
            {t("vectorbrowserview.BackToList", {
              defaultValue: "← Back to list",
            })}
          </Button>
        </div>
        <div className="max-h-[70vh] min-h-[14rem] overflow-auto">
          <MemoryDetailPanel memory={selectedMemory} />
        </div>
      </>
    );
  } else {
    mainSection = masterList;
  }

  return (
    <WorkspaceLayout contentHeader={contentHeader} contentPadding={false}>
      {isConnectionError ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="px-8 py-10 text-center">
            <div className="text-base font-semibold text-txt">
              {t("databaseview.DatabaseNotAvailab")}
            </div>
            <div className="sr-only mt-2 max-w-sm text-sm text-muted">
              {t("vectorbrowserview.StartTheAgentToB")}
            </div>
            <Button
              ref={retryButton.ref}
              {...retryButton.agentProps}
              variant="default"
              size="sm"
              className="mt-5"
              onClick={() => {
                setError("");
                loadTables();
              }}
            >
              {t("vectorbrowserview.RetryConnection")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 pb-32 pt-4 md:px-6 md:pb-36 md:pt-6">
          {summaryHeader}
          {toolbar}
          {error ? (
            <div className="px-1 py-2 text-sm text-danger">{error}</div>
          ) : null}
          {mainSection}
        </div>
      )}
    </WorkspaceLayout>
  );
}

// ── Adaptive view (the single componentExport) ─────────────────────────

/**
 * Summary snapshot used as the wrapper's `Escape` fallback when the rich
 * three.js/canvas surface cannot render; carries the zeroed default + the
 * "renders in GUI/XR" note.
 */
const TUI_FALLBACK_SNAPSHOT: VectorBrowserSnapshot = {
  vectorCount: 0,
  withEmbeddings: 0,
  dimension: 0,
  typeCount: 0,
  points: [],
};

/**
 * The single adaptive vector-browser view (`componentExport`).
 *
 * GUI/XR render the full rich {@link VectorBrowserRichView} (three.js 3D point
 * cloud + 2D canvas projection + list/detail) as the {@link Escape} DOM child;
 * TUI renders the spatial {@link VectorBrowserSpatialView} summary fallback. One
 * registered component, no separate rich-DOM app — `SpatialSurface` auto-detects
 * GUI vs XR.
 */
export function VectorBrowserView(props: {
  leftNav?: ReactNode;
  contentHeader?: ReactNode;
}) {
  return (
    <Escape tui={<VectorBrowserSpatialView snapshot={TUI_FALLBACK_SNAPSHOT} />}>
      <VectorBrowserRichView {...props} />
    </Escape>
  );
}
