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
import { client, type QueryResult, type TableInfo } from "../../api";
import { getBootConfig } from "../../config/boot-config";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { PageLayout } from "../../layouts/page-layout/page-layout";
import { useApp } from "../../state";
import { PagePanel } from "../composites/page-panel";
import { MetaPill } from "../composites/page-panel/page-panel-header";
import { SidebarContent } from "../composites/sidebar/sidebar-content";
import { SidebarPanel } from "../composites/sidebar/sidebar-panel";
import { SidebarScrollRegion } from "../composites/sidebar/sidebar-scroll-region";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { MemoryDetailPanel } from "./MemoryDetailPanel";
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
} from "./vector-browser-utils";

type VectorBrowserRuntime = {
  THREE: typeof Three;
  createVectorBrowserRenderer: () => Promise<Three.WebGLRenderer>;
};

function resolveVectorBrowserRuntime(): VectorBrowserRuntime {
  const runtime = getBootConfig().companionVectorBrowser;
  if (!runtime) {
    throw new Error("Vector browser runtime is not registered in boot config.");
  }
  return runtime as VectorBrowserRuntime;
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
    const bgColor = style.getPropertyValue("--bg").trim() || "#111111";
    const cardColor = style.getPropertyValue("--card").trim() || bgColor;
    const borderColor = style.getPropertyValue("--border").trim() || "#333333";
    const accentColor = style.getPropertyValue("--accent").trim() || "#6cf";
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
    ctx.font = "10px monospace";
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
        className="w-full border border-border cursor-crosshair"
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
  const { t } = useApp();
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
  const vectorRuntime = useMemo(resolveVectorBrowserRuntime, []);
  const THREE = vectorRuntime.THREE;
  const resolvedCreateRenderer =
    createRenderer ?? vectorRuntime.createVectorBrowserRenderer;

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
      const W = container.clientWidth;
      const H = 550;

      // Scene
      const scene = new THREE.Scene();
      const bgColor =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--bg")
          .trim() || "#08080a";
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
    THREE,
    resolvedCreateRenderer,
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
      <div className="border border-border bg-card px-4 py-10 text-center">
        <div className="text-sm text-txt">
          {t("vectorbrowserview.RendererUnavailable", {
            defaultValue: "3D view unavailable in this environment.",
          })}
        </div>
        <div className="mt-2 text-xs text-muted">
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
        className="w-full border border-border cursor-grab active:cursor-grabbing"
        style={{ height: 550 }}
      />
      {/* Tooltip */}
      {hoveredMem && tooltipPos && (
        <div
          className="absolute pointer-events-none bg-card/95 text-txt backdrop-blur-sm border border-border/30 rounded-lg text-xs-tight px-3 py-2 max-w-[300px] z-10"
          style={{
            left: tooltipPos.x + 15,
            top: tooltipPos.y + 15,
            transform: tooltipPos.x > 400 ? "translateX(-100%)" : undefined,
          }}
        >
          <div className="font-medium mb-1 truncate">
            {hoveredMem.type && hoveredMem.type !== "undefined" && (
              <span className="px-1.5 py-0.5 bg-accent/30 text-accent mr-2 text-2xs">
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

// ── Main component ─────────────────────────────────────────────────────

export function VectorBrowserView({
  leftNav,
  contentHeader,
}: {
  leftNav?: ReactNode;
  contentHeader?: ReactNode;
}) {
  useRenderGuard("VectorBrowserView");
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

  // Show connection error state prominently
  const isConnectionError = error?.includes("agent is running");

  const vectorSidebar = (
    <AppPageSidebar
      testId="vector-sidebar"
      collapsible
      contentIdentity="vector-browser"
      collapsedRailItems={memories.map((mem) => {
        const isActive = selectedMemory?.id === mem.id;
        return (
          <SidebarContent.RailItem
            key={mem.id || `${mem.content.slice(0, 30)}-${mem.createdAt}`}
            aria-label={mem.content || "Memory"}
            title={mem.content || "Memory"}
            active={isActive}
            onClick={() => setSelectedMemory(mem)}
          >
            {mem.type && mem.type !== "undefined" ? mem.type.slice(0, 1) : "M"}
          </SidebarContent.RailItem>
        );
      })}
    >
      <SidebarPanel>
        <div className="space-y-3 pt-4">
          {leftNav}
          <PagePanel.SummaryCard>
            <div className="text-sm font-semibold text-txt">
              {selectedTable ||
                t("common.vectors", {
                  defaultValue: "Vectors",
                })}
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-2xs font-semibold uppercase tracking-[0.14em] text-muted/75">
              <MetaPill>
                {viewMode === "list"
                  ? t("vectorbrowserview.ListView", {
                      defaultValue: "List view",
                    })
                  : viewMode === "graph"
                    ? t("vectorbrowserview.Graph2D", {
                        defaultValue: "2D graph",
                      })
                    : t("vectorbrowserview.Graph3D", {
                        defaultValue: "3D graph",
                      })}
              </MetaPill>
              {stats ? (
                <MetaPill>
                  {t("vectorbrowserview.MemoryCount", {
                    count: Number(stats.total).toLocaleString(),
                    defaultValue: "{{count}} memories",
                  })}
                </MetaPill>
              ) : null}
            </div>
          </PagePanel.SummaryCard>
        </div>

        {!isConnectionError ? (
          <div className="space-y-3 pt-4">
            {tables.length > 1 && (
              <Select
                value={selectedTable}
                onValueChange={(value: string) => {
                  setSelectedTable(value);
                  setPage(0);
                  setSearch("");
                  setSearchInput("");
                  setSelectedMemory(null);
                }}
              >
                <SelectTrigger className="w-full h-9 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs shadow-sm transition-[border-color,box-shadow,background-color] focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent">
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

            <div className="grid grid-cols-3 gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                className={`h-auto min-h-[1.75rem] rounded-lg border px-4 py-1 text-left text-xs font-medium whitespace-normal break-words transition-all duration-300 ${
                  viewMode === "list"
                    ? "border-accent/45 bg-accent/16 text-txt-strong shadow-sm"
                    : "border-transparent text-muted-strong hover:border-border/50 hover:bg-bg-hover hover:text-txt"
                }`}
                onClick={() => setViewMode("list")}
              >
                {t("vectorbrowserview.List")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={`h-auto min-h-[1.75rem] rounded-lg border px-4 py-1 text-left text-xs font-medium whitespace-normal break-words transition-all duration-300 ${
                  viewMode === "graph"
                    ? "border-accent/45 bg-accent/16 text-txt-strong shadow-sm"
                    : "border-transparent text-muted-strong hover:border-border/50 hover:bg-bg-hover hover:text-txt"
                }`}
                onClick={() => setViewMode("graph")}
              >
                {t("vectorbrowserview.2D", { defaultValue: "2D" })}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={`h-auto min-h-[1.75rem] rounded-lg border px-4 py-1 text-left text-xs font-medium whitespace-normal break-words transition-all duration-300 ${
                  viewMode === "3d"
                    ? "border-accent/45 bg-accent/16 text-txt-strong shadow-sm"
                    : "border-transparent text-muted-strong hover:border-border/50 hover:bg-bg-hover hover:text-txt"
                }`}
                onClick={() => setViewMode("3d")}
              >
                {t("vectorbrowserview.3D", { defaultValue: "3D" })}
              </Button>
            </div>

            {viewMode === "list" ? (
              <div className="flex gap-1.5">
                <Input
                  type="search"
                  placeholder={t("vectorbrowserview.SearchContent")}
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  className="flex-1 h-10 rounded-xl border border-border/60 bg-card/50 px-3 py-2 text-sm shadow-sm placeholder:text-muted/65 transition-[border-color,box-shadow,background-color] focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent"
                />
                <Button variant="default" size="sm" onClick={handleSearch}>
                  {t("common.search")}
                </Button>
              </div>
            ) : null}

            {stats ? (
              <div className="rounded-2xl border border-border/35 bg-bg/35 px-3 py-3 text-xs-tight text-muted">
                <div className="font-semibold text-txt">
                  {Number(stats.total).toLocaleString()}{" "}
                  {t("vectorbrowserview.memories")}
                </div>
                <div className="mt-1">
                  {Number(stats.dimensions) > 0
                    ? t("vectorbrowserview.DimensionsEmbeddings", {
                        defaultValue: "{dimensions}D embeddings",
                      }).replace("{dimensions}", String(stats.dimensions))
                    : t("vectorbrowserview.Loading", {
                        defaultValue: "loading...",
                      })}
                </div>
                {Number(stats.uniqueCount) > 0 ? (
                  <div className="mt-1">
                    {Number(stats.uniqueCount).toLocaleString()}{" "}
                    {t("vectorbrowserview.unique")}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <SidebarScrollRegion className="mt-3 space-y-1.5">
          {isConnectionError ? (
            <SidebarContent.EmptyState>
              {t("vectorbrowserview.StartTheAgentToB")}
            </SidebarContent.EmptyState>
          ) : viewMode !== "list" ? (
            <SidebarContent.EmptyState>
              {t("vectorbrowserview.SelectPointHint", {
                defaultValue:
                  "Select a point from the viewer to inspect its full record on the right.",
              })}
            </SidebarContent.EmptyState>
          ) : loading ? (
            <SidebarContent.EmptyState>
              {t("vectorbrowserview.LoadingMemories")}
            </SidebarContent.EmptyState>
          ) : memories.length === 0 ? (
            <SidebarContent.EmptyState>
              {search
                ? t("vectorbrowserview.NoRecordsMatchSearchQuery", {
                    defaultValue: "No records match your search query.",
                  })
                : t("vectorbrowserview.NoMemoryRecordsDetected", {
                    defaultValue: "No memory records detected in the database.",
                  })}
            </SidebarContent.EmptyState>
          ) : (
            memories.map((mem) => {
              const isActive = selectedMemory?.id === mem.id;
              return (
                <SidebarContent.Item
                  key={mem.id || `${mem.content.slice(0, 30)}-${mem.createdAt}`}
                  active={isActive}
                  onClick={() => setSelectedMemory(mem)}
                >
                  <SidebarContent.ItemIcon active={isActive}>
                    {mem.type && mem.type !== "undefined"
                      ? mem.type.slice(0, 1)
                      : "M"}
                  </SidebarContent.ItemIcon>
                  <SidebarContent.ItemBody>
                    <SidebarContent.ItemTitle className="line-clamp-2">
                      {mem.content || "(empty)"}
                    </SidebarContent.ItemTitle>
                    <SidebarContent.ItemDescription>
                      {mem.embedding ? (
                        <span>{mem.embedding.length}D</span>
                      ) : null}
                      {mem.createdAt ? (
                        <span className="truncate">{mem.createdAt}</span>
                      ) : null}
                    </SidebarContent.ItemDescription>
                  </SidebarContent.ItemBody>
                </SidebarContent.Item>
              );
            })
          )}
        </SidebarScrollRegion>

        {viewMode === "list" && totalPages > 1 ? (
          <div className="mt-3 flex items-center justify-between gap-2 pt-3">
            <Button
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
              variant="outline"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              {t("common.next")}
            </Button>
          </div>
        ) : null}
      </SidebarPanel>
    </AppPageSidebar>
  );

  return (
    <PageLayout sidebar={vectorSidebar} contentHeader={contentHeader}>
      {error && !isConnectionError ? (
        <div className="m-5 rounded-xl border border-danger/35 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {isConnectionError ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="rounded-3xl border border-border/35 bg-bg/35 px-8 py-10 text-center shadow-inner">
            <div className="text-base font-semibold text-txt">
              {t("databaseview.DatabaseNotAvailab")}
            </div>
            <div className="mt-2 max-w-sm text-sm text-muted">
              {t("vectorbrowserview.StartTheAgentToB")}
            </div>
            <Button
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
      ) : viewMode === "graph" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
          <PagePanel variant="inset" className="p-5">
            {graphLoading ? (
              <div className="py-16 text-center text-sm italic text-muted">
                {t("vectorbrowserview.LoadingEmbeddings")}
              </div>
            ) : (
              <VectorGraph
                memories={graphMemories}
                onSelect={setSelectedMemory}
              />
            )}
          </PagePanel>
          <div className="mt-5 min-h-[18rem] rounded-2xl border border-border/40 bg-card/45">
            <MemoryDetailPanel memory={selectedMemory} />
          </div>
        </div>
      ) : viewMode === "3d" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
          <PagePanel variant="inset" className="p-5">
            {graphLoading ? (
              <div className="py-16 text-center text-sm italic text-muted">
                {t("vectorbrowserview.LoadingEmbeddings")}
              </div>
            ) : (
              <VectorGraph3D
                memories={graphMemories}
                onSelect={setSelectedMemory}
              />
            )}
          </PagePanel>
          <div className="mt-5 min-h-[18rem] rounded-2xl border border-border/40 bg-card/45">
            <MemoryDetailPanel memory={selectedMemory} />
          </div>
        </div>
      ) : (
        <MemoryDetailPanel memory={selectedMemory} />
      )}
    </PageLayout>
  );
}
