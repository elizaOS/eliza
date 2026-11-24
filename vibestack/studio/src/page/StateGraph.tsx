// Interactive state machine viewer, live simulator and structural transition composer for a spec's model graph.
import { useEffect, useId, useState, type ReactNode } from "react";
import { Button, EmptyState, Input, Label, cn } from "@repo/ui";
import type { GraphEdge, GraphNode, SimResult, SpecModelGraph } from "../graph.ts";
import { itemsOf, ruleKey } from "../markdown.ts";
import { S, addRuleFromGraph, postSim, reveal, type Working } from "./studio.ts";
import { Icon, IconButton, Markdown, Quint } from "./text.tsx";

interface GraphOverlays {
  guards?: boolean;
  invariants?: boolean;
  liveness?: boolean;
}

interface DraftEdge {
  name: string;
  from: string;
  to: string;
  sender?: string;
}

interface StateGraphCanvasProps {
  graph: SpecModelGraph;
  activeNode?: string;
  selectedNode?: string;
  selectedEdge?: string;
  highlightTransitions?: string[];
  showOverlays?: GraphOverlays;
  draftEdge?: DraftEdge;
  onSelectNode?: (nodeId: string) => void;
  onSelectEdge?: (edgeId: string) => void;
  compact?: boolean;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PositionedNode extends Box {
  node: GraphNode;
}

interface EdgePill {
  id: string;
  edgeId?: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  tone: "default" | "selected" | "liveness" | "draft";
}

interface PositionedEdge {
  id: string;
  edgeIds: string[];
  path: string;
  tone: "default" | "selected" | "liveness" | "draft";
  dashed: boolean;
  pills: EdgePill[];
}

interface GraphLayout {
  width: number;
  height: number;
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  initialMarker?: { cx: number; cy: number; path: string };
}

type InspectorMode =
  | { kind: "edge"; edgeId: string }
  | { kind: "node"; nodeId: string }
  | { kind: "compose-transition"; from: string; to: string }
  | { kind: "compose-state" }
  | { kind: "overview" };

type SimState =
  | { kind: "loading" }
  | { kind: "unavailable"; reason?: string }
  | { kind: "ready"; data: SimResult; stepCount: number };

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function normalizeTransitionName(name: string): string {
  const m = /^can([A-Z]\w*)$/.exec(name);
  return m ? m[1][0].toLowerCase() + m[1].slice(1) : name;
}

function edgeHighlighted(edge: GraphEdge, list: string[] | undefined): boolean {
  if (!list?.length) return false;
  const targets = new Set(list.flatMap((n) => [n, normalizeTransitionName(n)]));
  return targets.has(edge.name) || (edge.guard !== undefined && targets.has(edge.guard));
}

function cleanExpr(expr: string): string {
  return expr
    .replace(/^not\s*\(\s*([^()]+?)\s*==\s*([^()]+?)\s*\)$/, "$1 != $2")
    .replace(/\b[a-z]\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shortGuardSnippet(edge: GraphEdge, statusField?: string): string {
  if (edge.condition) {
    const cond = cleanExpr(edge.condition);
    return cond.length > 14 ? `${cond.slice(0, 13)}…` : cond;
  }
  if (!edge.guardExpr) return "";
  const clauses = edge.guardExpr.split(/\s+and\s+/).map((c) => c.trim()).filter((c) => {
    if (/^by\s*==/.test(c)) return false;
    if (statusField && new RegExp(`^\\w+\\.${statusField}\\s*==`).test(c)) return false;
    if (/^(?:not\s*\(\s*)?\w+\.[A-Za-z_]\w*\s*\)?$/.test(c)) return false;
    if (/[()]/.test(c)) return false;
    return true;
  });
  const first = clauses[0] ? cleanExpr(clauses[0]) : "";
  return first.length > 14 ? `${first.slice(0, 13)}…` : first;
}

function formatEdgeLabel(edge: GraphEdge, showGuards: boolean, statusField?: string, compactLabel = false): string {
  const parts = [edge.name];
  if (showGuards) {
    const cond = compactLabel && !edge.condition ? "" : shortGuardSnippet(edge, statusField);
    if (cond) parts.push(`[${cond}]`);
  }
  if (edge.sender && !compactLabel && parts.join(" ").length + edge.sender.length + 3 <= 24) {
    parts.push(`(${edge.sender})`);
  }
  return parts.join(" ");
}

function pillWidth(text: string): number {
  return Math.max(54, Math.ceil(text.length * 7.2 + 20));
}

function clipToBox(box: Box, fromX: number, fromY: number, toX: number, toY: number, pad: number): [number, number] {
  const dx = toX - fromX;
  const dy = toY - fromY;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return [fromX, fromY];
  const hw = box.w / 2 + pad;
  const hh = box.h / 2 + pad;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const tx = Math.abs(dx) > 0.001 ? hw / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const ty = Math.abs(dy) > 0.001 ? hh / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const t = Math.min(tx, ty);
  return [cx + dx * t, cy + dy * t];
}

function segmentHitsBox(x1: number, y1: number, x2: number, y2: number, box: Box, margin: number): boolean {
  const minX = box.x - margin;
  const maxX = box.x + box.w + margin;
  const minY = box.y - margin;
  const maxY = box.y + box.h + margin;
  for (let i = 1; i <= 7; i++) {
    const t = i / 8;
    const px = x1 + (x2 - x1) * t;
    const py = y1 + (y2 - y1) * t;
    if (px >= minX && px <= maxX && py >= minY && py <= maxY) return true;
  }
  return false;
}

function layoutEnumNodes(graph: SpecModelGraph, showInv: boolean, compact: boolean): PositionedNode[] {
  const { nodes, edges } = graph;
  if (!nodes.length) return [];
  const w = compact ? 158 : 178;
  const h = showInv ? (compact ? 74 : 84) : (compact ? 50 : 56);
  const colStep = compact ? 304 : 368;
  const rowStep = compact ? 176 : 208;

  const outMap = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set()]));
  const inMap = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set()]));
  for (const e of edges) {
    if (e.from === e.to) continue;
    outMap.get(e.from)?.add(e.to);
    inMap.get(e.to)?.add(e.from);
  }

  const init = nodes.find((n) => n.initial) ?? nodes[0];
  const depth = new Map<string, number>([[init.id, 0]]);
  const queue = [init.id];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = depth.get(cur)!;
    for (const next of outMap.get(cur) ?? []) {
      if (!depth.has(next)) {
        depth.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  const maxD = Math.max(0, ...depth.values());
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, maxD + 1);

  const coords = new Map<string, { col: number; row: number }>();
  if (nodes.length <= 3) {
    nodes.forEach((n, i) => coords.set(n.id, { col: i, row: 0 }));
  } else {
    const usedTop = new Set<string>();
    const mainNodes: GraphNode[] = [];
    for (const n of nodes) {
      const d = depth.get(n.id)!;
      const outs = [...(outMap.get(n.id) ?? [])];
      const ins = [...(inMap.get(n.id) ?? [])];
      const bidirHost = d >= 2 && outs.length === 1 && ins.includes(outs[0]) && depth.get(outs[0]) === d - 1 ? outs[0] : undefined;
      if (bidirHost && !usedTop.has(bidirHost)) {
        usedTop.add(bidirHost);
        coords.set(n.id, { col: depth.get(bidirHost)!, row: -1 });
        continue;
      }
      const returnsEarly = d >= 2 && outs.length > 0 && outs.every((t) => (depth.get(t) ?? 0) < d - 1);
      if (returnsEarly && ins.length > 0) {
        const avgCol = ((depth.get(ins[0]) ?? d - 1) + (depth.get(outs[0]) ?? 0)) / 2;
        coords.set(n.id, { col: avgCol, row: 1 });
        continue;
      }
      mainNodes.push(n);
    }

    const byCol = new Map<number, GraphNode[]>();
    for (const n of mainNodes) {
      const c = Math.min(depth.get(n.id)!, 3);
      byCol.set(c, [...(byCol.get(c) ?? []), n]);
    }
    for (const [col, group] of byCol) {
      group.forEach((n, idx) => {
        const row = group.length === 1 ? 0 : idx - (group.length - 1) / 2;
        coords.set(n.id, { col, row });
      });
    }
  }

  const raw = nodes.map((node) => {
    const c = coords.get(node.id) ?? { col: 0, row: 0 };
    return { node, x: c.col * colStep, y: c.row * rowStep, w, h };
  });
  const minX = Math.min(...raw.map((n) => n.x));
  const minY = Math.min(...raw.map((n) => n.y));
  const padX = compact ? 52 : 68;
  const padY = compact ? 64 : 76;
  return raw.map((n) => ({ ...n, x: Math.round(n.x - minX + padX), y: Math.round(n.y - minY + padY) }));
}

function layoutProjectedNodes(graph: SpecModelGraph, compact: boolean): PositionedNode[] {
  const w = compact ? 186 : 206;
  const h = compact ? 72 : 80;
  const colStep = compact ? 356 : 420;
  const rowStep = compact ? 216 : 244;
  const padX = compact ? 48 : 64;
  const padY = compact ? 64 : 76;
  return graph.nodes.map((node, i) => ({
    node,
    x: padX + (i % 2) * colStep,
    y: padY + Math.floor(i / 2) * rowStep,
    w,
    h,
  }));
}

function resolvePillOverlaps(pills: EdgePill[], nodes: PositionedNode[]) {
  const pillMargin = 8;
  const nodeMargin = 8;
  for (let pass = 0; pass < 40; pass++) {
    let moved = false;
    for (let i = 0; i < pills.length; i++) {
      for (let j = i + 1; j < pills.length; j++) {
        const a = pills[i];
        const b = pills[j];
        const ox = (a.w + b.w) / 2 + pillMargin - Math.abs(a.x - b.x);
        const oy = (a.h + b.h) / 2 + pillMargin - Math.abs(a.y - b.y);
        if (ox > 0 && oy > 0) {
          if (ox < oy * 0.7) {
            const shift = Math.ceil(ox / 2) + 1;
            if (a.x <= b.x) { a.x -= shift; b.x += shift; }
            else { a.x += shift; b.x -= shift; }
          } else {
            const shift = Math.ceil(oy / 2) + 1;
            if (a.y <= b.y) { a.y -= shift; b.y += shift; }
            else { a.y += shift; b.y -= shift; }
          }
          moved = true;
        }
      }
      const p = pills[i];
      for (const n of nodes) {
        const nx = n.x + n.w / 2;
        const ny = n.y + n.h / 2;
        const ox = (p.w + n.w) / 2 + nodeMargin - Math.abs(p.x - nx);
        const oy = (p.h + n.h) / 2 + nodeMargin - Math.abs(p.y - ny);
        if (ox > 0 && oy > 0) {
          if (oy <= ox) p.y += p.y <= ny ? -(oy + 3) : oy + 3;
          else p.x += p.x <= nx ? -(ox + 3) : ox + 3;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
}

function buildRoutedEdges(
  graph: SpecModelGraph,
  positioned: PositionedNode[],
  opts: { selectedEdge?: string; highlightTransitions?: string[]; showGuards: boolean; showLiveness: boolean; draftEdge?: DraftEdge },
): PositionedEdge[] {
  const nodeMap = new Map(positioned.map((n) => [n.node.id, n]));
  const bundles = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    if (!nodeMap.has(e.from) || !nodeMap.has(e.to)) continue;
    const key = `${e.from}-->${e.to}`;
    bundles.set(key, [...(bundles.get(key) ?? []), e]);
  }
  const graphCx = positioned.reduce((s, n) => s + n.x + n.w / 2, 0) / Math.max(1, positioned.length);
  const graphCy = positioned.reduce((s, n) => s + n.y + n.h / 2, 0) / Math.max(1, positioned.length);
  const routed: PositionedEdge[] = [];

  for (const [key, list] of bundles) {
    const fromBox = nodeMap.get(list[0].from)!;
    const toBox = nodeMap.get(list[0].to)!;
    const isSelf = fromBox === toBox;
    const hasReverse = !isSelf && bundles.has(`${list[0].to}-->${list[0].from}`);
    const anySel = list.some((e) => e.id === opts.selectedEdge || edgeHighlighted(e, opts.highlightTransitions));
    const liveEdge = opts.showLiveness ? list.find((e) => e.liveness) : undefined;
    const tone: PositionedEdge["tone"] = anySel ? "selected" : liveEdge ? "liveness" : "default";
    const dashed = Boolean(liveEdge && !anySel);

    let path: string;
    let lx: number;
    let ly: number;
    let selfDir: -1 | 1 = -1;

    if (isSelf) {
      const cx = fromBox.x + fromBox.w / 2;
      const blockedAbove = positioned.some((n) => n !== fromBox && Math.abs((n.x + n.w / 2) - cx) < fromBox.w * 0.9 && n.y < fromBox.y);
      if (!blockedAbove) {
        const y0 = fromBox.y;
        path = `M ${cx - 26},${y0} C ${cx - 42},${y0 - 52} ${cx + 42},${y0 - 52} ${cx + 26},${y0 - 4}`;
        lx = Math.round(cx);
        ly = Math.round(y0 - 44);
        selfDir = -1;
      } else {
        const y0 = fromBox.y + fromBox.h;
        const hasBottomLeft = positioned.some((n) => n !== fromBox && n.y > fromBox.y && n.x + n.w / 2 < cx);
        const hasBottomRight = positioned.some((n) => n !== fromBox && n.y > fromBox.y && n.x + n.w / 2 > cx);
        const shiftRight = hasBottomLeft && !hasBottomRight ? 38 : 0;
        const ax = cx + shiftRight * 0.5;
        path = `M ${Math.round(ax - 24)},${y0} C ${Math.round(ax - 32)},${y0 + 54} ${Math.round(ax + 44)},${y0 + 54} ${Math.round(ax + 26)},${y0 + 4}`;
        lx = Math.round(cx + shiftRight);
        ly = Math.round(y0 + 46);
        selfDir = 1;
      }
    } else {
      const ax = fromBox.x + fromBox.w / 2;
      const ay = fromBox.y + fromBox.h / 2;
      const bx = toBox.x + toBox.w / 2;
      const by = toBox.y + toBox.h / 2;
      const dx = bx - ax;
      const dy = by - ay;
      const dist = Math.hypot(dx, dy) || 1;
      const nx = -dy / dist;
      const ny = dx / dist;
      const hitsOther = positioned.some((n) => n !== fromBox && n !== toBox && segmentHitsBox(ax, ay, bx, by, n, 14));
      let bow = 0;
      if (hasReverse) {
        bow = 48;
      } else if (hitsOther) {
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        const side = (mx - graphCx) * nx + (my - graphCy) * ny >= 0 ? 1 : -1;
        bow = 78 * side;
      } else if (Math.abs(dx) > 40 && Math.abs(dy) > 40) {
        bow = 26;
      }
      const ctrlX = (ax + bx) / 2 + nx * bow;
      const ctrlY = (ay + by) / 2 + ny * bow;
      const [sx, sy] = clipToBox(fromBox, ax, ay, ctrlX, ctrlY, 1);
      const [ex, ey] = clipToBox(toBox, bx, by, ctrlX, ctrlY, 5);
      path = Math.abs(bow) < 1
        ? `M ${Math.round(sx)},${Math.round(sy)} L ${Math.round(ex)},${Math.round(ey)}`
        : `M ${Math.round(sx)},${Math.round(sy)} Q ${Math.round(ctrlX)},${Math.round(ctrlY)} ${Math.round(ex)},${Math.round(ey)}`;
      const apexX = 0.25 * sx + 0.5 * ctrlX + 0.25 * ex;
      const apexY = 0.25 * sy + 0.5 * ctrlY + 0.25 * ey;
      const push = hasReverse ? 16 : Math.abs(bow) < 1 ? 0 : 10;
      lx = Math.round(apexX + nx * push);
      ly = Math.round(apexY + ny * push);
    }

    const pills: EdgePill[] = [];
    if (isSelf && list.length <= 3) {
      list.forEach((e, idx) => {
        const text = formatEdgeLabel(e, opts.showGuards, graph.statusField, list.length > 1);
        const sel = e.id === opts.selectedEdge || edgeHighlighted(e, opts.highlightTransitions);
        pills.push({
          id: e.id, edgeId: e.id, text, x: lx, y: ly + idx * 25 * selfDir, w: pillWidth(text), h: 21,
          tone: sel ? "selected" : "default",
        });
      });
    } else if (list.length <= 2) {
      list.forEach((e, idx) => {
        const text = formatEdgeLabel(e, opts.showGuards, graph.statusField, list.length > 1);
        const sel = e.id === opts.selectedEdge || edgeHighlighted(e, opts.highlightTransitions);
        const offset = list.length === 2 ? (idx === 0 ? -13 : 13) : 0;
        pills.push({ id: e.id, edgeId: e.id, text, x: lx, y: ly + offset, w: pillWidth(text), h: 21, tone: sel ? "selected" : "default" });
      });
    } else {
      const joined = `${list.slice(0, 2).map((e) => e.name).join(" · ")} +${list.length - 2}`;
      pills.push({ id: `${key}#group`, edgeId: list[0].id, text: joined, x: lx, y: ly, w: pillWidth(joined), h: 21, tone: anySel ? "selected" : "default" });
    }

    if (liveEdge?.liveness) {
      const lText = liveEdge.liveness.within !== undefined ? `↝ within ${liveEdge.liveness.within}` : `↝ ${liveEdge.liveness.rule}`;
      pills.push({ id: `${key}#live`, text: lText, x: lx, y: ly + 26, w: pillWidth(lText), h: 20, tone: "liveness" });
    }
    routed.push({ id: key, edgeIds: list.map((e) => e.id), path, tone, dashed, pills });
  }

  if (opts.draftEdge && nodeMap.has(opts.draftEdge.from) && nodeMap.has(opts.draftEdge.to)) {
    const f = nodeMap.get(opts.draftEdge.from)!;
    const t = nodeMap.get(opts.draftEdge.to)!;
    const ax = f.x + f.w / 2;
    const ay = f.y + f.h / 2;
    const bx = t.x + t.w / 2;
    const by = t.y + t.h / 2;
    const label = `+ ${opts.draftEdge.name || "transition"}${opts.draftEdge.sender ? ` (${opts.draftEdge.sender})` : ""} · draft`;
    if (f === t) {
      const y0 = f.y + f.h;
      routed.push({
        id: "__draft__", edgeIds: [], tone: "draft", dashed: true,
        path: `M ${ax - 28},${y0} C ${ax - 44},${y0 + 60} ${ax + 44},${y0 + 60} ${ax + 28},${y0 + 4}`,
        pills: [{ id: "__draft_pill__", text: label, x: Math.round(ax), y: Math.round(y0 + 54), w: pillWidth(label), h: 22, tone: "draft" }],
      });
    } else {
      const maxY = Math.max(...positioned.map((n) => n.y + n.h));
      const ctrlX = Math.round((ax + bx) / 2);
      const ctrlY = Math.round(maxY + 104);
      const [sx, sy] = clipToBox(f, ax, ay, ctrlX, ctrlY, 1);
      const [ex, ey] = clipToBox(t, bx, by, ctrlX, ctrlY, 5);
      const py = Math.round(maxY + 48);
      routed.push({
        id: "__draft__", edgeIds: [], tone: "draft", dashed: true,
        path: `M ${Math.round(sx)},${Math.round(sy)} Q ${ctrlX},${ctrlY} ${Math.round(ex)},${Math.round(ey)}`,
        pills: [{ id: "__draft_pill__", text: label, x: ctrlX, y: py, w: pillWidth(label), h: 22, tone: "draft" }],
      });
    }
  }

  resolvePillOverlaps(routed.flatMap((r) => r.pills), positioned);
  return routed;
}

function layoutTopology(
  graph: SpecModelGraph,
  opts: { selectedEdge?: string; highlightTransitions?: string[]; showGuards: boolean; draftEdge?: DraftEdge; compact: boolean },
): GraphLayout {
  const hub = graph.nodes[0] ?? { id: graph.stateType ?? "State", label: graph.stateType ?? "State", initial: true, invariants: [] };
  const fieldsCount = Math.min(graph.stateFields.length, 6);
  const hubW = opts.compact ? 196 : 220;
  const hubH = Math.max(82, 46 + fieldsCount * 16);
  const cardW = opts.compact ? 164 : 186;
  const cardH = 34;
  const gapY = 14;
  const edgesList = graph.edges;
  const leftCount = Math.ceil(edgesList.length / 2);
  const rightCount = edgesList.length - leftCount;
  const maxCol = Math.max(1, leftCount, rightCount + (opts.draftEdge ? 1 : 0));
  const colHeight = maxCol * cardH + Math.max(0, maxCol - 1) * gapY;
  const height = Math.max(260, Math.max(hubH, colHeight) + 96);
  const width = opts.compact ? 640 : 760;
  const hubX = Math.round((width - hubW) / 2);
  const hubY = Math.round((height - hubH) / 2);
  const hubBox: PositionedNode = { node: hub, x: hubX, y: hubY, w: hubW, h: hubH };

  const positionedEdges: PositionedEdge[] = [];
  const placeColumn = (items: GraphEdge[], side: "left" | "right") => {
    const startY = Math.round((height - (items.length * cardH + Math.max(0, items.length - 1) * gapY)) / 2);
    const xCenter = side === "left" ? Math.round(hubX / 2) : Math.round(hubX + hubW + (width - hubX - hubW) / 2);
    items.forEach((e, idx) => {
      const cy = startY + idx * (cardH + gapY) + cardH / 2;
      const text = formatEdgeLabel(e, opts.showGuards);
      const pw = Math.min(cardW, Math.max(116, pillWidth(text)));
      const sel = e.id === opts.selectedEdge || edgeHighlighted(e, opts.highlightTransitions);
      const sx = side === "left" ? xCenter + pw / 2 + 2 : xCenter - pw / 2 - 2;
      const ex = side === "left" ? hubX - 5 : hubX + hubW + 5;
      const midX = Math.round((sx + ex) / 2);
      const ey = Math.round(hubY + ((idx + 1) / (items.length + 1)) * hubH);
      positionedEdges.push({
        id: e.id, edgeIds: [e.id], tone: sel ? "selected" : "default", dashed: false,
        path: `M ${Math.round(sx)},${Math.round(cy)} C ${midX},${Math.round(cy)} ${midX},${ey} ${ex},${ey}`,
        pills: [{ id: e.id, edgeId: e.id, text, x: xCenter, y: Math.round(cy), w: pw, h: 26, tone: sel ? "selected" : "default" }],
      });
    });
  };
  placeColumn(edgesList.slice(0, leftCount), "left");
  placeColumn(edgesList.slice(leftCount), "right");

  if (opts.draftEdge) {
    const label = `+ ${opts.draftEdge.name || "transition"} · draft`;
    const pw = Math.max(130, pillWidth(label));
    const cx = Math.round(width / 2);
    const cy = Math.min(height - 26, hubY + hubH + 46);
    positionedEdges.push({
      id: "__draft__", edgeIds: [], tone: "draft", dashed: true,
      path: `M ${cx},${cy - 14} L ${cx},${hubY + hubH + 5}`,
      pills: [{ id: "__draft_pill__", text: label, x: cx, y: cy, w: pw, h: 24, tone: "draft" }],
    });
  }

  return {
    width, height, nodes: [hubBox], edges: positionedEdges,
    initialMarker: { cx: hubX - 24, cy: hubY + 20, path: `M ${hubX - 19},${hubY + 20} L ${hubX - 5},${hubY + 20}` },
  };
}

function layoutGraph(
  graph: SpecModelGraph,
  opts: { selectedEdge?: string; highlightTransitions?: string[]; showGuards: boolean; showInvariants: boolean; showLiveness: boolean; draftEdge?: DraftEdge; compact: boolean },
): GraphLayout {
  if (graph.projectionKind === "topology") {
    return layoutTopology(graph, opts);
  }
  const nodes = graph.projectionKind === "projected"
    ? layoutProjectedNodes(graph, opts.compact)
    : layoutEnumNodes(graph, opts.showInvariants, opts.compact);
  const edges = buildRoutedEdges(graph, nodes, opts);

  const allXs = [
    ...nodes.flatMap((n) => [n.x, n.x + n.w]),
    ...edges.flatMap((e) => e.pills.flatMap((p) => [p.x - p.w / 2, p.x + p.w / 2])),
  ];
  const allYs = [
    ...nodes.flatMap((n) => [n.y, n.y + n.h]),
    ...edges.flatMap((e) => e.pills.flatMap((p) => [p.y - p.h / 2, p.y + p.h / 2])),
  ];
  const minX = allXs.length ? Math.min(...allXs) : 0;
  const minY = allYs.length ? Math.min(...allYs) : 0;
  const shiftX = minX < 36 ? Math.round(36 - minX) : 0;
  const shiftY = minY < 28 ? Math.round(28 - minY) : 0;

  const shiftedNodes = shiftX || shiftY ? nodes.map((n) => ({ ...n, x: n.x + shiftX, y: n.y + shiftY })) : nodes;
  const shiftedEdges = shiftX || shiftY ? buildRoutedEdges(graph, shiftedNodes, opts) : edges;

  const maxX = Math.max(
    opts.compact ? 560 : 760,
    ...shiftedNodes.map((n) => n.x + n.w + 40),
    ...shiftedEdges.flatMap((e) => e.pills.map((p) => p.x + p.w / 2 + 24)),
  );
  const maxY = Math.max(
    opts.compact ? 360 : 440,
    ...shiftedNodes.map((n) => n.y + n.h + 40),
    ...shiftedEdges.flatMap((e) => e.pills.map((p) => p.y + p.h / 2 + 24)),
  );

  const initNode = shiftedNodes.find((n) => n.node.initial) ?? shiftedNodes[0];
  const initialMarker = initNode
    ? {
      cx: Math.max(12, initNode.x - 28),
      cy: Math.round(initNode.y + initNode.h / 2),
      path: `M ${Math.max(17, initNode.x - 23)},${Math.round(initNode.y + initNode.h / 2)} L ${initNode.x - 5},${Math.round(initNode.y + initNode.h / 2)}`,
    }
    : undefined;

  return { width: Math.round(maxX), height: Math.round(maxY), nodes: shiftedNodes, edges: shiftedEdges, initialMarker };
}

function truncateText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** Deterministic interactive SVG state machine diagram reusable in StateGraph and SplitView. */
export function StateGraphCanvas({
  graph,
  activeNode,
  selectedNode,
  selectedEdge,
  highlightTransitions,
  showOverlays,
  draftEdge,
  onSelectNode,
  onSelectEdge,
  compact = false,
}: StateGraphCanvasProps) {
  const uid = useId().replace(/:/g, "");
  const showGuards = showOverlays?.guards ?? true;
  const showInvariants = showOverlays?.invariants ?? true;
  const showLiveness = showOverlays?.liveness ?? true;

  if (!graph.nodes.length) {
    return <EmptyState title="No state nodes in this spec" className="py-12" />;
  }

  const layout = layoutGraph(graph, {
    selectedEdge, highlightTransitions, showGuards, showInvariants, showLiveness, draftEdge, compact,
  });

  const markerFor = (tone: PositionedEdge["tone"]) =>
    tone === "selected" || tone === "draft" ? `url(#${uid}-pri)` : tone === "liveness" ? `url(#${uid}-warn)` : `url(#${uid}-arr)`;

  const edgeStroke = (tone: PositionedEdge["tone"]) =>
    tone === "selected" || tone === "draft" ? "stroke-primary" : tone === "liveness" ? "stroke-warn" : "stroke-input";

  const pillRectClass = (tone: EdgePill["tone"]) =>
    tone === "selected" || tone === "draft"
      ? "fill-accent stroke-primary"
      : tone === "liveness"
        ? "fill-background stroke-warn"
        : "fill-background stroke-border";

  const pillTextClass = (tone: EdgePill["tone"]) =>
    tone === "selected" || tone === "draft"
      ? "fill-primary font-medium"
      : tone === "liveness"
        ? "fill-warn"
        : "fill-foreground";

  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label={`${graph.stateType ?? graph.module} state machine`}
      className={cn("h-full w-full select-none", compact ? "min-h-64" : "min-h-88")}
    >
      <defs>
        <pattern id={`${uid}-dots`} width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1" className="fill-border" opacity={0.65} />
        </pattern>
        <marker id={`${uid}-arr`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
          <path d="M 1 1.5 L 9 5 L 1 8.5 z" className="fill-input" />
        </marker>
        <marker id={`${uid}-pri`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 1 1.5 L 9 5 L 1 8.5 z" className="fill-primary" />
        </marker>
        <marker id={`${uid}-warn`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
          <path d="M 1 1.5 L 9 5 L 1 8.5 z" className="fill-warn" />
        </marker>
        {layout.nodes.map((item) => (
          <clipPath key={`${item.node.id}-clip`} id={`${uid}-clip-${item.node.id.replace(/[^A-Za-z0-9_-]/g, "_")}`}>
            <rect x={item.x + 8} y={item.y + 4} width={item.w - 16} height={item.h - 8} rx={6} />
          </clipPath>
        ))}
      </defs>

      <rect x={0} y={0} width={layout.width} height={layout.height} fill={`url(#${uid}-dots)`} />

      {layout.initialMarker && (
        <g aria-label="Initial state marker">
          <circle cx={layout.initialMarker.cx} cy={layout.initialMarker.cy} r={4.5} className="fill-primary" />
          <path d={layout.initialMarker.path} fill="none" strokeWidth={1.75} className="stroke-primary" markerEnd={`url(#${uid}-pri)`} />
        </g>
      )}

      {layout.edges.map((edge) => (
        <path
          key={edge.id}
          d={edge.path}
          fill="none"
          strokeWidth={edge.tone === "selected" || edge.tone === "draft" ? 2 : 1.5}
          strokeDasharray={edge.dashed ? "5 4" : undefined}
          className={cn(edgeStroke(edge.tone), "transition-colors duration-fast")}
          markerEnd={markerFor(edge.tone)}
        />
      ))}

      {layout.nodes.map((item) => {
        const { node, x, y, w, h } = item;
        const isActive = activeNode === node.id;
        const isSelected = selectedNode === node.id;
        const isGoal = Boolean(node.goal);
        const boxClass = isActive || isSelected
          ? "fill-card stroke-primary"
          : isGoal
            ? "fill-card stroke-ok"
            : "fill-card stroke-border";
        const subLines = [...new Set(
          graph.projectionKind === "topology"
            ? graph.stateFields.slice(0, 5).map((f) => `${f.name}: ${f.type}`)
            : showInvariants
              ? [
                ...(node.predicate ? [node.predicate] : []),
                ...node.invariants.slice(0, 2),
                ...(node.goal && node.invariants.length < 2 ? [`⚑ ${node.goal}`] : []),
              ].slice(0, 2)
              : [],
        )];

        return (
          <g
            key={node.id}
            data-graph-node={node.id}
            role={onSelectNode ? "button" : undefined}
            tabIndex={onSelectNode ? 0 : undefined}
            aria-label={`State ${node.label}`}
            className={cn(onSelectNode && "cursor-pointer")}
            onClick={() => onSelectNode?.(node.id)}
            onKeyDown={(e) => { if (onSelectNode && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onSelectNode(node.id); } }}
          >
            {(isActive || isSelected) && (
              <rect x={x - 3} y={y - 3} width={w + 6} height={h + 6} rx={12} fill="none" strokeWidth={3} className="stroke-primary/25" />
            )}
            <rect x={x} y={y} width={w} height={h} rx={10} strokeWidth={isActive || isSelected ? 2 : 1.25} className={boxClass} />
            <g clipPath={`url(#${uid}-clip-${node.id.replace(/[^A-Za-z0-9_-]/g, "_")})`}>
              <text x={x + 12} y={y + 24} fontSize={compact ? 12 : 13} className="fill-foreground font-sans font-semibold">
                {truncateText(node.label, Math.max(8, Math.floor((w - 64) / 7.6)))}
              </text>
              {isActive ? (
                <text x={x + w - 12} y={y + 23} textAnchor="end" fontSize={10} className="fill-primary font-mono font-medium">● live</text>
              ) : node.initial ? (
                <text x={x + w - 12} y={y + 23} textAnchor="end" fontSize={10} className="fill-primary font-mono">init</text>
              ) : isGoal ? (
                <text x={x + w - 12} y={y + 23} textAnchor="end" fontSize={10} className="fill-ok font-mono">⚑ goal</text>
              ) : null}
              {subLines.map((line, idx) => (
                <text key={`${node.id}-${line}`} x={x + 12} y={y + 44 + idx * 16} fontSize={10} className="fill-muted-foreground font-mono">
                  {truncateText(line, Math.max(10, Math.floor((w - 28) / 6.3)))}
                </text>
              ))}
            </g>
          </g>
        );
      })}

      {layout.edges.flatMap((edge) =>
        edge.pills.map((pill) => {
          const clickable = Boolean(onSelectEdge && pill.edgeId);
          return (
            <g
              key={pill.id}
              data-graph-edge={pill.edgeId}
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? 0 : undefined}
              aria-label={pill.edgeId ? `Transition ${pill.text}` : pill.text}
              className={cn(clickable && "cursor-pointer")}
              onClick={() => { if (pill.edgeId) onSelectEdge?.(pill.edgeId); }}
              onKeyDown={(e) => {
                if (clickable && pill.edgeId && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onSelectEdge?.(pill.edgeId);
                }
              }}
            >
              <rect
                x={Math.round(pill.x - pill.w / 2)}
                y={Math.round(pill.y - pill.h / 2)}
                width={pill.w}
                height={pill.h}
                rx={5}
                strokeWidth={pill.tone === "selected" || pill.tone === "draft" ? 1.5 : 1}
                strokeDasharray={pill.tone === "draft" ? "4 2" : undefined}
                className={pillRectClass(pill.tone)}
              />
              <text x={pill.x} y={pill.y + 4} textAnchor="middle" fontSize={11} className={cn("font-mono", pillTextClass(pill.tone))}>
                {pill.text}
              </text>
            </g>
          );
        }),
      )}
    </svg>
  );
}

// --- Live guard & state formatting helpers ----------------------------------------------------------------------

function primitiveToString(v: unknown, fallback: string): string {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : fallback;
}

function formatStateValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).length}}`;
  return primitiveToString(v, "");
}

function formatStateCompact(state: unknown): string {
  if (!state || typeof state !== "object" || Array.isArray(state)) return JSON.stringify(state) ?? "";
  const entries = Object.entries(state as Record<string, unknown>);
  return `{ ${entries.map(([k, v]) => `${k}: ${formatStateValue(v)}`).join(", ")} }`;
}

function evaluateGuardClause(
  clause: string,
  state: unknown,
  sender: string | undefined,
  overallAllowed: boolean | undefined,
): { status: "ok" | "bad" | "unknown"; label: string } {
  const rec = state && typeof state === "object" && !Array.isArray(state) ? (state as Record<string, unknown>) : undefined;
  const byEq = /^by\s*==\s*([A-Z]\w*)$/.exec(clause);
  if (byEq) {
    if (!sender) return { status: "ok", label: `✓ ${byEq[1]}` };
    return sender === byEq[1] ? { status: "ok", label: "✓" } : { status: "bad", label: `✗ (${sender})` };
  }
  if (rec) {
    const eq = /^\w+\.([A-Za-z_]\w*)\s*==\s*([A-Za-z0-9_"-]+)$/.exec(clause);
    if (eq && eq[1] in rec) {
      const actual = String(rec[eq[1]]);
      const expected = eq[2].replace(/^"|"$/g, "");
      return actual === expected ? { status: "ok", label: "✓" } : { status: "bad", label: `✗ (${actual})` };
    }
    const neq = /^\w+\.([A-Za-z_]\w*)\s*!=\s*([A-Za-z0-9_"-]+)$/.exec(clause);
    if (neq && neq[1] in rec) {
      const actual = String(rec[neq[1]]);
      const expected = neq[2].replace(/^"|"$/g, "");
      return actual !== expected ? { status: "ok", label: "✓" } : { status: "bad", label: `✗ (${actual})` };
    }
    const cmp = /^\w+\.([A-Za-z_]\w*)\s*(>|>=|<|<=)\s*(-?\d+)$/.exec(clause);
    if (cmp && typeof rec[cmp[1]] === "number") {
      const val = rec[cmp[1]] as number;
      const rhs = Number(cmp[3]);
      const ok = cmp[2] === ">" ? val > rhs : cmp[2] === ">=" ? val >= rhs : cmp[2] === "<" ? val < rhs : val <= rhs;
      return ok ? { status: "ok", label: `✓ (${val})` } : { status: "bad", label: `✗ (${val})` };
    }
    const negBool = /^not\s*\(\s*\w+\.([A-Za-z_]\w*)\s*\)$/.exec(clause);
    if (negBool && typeof rec[negBool[1]] === "boolean") {
      const ok = !rec[negBool[1]];
      return ok ? { status: "ok", label: "✓" } : { status: "bad", label: "✗ (true)" };
    }
    const posBool = /^\w+\.([A-Za-z_]\w*)$/.exec(clause);
    if (posBool && typeof rec[posBool[1]] === "boolean") {
      const ok = Boolean(rec[posBool[1]]);
      return ok ? { status: "ok", label: "✓" } : { status: "bad", label: "✗ (false)" };
    }
  }
  if (overallAllowed === true) return { status: "ok", label: "✓" };
  if (overallAllowed === false) return { status: "unknown", label: "·" };
  return { status: "unknown", label: "" };
}

function ruleProseFor(spec: Working, key: string): string {
  for (const story of spec.outline.stories) {
    for (const rule of story.rules) {
      if (ruleKey(story.title, rule.title) === key) {
        return itemsOf(rule.body).filter((i) => !i.quint).map((i) => i.text).join("\n\n");
      }
    }
  }
  return "";
}

function uniqueRuleHeading(spec: Working, base: string): string {
  const existing = new Set(spec.outline.stories.flatMap((s) => s.rules.map((r) => r.title.trim())));
  if (!existing.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base} (${i})`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
}

// --- Inspector Sub-Panels ---------------------------------------------------------------------------------------

function InspectorSection({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function RuleLinkList({
  file,
  items,
  glyph,
  tone = "text-foreground",
  showCheck = false,
}: {
  file: string;
  items: { name: string; ruleKey: string }[];
  glyph: string;
  tone?: string;
  showCheck?: boolean;
}) {
  return (
    <>
      {items.map((item) => (
        <button
          key={item.name}
          type="button"
          onClick={() => reveal(file, item.ruleKey)}
          className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-left text-xs hover:bg-accent"
        >
          <span className={cn("truncate font-mono", tone)}>{glyph} {item.name}</span>
          {showCheck && <span className="shrink-0 text-ok">✓</span>}
        </button>
      ))}
    </>
  );
}

function EdgeLinkList({
  edges,
  onSelectEdge,
  describe,
  empty,
}: {
  edges: GraphEdge[];
  onSelectEdge: (edgeId: string) => void;
  describe: (e: GraphEdge) => string;
  empty?: string;
}) {
  if (!edges.length) return empty ? <div className="text-xs text-muted-foreground">{empty}</div> : null;
  return (
    <div className="flex flex-col gap-1">
      {edges.map((e) => (
        <button
          key={e.id}
          type="button"
          onClick={() => onSelectEdge(e.id)}
          className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-left text-xs hover:bg-accent"
        >
          <span className="font-mono font-medium text-foreground">→ {e.name}</span>
          <span className="truncate font-mono text-muted-foreground">{describe(e)}</span>
        </button>
      ))}
    </div>
  );
}

function ComposerField({
  id,
  label,
  value,
  onChange,
  mono = false,
  children,
}: {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  mono?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <Input id={id} value={value} className={cn("h-8 text-xs", mono && "font-mono")} onChange={(e) => onChange(e.target.value)} />
      {children}
    </div>
  );
}

function ComposerShell({
  title,
  subtitle,
  file,
  diffPreview,
  canApply,
  onApply,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  file: string;
  diffPreview: string;
  canApply: boolean;
  onApply: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5 border-b border-border pb-2.5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-primary">{title}</h2>
          <IconButton name="close" label={`Cancel ${title.toLowerCase()}`} onClick={onClose} />
        </div>
        <div className="text-xs text-muted-foreground">{subtitle}</div>
      </div>
      {children}
      <InspectorSection label={<span>Spec Diff Preview (<span className="font-mono">{file}</span>)</span>}>
        <pre className="m-0 overflow-x-auto rounded-md border border-ok/40 bg-muted px-2.5 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-ok">
          {diffPreview}
        </pre>
      </InspectorSection>
      <div className="flex gap-2 pt-1">
        <Button variant="primary" size="sm" className="flex-1" disabled={!canApply} onClick={onApply}>
          Apply to outline
        </Button>
        <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

function EdgeInspector({ spec, graph, edge, sim }: { spec: Working; graph: SpecModelGraph; edge: GraphEdge; sim: SimState }) {
  const fromLabel = graph.nodes.find((n) => n.id === edge.from)?.label ?? edge.from;
  const toLabel = graph.nodes.find((n) => n.id === edge.to)?.label ?? edge.to;
  const prose = ruleProseFor(spec, edge.ruleKey);
  const simEv = sim.kind === "ready" ? sim.data.enabledEvents?.find((e) => e.name === edge.name) : undefined;
  const clauses = edge.guardExpr
    ? [...new Set(edge.guardExpr.split(/\s+and\s+/).map((c) => c.trim()).filter(Boolean))]
    : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 border-b border-border pb-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="truncate font-mono text-base font-semibold text-foreground">→ {edge.name}</h2>
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => reveal(spec.file, edge.ruleKey)}>
            View in Story <Icon name="external" className="size-3.5" />
          </Button>
        </div>
        <div className="font-mono text-xs text-muted-foreground">
          {fromLabel} → {toLabel}{edge.condition ? ` · if ${edge.condition}` : ""}
        </div>
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <div className="font-medium text-foreground">{edge.ruleHeading}</div>
        {prose && <Markdown text={prose} file={spec.file} className="text-xs text-muted-foreground" />}
      </div>

      <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-md border border-border bg-muted/50 px-2.5 py-2 text-xs">
        <span className="text-muted-foreground">Story</span>
        <span className="truncate font-medium text-foreground">{edge.story}</span>
        {edge.sender && (
          <>
            <span className="text-muted-foreground">Sender</span>
            <span className="font-mono text-foreground">{edge.sender}</span>
          </>
        )}
        <span className="text-muted-foreground">Params</span>
        <span className="font-mono text-foreground">
          {edge.params.length ? edge.params.map((p) => `${p.name}: ${p.type}`).join(", ") : "none"}
        </span>
        {simEv && (
          <>
            <span className="text-muted-foreground">Live</span>
            <span className={cn("font-mono font-medium", simEv.allowed ? "text-ok" : "text-muted-foreground")}>
              {simEv.allowed ? "✓ enabled in live state" : "✗ disabled in live state"}
            </span>
          </>
        )}
      </div>

      {clauses.length > 0 && (
        <InspectorSection label={<span>Guard (<span className="font-mono">{edge.guard ?? "guard"}</span>)</span>}>
          <div className="flex flex-col gap-1">
            {clauses.map((clause) => {
              const ev = evaluateGuardClause(
                clause,
                sim.kind === "ready" ? sim.data.state : undefined,
                simEv?.sender ?? edge.sender,
                simEv?.allowed,
              );
              return (
                <div key={`${edge.id}-${clause}`} className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs">
                  <span className="min-w-0 font-mono break-all text-foreground">{clause}</span>
                  {ev.label && (
                    <span className={cn("shrink-0 font-mono", ev.status === "ok" ? "text-ok" : ev.status === "bad" ? "text-destructive" : "text-muted-foreground")}>
                      {ev.label}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </InspectorSection>
      )}

      {edge.liveness && (
        <InspectorSection label="Liveness">
          <div className="flex items-center justify-between rounded-md border border-warn/40 bg-background px-2.5 py-1.5 font-mono text-xs text-warn">
            <span>↝ {edge.liveness.rule}</span>
            <span>{edge.liveness.within !== undefined ? `within ${edge.liveness.within}` : edge.liveness.fair ?? "fair"}</span>
          </div>
        </InspectorSection>
      )}

      <InspectorSection label="Transition Quint">
        <Quint code={edge.quint} />
      </InspectorSection>

      {(graph.globalInvariants.length > 0 || graph.stepRules.length > 0) && (
        <InspectorSection label="Preserved Rules">
          <div className="flex flex-col gap-1">
            <RuleLinkList file={spec.file} items={graph.globalInvariants} glyph="∀" showCheck />
            <RuleLinkList file={spec.file} items={graph.stepRules} glyph="⊢" showCheck />
          </div>
        </InspectorSection>
      )}
    </div>
  );
}

function NodeInspector({
  spec,
  graph,
  node,
  activeNode,
  onSelectEdge,
  onStartTransition,
}: {
  spec: Working;
  graph: SpecModelGraph;
  node: GraphNode;
  activeNode?: string;
  onSelectEdge: (edgeId: string) => void;
  onStartTransition: (from: string) => void;
}) {
  const outgoing = graph.edges.filter((e) => e.from === node.id);
  const incoming = graph.edges.filter((e) => e.to === node.id && e.from !== node.id);
  const stateParam = (graph.stateType ?? "s")[0].toLowerCase();
  const stateType = graph.stateType ?? "State";
  const defaultStory = spec.outline.stories.find((s) => s.title.startsWith("Story:"))?.title ?? spec.outline.stories[0]?.title ?? "Story: State rules";
  const stateCond = graph.statusField
    ? `${stateParam}.${graph.statusField} == ${node.id}`
    : node.predicate?.replace(/&&/g, "and").replace(/!/g, "not ") ?? "true";

  const scaffoldInvariant = () => {
    const clean = node.id.replace(/[^A-Za-z0-9]/g, "");
    const heading = uniqueRuleHeading(spec, `${node.label} satisfies its invariant`);
    const defName = `always${cap(clean)}Holds`;
    const quint = `pure def ${defName}(${stateParam}: ${stateType}): bool =\n  (${stateCond}) implies true`;
    addRuleFromGraph(spec, defaultStory, heading, quint);
  };

  const scaffoldGoal = () => {
    const clean = node.id.replace(/[^A-Za-z0-9]/g, "");
    const heading = uniqueRuleHeading(spec, `The machine can reach ${node.label}`);
    const defName = `sometimes${cap(clean)}`;
    const quint = `pure def ${defName}(${stateParam}: ${stateType}): bool =\n  ${stateCond}`;
    addRuleFromGraph(spec, defaultStory, heading, quint);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 border-b border-border pb-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="truncate text-base font-semibold text-foreground">{node.label}</h2>
          <div className="flex items-center gap-1.5 font-mono text-xs">
            {node.initial && <span className="text-primary">init</span>}
            {activeNode === node.id && <span className="text-primary">● live</span>}
            {node.goal && <span className="text-ok">⚑ goal</span>}
          </div>
        </div>
        {node.predicate && <div className="font-mono text-xs text-muted-foreground">{node.predicate}</div>}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={scaffoldInvariant}>
          <Icon name="plus" className="size-3.5" /> Invariant
        </Button>
        <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={scaffoldGoal}>
          <Icon name="plus" className="size-3.5" /> Goal
        </Button>
        <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={() => onStartTransition(node.id)}>
          <Icon name="plus" className="size-3.5" /> Transition
        </Button>
      </div>

      <InspectorSection label={`Outgoing Transitions (${outgoing.length})`}>
        <EdgeLinkList
          edges={outgoing}
          onSelectEdge={onSelectEdge}
          describe={(e) => (e.selfLoop ? "↺ self" : `→ ${e.to}`)}
          empty="Terminal state (no outgoing transitions)"
        />
      </InspectorSection>

      <InspectorSection label={`Incoming Transitions (${incoming.length})`}>
        <EdgeLinkList
          edges={incoming}
          onSelectEdge={onSelectEdge}
          describe={(e) => `from ${e.from}`}
          empty="No incoming transitions from other states"
        />
      </InspectorSection>

      <InspectorSection label={`State Invariants (${node.invariants.length})`}>
        {node.invariants.length ? (
          <div className="flex flex-col gap-1">
            {node.invariants.map((inv) => (
              <div key={inv} className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground">∀ {inv}</div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">No state-scoped invariants</div>
        )}
      </InspectorSection>

      {node.goal && (
        <InspectorSection label="Reachability Goal">
          <div className="rounded-md border border-ok/40 bg-background px-2.5 py-1.5 text-xs text-ok">⚑ {node.goal}</div>
        </InspectorSection>
      )}
    </div>
  );
}

function TransitionComposer({
  spec,
  graph,
  initialFrom,
  initialTo,
  onDraftChange,
  onClose,
}: {
  spec: Working;
  graph: SpecModelGraph;
  initialFrom: string;
  initialTo: string;
  onDraftChange: (draft: DraftEdge) => void;
  onClose: () => void;
}) {
  const defaultStory = spec.outline.stories.find((s) => s.title.startsWith("Story:"))?.title ?? spec.outline.stories[0]?.title ?? "Story: Transitions";
  const [name, setName] = useState("refund");
  const [sender, setSender] = useState(graph.roles[graph.roles.length - 1] ?? "");
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [story, setStory] = useState(defaultStory);
  const [headingOverride, setHeadingOverride] = useState<string | null>(null);
  const [guardOverride, setGuardOverride] = useState<string | null>(null);
  const [updateOverride, setUpdateOverride] = useState<string | null>(null);

  const stateType = graph.stateType ?? "State";
  const stateParam = stateType[0].toLowerCase();
  const cleanName = name.trim().replace(/[^A-Za-z0-9_]/g, "") || "transition";
  const capName = cap(cleanName);
  const hasRoles = graph.roles.length > 0;
  const senderParam = hasRoles ? ", by: Role" : "";

  const defaultHeading = sender
    ? `${sender} can ${cleanName} from ${from} to ${to}`
    : `${capName} moves from ${from} to ${to}`;
  const defaultGuard = [
    ...(hasRoles && sender.trim() ? [`by == ${sender.trim()}`] : []),
    ...(graph.statusField && from.trim() ? [`${stateParam}.${graph.statusField} == ${from.trim()}`] : []),
  ].join(" and ") || "true";
  const defaultUpdate = graph.statusField && to.trim()
    ? `{ ...${stateParam}, ${graph.statusField}: ${to.trim()} }`
    : stateParam;

  const heading = headingOverride ?? defaultHeading;
  const guardExpr = guardOverride ?? defaultGuard;
  const updateExpr = updateOverride ?? defaultUpdate;

  const quint = [
    `pure def can${capName}(${stateParam}: ${stateType}${senderParam}): bool =`,
    `  ${guardExpr}`,
    `pure def ${cleanName}(${stateParam}: ${stateType}${senderParam}): ${stateType} =`,
    `  ${updateExpr}`,
  ].join("\n");

  const diffPreview = [
    `+ ### ${heading}`,
    "+",
    "+ ```quint",
    ...quint.split("\n").map((l) => `+ ${l}`),
    "+ ```",
  ].join("\n");

  const updateDraft = (next: DraftEdge) => onDraftChange(next);
  const storyTitles = spec.outline.stories.map((s) => s.title.trim()).filter(Boolean);
  const nodeIds = graph.nodes.map((n) => n.id);

  const handleApply = () => {
    if (!heading.trim() || !cleanName) return;
    const ok = addRuleFromGraph(spec, story, heading, quint);
    if (ok) onClose();
  };

  return (
    <ComposerShell
      title="New Transition"
      subtitle="Compiled directly into a ### rule + Quint block"
      file={spec.file}
      diffPreview={diffPreview}
      canApply={Boolean(heading.trim())}
      onApply={handleApply}
      onClose={onClose}
    >
      <div className={cn("grid gap-2", hasRoles ? "grid-cols-2" : "grid-cols-1")}>
        <ComposerField
          id="sg-tr-name"
          label="Event name"
          value={name}
          mono
          onChange={(v) => { setName(v); updateDraft({ name: v, from, to, sender: sender || undefined }); }}
        />
        {hasRoles && (
          <ComposerField
            id="sg-tr-sender"
            label="Sender"
            value={sender}
            mono
            onChange={(v) => { setSender(v); updateDraft({ name, from, to, sender: v || undefined }); }}
          >
            <div className="flex flex-wrap gap-1">
              {graph.roles.map((r) => (
                <Button key={r} variant={sender === r ? "secondary" : "ghost"} size="sm" className="h-5 px-1.5 font-mono text-xs"
                  onClick={() => { setSender(r); updateDraft({ name, from, to, sender: r }); }}>
                  {r}
                </Button>
              ))}
            </div>
          </ComposerField>
        )}
      </div>

      {nodeIds.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <ComposerField
            id="sg-tr-from"
            label="From state"
            value={from}
            mono
            onChange={(v) => { setFrom(v); updateDraft({ name, from: v, to, sender: sender || undefined }); }}
          >
            <div className="flex flex-wrap gap-1">
              {nodeIds.slice(0, 5).map((id) => (
                <Button key={id} variant={from === id ? "secondary" : "ghost"} size="sm" className="h-5 px-1.5 font-mono text-xs"
                  onClick={() => { setFrom(id); updateDraft({ name, from: id, to, sender: sender || undefined }); }}>
                  {id}
                </Button>
              ))}
            </div>
          </ComposerField>
          <ComposerField
            id="sg-tr-to"
            label="To state"
            value={to}
            mono
            onChange={(v) => { setTo(v); updateDraft({ name, from, to: v, sender: sender || undefined }); }}
          >
            <div className="flex flex-wrap gap-1">
              {nodeIds.slice(0, 5).map((id) => (
                <Button key={id} variant={to === id ? "secondary" : "ghost"} size="sm" className="h-5 px-1.5 font-mono text-xs"
                  onClick={() => { setTo(id); updateDraft({ name, from, to: id, sender: sender || undefined }); }}>
                  {id}
                </Button>
              ))}
            </div>
          </ComposerField>
        </div>
      )}

      <ComposerField id="sg-tr-story" label="Target Story" value={story} onChange={setStory}>
        {storyTitles.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {storyTitles.slice(0, 4).map((t) => (
              <Button key={t} variant={story === t ? "secondary" : "ghost"} size="sm" className="h-5 px-1.5 text-xs" onClick={() => setStory(t)}>
                {truncateText(t.replace(/^Story:\s*/, ""), 18)}
              </Button>
            ))}
          </div>
        )}
      </ComposerField>

      <ComposerField id="sg-tr-heading" label="Rule heading" value={heading} onChange={setHeadingOverride} />
      <ComposerField id="sg-tr-guard" label={<span>Guard (<span className="font-mono">can{capName}</span>)</span>} value={guardExpr} mono onChange={setGuardOverride} />
      <ComposerField id="sg-tr-update" label={<span>Update (<span className="font-mono">{cleanName}</span>)</span>} value={updateExpr} mono onChange={setUpdateOverride} />
    </ComposerShell>
  );
}

function StateComposer({ spec, graph, onClose }: { spec: Working; graph: SpecModelGraph; onClose: () => void }) {
  const defaultStory = spec.outline.stories.find((s) => s.title.startsWith("Story:"))?.title ?? spec.outline.stories[0]?.title ?? "Story: States";
  const [stateName, setStateName] = useState("Refunded");
  const [story, setStory] = useState(defaultStory);
  const [headingOverride, setHeadingOverride] = useState<string | null>(null);
  const [invOverride, setInvOverride] = useState<string | null>(null);

  const cleanState = cap(stateName.trim().replace(/[^A-Za-z0-9_]/g, "") || "NewState");
  const stateType = graph.stateType ?? "State";
  const stateParam = stateType[0].toLowerCase();
  const field = graph.statusField ?? "status";
  const heading = headingOverride ?? `A ${stateType.toLowerCase()} can be ${cleanState.toLowerCase()}`;
  const invExpr = invOverride ?? `${stateParam}.${field} == ${cleanState}`;
  const quint = `pure def sometimes${cleanState}(${stateParam}: ${stateType}): bool =\n  ${invExpr}`;
  const diffPreview = [`+ ### ${heading}`, "+", "+ ```quint", ...quint.split("\n").map((l) => `+ ${l}`), "+ ```"].join("\n");

  const handleApply = () => {
    if (!heading.trim()) return;
    const prose = `Introduces the \`${cleanState}\` state in \`${field}\`.`;
    const ok = addRuleFromGraph(spec, story, heading, quint, prose);
    if (ok) onClose();
  };

  return (
    <ComposerShell
      title="New State"
      subtitle="Scaffolds a state goal rule into the spec outline"
      file={spec.file}
      diffPreview={diffPreview}
      canApply={Boolean(heading.trim())}
      onApply={handleApply}
      onClose={onClose}
    >
      <ComposerField id="sg-st-name" label="State name" value={stateName} mono onChange={setStateName} />
      <ComposerField id="sg-st-story" label="Target Story" value={story} onChange={setStory} />
      <ComposerField id="sg-st-heading" label="Rule heading" value={heading} onChange={setHeadingOverride} />
      <ComposerField id="sg-st-expr" label="Reachability predicate" value={invExpr} mono onChange={setInvOverride} />
    </ComposerShell>
  );
}

function OverviewInspector({
  spec,
  graph,
  onSelectNode,
  onSelectEdge,
}: {
  spec: Working;
  graph: SpecModelGraph;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="border-b border-border pb-3">
        <h2 className="text-base font-semibold text-foreground">{graph.stateType ?? graph.module}</h2>
        <div className="font-mono text-xs text-muted-foreground">{graph.projectionLabel}</div>
      </div>

      {graph.stateFields.length > 0 && (
        <InspectorSection label="State Fields">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1 rounded-md border border-border bg-muted/50 px-2.5 py-2 font-mono text-xs">
            {graph.stateFields.map((f) => (
              <div key={f.name} className="contents">
                <span className="text-foreground">{f.name}</span>
                <span className="text-muted-foreground">{f.type}</span>
              </div>
            ))}
          </div>
        </InspectorSection>
      )}

      {graph.nodes.length > 0 && (
        <InspectorSection label={`States (${graph.nodes.length})`}>
          <div className="flex flex-wrap gap-1.5">
            {graph.nodes.map((n) => (
              <Button key={n.id} variant="outline" size="sm" className="h-7 px-2 font-mono text-xs" onClick={() => onSelectNode(n.id)}>
                {n.label}
              </Button>
            ))}
          </div>
        </InspectorSection>
      )}

      {graph.edges.length > 0 && (
        <InspectorSection label={`Transitions (${graph.edges.length})`}>
          <EdgeLinkList edges={graph.edges.slice(0, 8)} onSelectEdge={onSelectEdge} describe={(e) => `${e.from} → ${e.to}`} />
        </InspectorSection>
      )}

      {graph.globalInvariants.length > 0 && (
        <InspectorSection label={`Global Invariants (${graph.globalInvariants.length})`}>
          <div className="flex flex-col gap-1">
            <RuleLinkList file={spec.file} items={graph.globalInvariants} glyph="∀" />
          </div>
        </InspectorSection>
      )}

      {graph.goals.length > 0 && (
        <InspectorSection label={`Goals (${graph.goals.length})`}>
          <div className="flex flex-col gap-1">
            <RuleLinkList file={spec.file} items={graph.goals} glyph="⚑" tone="text-ok" />
          </div>
        </InspectorSection>
      )}
    </div>
  );
}

// --- Live Simulator Dock ----------------------------------------------------------------------------------------

function SimulatorDock({
  graph,
  sim,
  stepping,
  paramDrafts,
  onParamChange,
  onStep,
  onReset,
}: {
  graph: SpecModelGraph;
  sim: SimState;
  stepping: boolean;
  paramDrafts: Record<string, string>;
  onParamChange: (key: string, value: string) => void;
  onStep: (ev: NonNullable<SimResult["enabledEvents"]>[number]) => void;
  onReset: () => void;
}) {
  if (sim.kind === "loading") {
    return (
      <div className="flex items-center justify-between border-t border-border bg-card px-4 py-2.5 text-xs text-muted-foreground">
        <span>Loading simulator for <span className="font-mono">{graph.module}</span>…</span>
      </div>
    );
  }
  if (sim.kind === "unavailable") {
    return (
      <div className="flex items-center justify-between border-t border-border bg-card px-4 py-2.5 text-xs text-muted-foreground">
        <span>Simulation available after check</span>
        {sim.reason && <span className="truncate font-mono">{sim.reason}</span>}
      </div>
    );
  }

  const { data, stepCount } = sim;
  const enabled = (data.enabledEvents ?? []).filter((e) => e.allowed);
  const edgeByName = new Map(graph.edges.map((e) => [e.name, e]));

  return (
    <div className="flex flex-col gap-2 border-t border-border bg-card px-4 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="min-w-0 flex-1 truncate font-mono text-foreground" title={JSON.stringify(data.state)}>
          <span className="text-muted-foreground">state = </span>
          {formatStateCompact(data.state)}
        </div>
        <div className="flex shrink-0 items-center gap-2 font-mono">
          {stepCount > 0 && <span className="text-muted-foreground">step {stepCount}</span>}
          {data.inv !== undefined && (
            <span className={data.inv ? "text-ok" : "text-destructive"}>inv {data.inv ? "✓" : "✗"}</span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {enabled.length ? enabled.map((ev, idx) => {
          const edge = edgeByName.get(ev.name);
          const scalarParams = (edge?.params ?? []).filter((p) => p.type === "int" || p.type === "str").slice(0, 2);
          return (
            <div key={ev.name} className="inline-flex items-center gap-1">
              {scalarParams.map((p) => {
                const k = `${ev.name}.${p.name}`;
                const val = paramDrafts[k] ?? primitiveToString(ev.sampleEvent?.[p.name], p.type === "int" ? "1" : "Ada");
                return (
                  <Input
                    key={k}
                    aria-label={`${ev.name} ${p.name}`}
                    value={val}
                    type={p.type === "int" ? "number" : "text"}
                    className="h-7 w-16 px-1.5 font-mono text-xs"
                    onChange={(e) => onParamChange(k, e.target.value)}
                  />
                );
              })}
              <Button
                variant={idx === 0 ? "primary" : "outline"}
                size="sm"
                className="h-7 px-2.5 font-mono text-xs"
                disabled={stepping}
                onClick={() => onStep(ev)}
              >
                <Icon name="play" className="size-3" /> {ev.name}
              </Button>
            </div>
          );
        }) : (
          <span className="text-xs text-muted-foreground">No enabled transitions from this state</span>
        )}
        <span className="flex-1" />
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={stepping} onClick={onReset}>
          <Icon name="undo" className="size-3.5" /> Reset
        </Button>
      </div>
    </div>
  );
}

// --- Main StateGraph Workspace ----------------------------------------------------------------------------------

function defaultInspectorFor(graph: SpecModelGraph | undefined, focusNode?: string, focusEdge?: string): InspectorMode {
  if (!graph) return { kind: "overview" };
  if (focusEdge) {
    const match = graph.edges.find((e) => e.id === focusEdge || e.name === focusEdge);
    if (match) return { kind: "edge", edgeId: match.id };
  }
  if (focusNode) {
    const match = graph.nodes.find((n) => n.id === focusNode);
    if (match) return { kind: "node", nodeId: match.id };
  }
  const preferred = graph.edges.find((e) => !e.selfLoop) ?? graph.edges[0];
  if (preferred) return { kind: "edge", edgeId: preferred.id };
  if (graph.nodes[0]) return { kind: "node", nodeId: graph.nodes[0].id };
  return { kind: "overview" };
}

/** Interactive state machine view: toolbar, SVG canvas, live simulator dock, and contextual inspector/composer. */
export function StateGraph({ spec, graph }: { spec: Working; graph: SpecModelGraph | undefined }) {
  const [overlays, setOverlays] = useState({ guards: true, invariants: true, liveness: true });
  const focusKey = `${spec.file}|${S.focusNode ?? ""}|${S.focusEdge ?? ""}`;
  const [savedInspector, setSavedInspector] = useState<{ forKey: string; mode: InspectorMode } | undefined>(undefined);
  const [draftEdge, setDraftEdge] = useState<DraftEdge | undefined>(undefined);
  const [simEntry, setSimEntry] = useState<{ module: string; state: SimState } | undefined>(undefined);
  const [stepping, setStepping] = useState(false);
  const [paramDrafts, setParamDrafts] = useState<Record<string, string>>({});

  const moduleName = graph?.module ?? S.snap?.specs.find((s) => s.file === spec.file)?.module;
  const inspector = savedInspector?.forKey === focusKey
    ? savedInspector.mode
    : defaultInspectorFor(graph, S.focusNode, S.focusEdge);

  const setInspector = (mode: InspectorMode) => {
    setSavedInspector({ forKey: focusKey, mode });
    if (mode.kind !== "compose-transition") setDraftEdge(undefined);
  };

  const isLibrary = !graph || graph.projectionKind === "library";
  useEffect(() => {
    if (!moduleName || isLibrary) return;
    let cancelled = false;
    void postSim({ module: moduleName }).then(
      (data) => {
        if (cancelled) return;
        setSimEntry({
          module: moduleName,
          state: data.available ? { kind: "ready", data, stepCount: 0 } : { kind: "unavailable", reason: data.error },
        });
      },
      (err: unknown) => {
        if (cancelled) return;
        setSimEntry({
          module: moduleName,
          state: { kind: "unavailable", reason: err instanceof Error ? err.message : undefined },
        });
      },
    );
    return () => { cancelled = true; };
  }, [moduleName, isLibrary]);

  if (!graph || graph.projectionKind === "library") {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center p-8">
        <EmptyState title="No state machine in this spec" icon={<Icon name="graph" className="size-8" />}>
          <Button variant="outline" size="sm" onClick={() => reveal(spec.file)}>Open in Stories</Button>
        </EmptyState>
      </div>
    );
  }

  const sim: SimState = !moduleName
    ? { kind: "unavailable" }
    : simEntry?.module === moduleName
      ? simEntry.state
      : { kind: "loading" };

  const activeNode = sim.kind === "ready" ? sim.data.activeNode : graph.nodes.find((n) => n.initial)?.id;
  const selectedEdgeId = inspector.kind === "edge" ? inspector.edgeId : undefined;
  const selectedNodeId = inspector.kind === "node" ? inspector.nodeId : undefined;
  const uniqueTransitionCount = new Set(graph.edges.map((e) => e.name)).size;

  const openTransitionComposer = (from?: string) => {
    const startFrom = from ?? activeNode ?? graph.nodes[0]?.id ?? "";
    const startTo = graph.nodes.find((n) => n.id !== startFrom)?.id ?? startFrom;
    setDraftEdge({ name: "refund", from: startFrom, to: startTo, sender: graph.roles[graph.roles.length - 1] });
    setInspector({ kind: "compose-transition", from: startFrom, to: startTo });
  };

  const handleStep = (ev: NonNullable<SimResult["enabledEvents"]>[number]) => {
    if (!moduleName || sim.kind !== "ready") return;
    const edge = graph.edges.find((e) => e.name === ev.name);
    const eventPayload: Record<string, unknown> = { ...(ev.sampleEvent ?? { type: ev.name }) };
    for (const p of edge?.params ?? []) {
      const raw = paramDrafts[`${ev.name}.${p.name}`];
      if (raw === undefined) continue;
      if (p.type === "int") {
        const n = Number(raw);
        if (Number.isFinite(n)) eventPayload[p.name] = n;
      } else if (p.type === "str") {
        eventPayload[p.name] = raw;
      }
    }
    setStepping(true);
    void postSim({ module: moduleName, state: sim.data.state, event: eventPayload, by: ev.sender }).then(
      (data) => {
        setStepping(false);
        setSimEntry({
          module: moduleName,
          state: data.available ? { kind: "ready", data, stepCount: sim.stepCount + 1 } : { kind: "unavailable", reason: data.error },
        });
      },
      () => setStepping(false),
    );
  };

  const handleReset = () => {
    if (!moduleName) return;
    setStepping(true);
    setParamDrafts({});
    void postSim({ module: moduleName }).then(
      (data) => {
        setStepping(false);
        setSimEntry({
          module: moduleName,
          state: data.available ? { kind: "ready", data, stepCount: 0 } : { kind: "unavailable", reason: data.error },
        });
      },
      () => setStepping(false),
    );
  };

  const selectedEdgeObj = selectedEdgeId ? graph.edges.find((e) => e.id === selectedEdgeId) : undefined;
  const selectedNodeObj = selectedNodeId ? graph.nodes.find((n) => n.id === selectedNodeId) : undefined;

  return (
    <div className="flex min-h-0 w-full flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-4 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-foreground">{graph.projectionLabel}</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {graph.nodes.length} states · {uniqueTransitionCount} transitions
            </span>
            <span className="h-3.5 w-px bg-border" aria-hidden />
            {(["guards", "invariants", "liveness"] as const).map((key) => (
              <Button
                key={key}
                variant={overlays[key] ? "outline" : "ghost"}
                size="sm"
                className="h-7 px-2 text-xs capitalize"
                onClick={() => setOverlays((o) => ({ ...o, [key]: !o[key] }))}
              >
                {overlays[key] ? "✓ " : ""}{key}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={() => setInspector({ kind: "compose-state" })}>
              <Icon name="plus" className="size-3.5" /> State
            </Button>
            <Button variant="primary" size="sm" className="h-7 px-2.5 text-xs" onClick={() => openTransitionComposer()}>
              <Icon name="plus" className="size-3.5" /> Transition
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          <StateGraphCanvas
            graph={graph}
            activeNode={activeNode}
            selectedNode={selectedNodeId}
            selectedEdge={selectedEdgeId}
            showOverlays={overlays}
            draftEdge={inspector.kind === "compose-transition" ? draftEdge : undefined}
            onSelectNode={(nodeId) => setInspector({ kind: "node", nodeId })}
            onSelectEdge={(edgeId) => setInspector({ kind: "edge", edgeId })}
          />
        </div>

        <SimulatorDock
          graph={graph}
          sim={sim}
          stepping={stepping}
          paramDrafts={paramDrafts}
          onParamChange={(k, v) => setParamDrafts((d) => ({ ...d, [k]: v }))}
          onStep={handleStep}
          onReset={handleReset}
        />
      </div>

      <aside aria-label="State machine inspector" className="w-87 shrink-0 overflow-y-auto border-l border-border bg-card p-4 max-xl:w-80">
        {inspector.kind === "compose-transition" ? (
          <TransitionComposer
            key={`${inspector.from}->${inspector.to}`}
            spec={spec}
            graph={graph}
            initialFrom={inspector.from}
            initialTo={inspector.to}
            onDraftChange={setDraftEdge}
            onClose={() => setInspector(defaultInspectorFor(graph))}
          />
        ) : inspector.kind === "compose-state" ? (
          <StateComposer spec={spec} graph={graph} onClose={() => setInspector(defaultInspectorFor(graph))} />
        ) : selectedEdgeObj ? (
          <EdgeInspector spec={spec} graph={graph} edge={selectedEdgeObj} sim={sim} />
        ) : selectedNodeObj ? (
          <NodeInspector
            spec={spec}
            graph={graph}
            node={selectedNodeObj}
            activeNode={activeNode}
            onSelectEdge={(edgeId) => setInspector({ kind: "edge", edgeId })}
            onStartTransition={(from) => openTransitionComposer(from)}
          />
        ) : (
          <OverviewInspector
            spec={spec}
            graph={graph}
            onSelectNode={(nodeId) => setInspector({ kind: "node", nodeId })}
            onSelectEdge={(edgeId) => setInspector({ kind: "edge", edgeId })}
          />
        )}
      </aside>
    </div>
  );
}
