import {
  Crown,
  Fingerprint,
  Frown,
  Link2,
  Meh,
  MessageCircle,
  Minus,
  Plus,
  Smile,
} from "lucide-react";
import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  RelationshipsGraphEdge,
  RelationshipsGraphSnapshot,
  RelationshipsPersonSummary,
} from "../../api/client-types-relationships";
import { Button } from "../ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";

const GRAPH_WIDTH = 1320;
const GRAPH_HEIGHT = 760;
const GRAPH_PADDING = 92;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.0;
const ZOOM_STEP = 0.12;
const WHEEL_ZOOM_FACTOR = 0.0015;
const MAX_GLOBAL_NODES = 60;
const MAX_FOCUSED_NODES = 60;
const MAX_DIRECT_NEIGHBORS = 36;
const MAX_SECOND_WAVE_NEIGHBORS = 18;

type GraphPosition = {
  x: number;
  y: number;
};

type VisibleGraph = {
  people: RelationshipsPersonSummary[];
  relationships: RelationshipsGraphEdge[];
  modeLabel: string;
  truncated: boolean;
};

const EDGE_COLORS = {
  positive: "rgba(34, 197, 94, 0.64)",
  neutral: "rgba(240, 185, 11, 0.48)",
  negative: "rgba(239, 68, 68, 0.62)",
} as const;

type EdgeTone = keyof typeof EDGE_COLORS;

function toTimestamp(value?: string): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function nodeRadius(person: RelationshipsPersonSummary): number {
  return Math.min(
    46,
    18 +
      Math.sqrt(
        Math.max(
          1,
          person.memberEntityIds.length * 2 + person.relationshipCount * 3,
        ),
      ) *
        4,
  );
}

function shortLabel(value: string, maxLength = 18): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function edgeTone(sentiment: string): EdgeTone {
  if (sentiment === "positive" || sentiment === "negative") return sentiment;
  return "neutral";
}

function edgeColor(edge: RelationshipsGraphEdge): string {
  return EDGE_COLORS[edgeTone(edge.sentiment)];
}

function nodeInitials(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const source =
    words.length >= 2
      ? `${words[0]?.charAt(0) ?? ""}${words[1]?.charAt(0) ?? ""}`
      : value.trim().slice(0, 2);
  return source.toUpperCase();
}

function rankPerson(person: RelationshipsPersonSummary): number {
  return (
    person.relationshipCount * 10 +
    person.memberEntityIds.length * 4 +
    person.factCount * 2 +
    toTimestamp(person.lastInteractionAt) / 1000000000000
  );
}

function sortEdges(edges: RelationshipsGraphEdge[]): RelationshipsGraphEdge[] {
  return [...edges].sort((left, right) => {
    const strengthDiff = right.strength - left.strength;
    if (strengthDiff !== 0) return strengthDiff;
    const interactionDiff = right.interactionCount - left.interactionCount;
    if (interactionDiff !== 0) return interactionDiff;
    return (
      toTimestamp(right.lastInteractionAt) - toTimestamp(left.lastInteractionAt)
    );
  });
}

function otherEndpoint(edge: RelationshipsGraphEdge, personId: string): string {
  return edge.sourcePersonId === personId
    ? edge.targetPersonId
    : edge.sourcePersonId;
}

function buildEdgeIndex(
  edges: RelationshipsGraphEdge[],
): Map<string, RelationshipsGraphEdge[]> {
  const index = new Map<string, RelationshipsGraphEdge[]>();
  for (const edge of edges) {
    if (!index.has(edge.sourcePersonId)) {
      index.set(edge.sourcePersonId, []);
    }
    if (!index.has(edge.targetPersonId)) {
      index.set(edge.targetPersonId, []);
    }
    index.get(edge.sourcePersonId)?.push(edge);
    index.get(edge.targetPersonId)?.push(edge);
  }
  return index;
}

function buildVisibleGraph(
  snapshot: RelationshipsGraphSnapshot,
  included: Set<string>,
  modeLabel: string,
): VisibleGraph {
  const people = snapshot.people.filter((person) =>
    included.has(person.groupId),
  );
  return {
    people,
    relationships: snapshot.relationships.filter(
      (edge) =>
        included.has(edge.sourcePersonId) && included.has(edge.targetPersonId),
    ),
    modeLabel,
    truncated: people.length < snapshot.people.length,
  };
}

function selectVisibleGraph(
  snapshot: RelationshipsGraphSnapshot,
  selectedGroupId: string | null,
): VisibleGraph {
  const edgeIndex = buildEdgeIndex(snapshot.relationships);
  const peopleById = new Map(
    snapshot.people.map((person) => [person.groupId, person]),
  );
  const rankedPeople = [...snapshot.people].sort(
    (left, right) => rankPerson(right) - rankPerson(left),
  );
  const included = new Set<string>();

  if (selectedGroupId && peopleById.has(selectedGroupId)) {
    included.add(selectedGroupId);
    const directEdges = sortEdges(edgeIndex.get(selectedGroupId) ?? []);
    for (const edge of directEdges.slice(0, MAX_DIRECT_NEIGHBORS)) {
      included.add(otherEndpoint(edge, selectedGroupId));
    }

    const secondWaveScores = new Map<string, number>();
    for (const groupId of included) {
      if (groupId === selectedGroupId) continue;
      for (const edge of edgeIndex.get(groupId) ?? []) {
        const neighborId = otherEndpoint(edge, groupId);
        if (included.has(neighborId)) continue;
        const score =
          edge.strength * 6 +
          Math.log1p(edge.interactionCount) * 2 +
          (edge.sentiment === "positive" ? 0.75 : 0);
        secondWaveScores.set(
          neighborId,
          (secondWaveScores.get(neighborId) ?? 0) + score,
        );
      }
    }

    const secondWave = Array.from(secondWaveScores.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_SECOND_WAVE_NEIGHBORS)
      .map(([groupId]) => groupId);
    for (const groupId of secondWave) {
      included.add(groupId);
    }

    for (const person of rankedPeople) {
      if (included.size >= MAX_FOCUSED_NODES) break;
      included.add(person.groupId);
    }

    return buildVisibleGraph(
      snapshot,
      included,
      `Focused on ${peopleById.get(selectedGroupId)?.displayName ?? "selected person"}`,
    );
  }

  if (snapshot.people.length <= MAX_GLOBAL_NODES) {
    return {
      people: snapshot.people,
      relationships: snapshot.relationships,
      modeLabel: "All visible people",
      truncated: false,
    };
  }

  for (const person of rankedPeople) {
    if (included.size >= MAX_GLOBAL_NODES) break;
    included.add(person.groupId);
  }
  for (const edge of sortEdges(snapshot.relationships)) {
    if (included.size >= MAX_GLOBAL_NODES) break;
    included.add(edge.sourcePersonId);
    included.add(edge.targetPersonId);
  }

  return buildVisibleGraph(snapshot, included, "Most connected subgraph");
}

function buildConnectedComponents(
  people: RelationshipsPersonSummary[],
  edges: RelationshipsGraphEdge[],
): string[][] {
  const adjacency = new Map<string, Set<string>>();
  for (const person of people) {
    adjacency.set(person.groupId, new Set());
  }
  for (const edge of edges) {
    adjacency.get(edge.sourcePersonId)?.add(edge.targetPersonId);
    adjacency.get(edge.targetPersonId)?.add(edge.sourcePersonId);
  }

  const components: string[][] = [];
  const visited = new Set<string>();
  for (const person of people) {
    if (visited.has(person.groupId)) {
      continue;
    }
    const queue = [person.groupId];
    const component: string[] = [];
    visited.add(person.groupId);
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
    components.push(component);
  }

  return components.sort((left, right) => right.length - left.length);
}

function seededUnit(seed: string, salt: number): number {
  let hash = 2166136261 ^ salt;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000) / 1000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type SimulationNode = GraphPosition & {
  vx: number;
  vy: number;
  pinned: boolean;
};

function runForceLayout(
  componentPeople: RelationshipsPersonSummary[],
  componentEdges: RelationshipsGraphEdge[],
  center: GraphPosition,
  options: {
    width: number;
    height: number;
    pinnedGroupId?: string | null;
    iterations?: number;
  },
): Map<string, GraphPosition> {
  const { width, height, pinnedGroupId, iterations = 320 } = options;
  const positions = new Map<string, SimulationNode>();
  if (componentPeople.length === 1) {
    const only = componentPeople[0];
    positions.set(only.groupId, {
      x: center.x,
      y: center.y,
      vx: 0,
      vy: 0,
      pinned: true,
    });
    return new Map(
      Array.from(positions, ([groupId, position]) => [
        groupId,
        { x: position.x, y: position.y },
      ]),
    );
  }

  // Strength-weighted seed: stronger neighbors of the pinned node start closer.
  for (const person of componentPeople) {
    if (person.groupId === pinnedGroupId) {
      positions.set(person.groupId, {
        x: center.x,
        y: center.y,
        vx: 0,
        vy: 0,
        pinned: true,
      });
      continue;
    }
    const seedAngle = seededUnit(person.groupId, 3) * Math.PI * 2;
    const seedRadius =
      (0.18 + seededUnit(person.groupId, 4) * 0.36) *
      Math.min(width, height) *
      0.5;
    positions.set(person.groupId, {
      x: center.x + Math.cos(seedAngle) * seedRadius,
      y: center.y + Math.sin(seedAngle) * seedRadius,
      vx: 0,
      vy: 0,
      pinned: false,
    });
  }

  const edgeStrengthByPair = new Map<string, number>();
  for (const edge of componentEdges) {
    const key =
      edge.sourcePersonId < edge.targetPersonId
        ? `${edge.sourcePersonId}|${edge.targetPersonId}`
        : `${edge.targetPersonId}|${edge.sourcePersonId}`;
    edgeStrengthByPair.set(
      key,
      Math.max(edgeStrengthByPair.get(key) ?? 0, edge.strength),
    );
  }

  const peopleCount = componentPeople.length;
  const halfWidth = width * 0.46;
  const halfHeight = height * 0.46;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const cooling = 1 - iteration / (iterations * 1.4);
    const forces = new Map<string, { x: number; y: number }>();
    for (const person of componentPeople) {
      forces.set(person.groupId, { x: 0, y: 0 });
    }

    // Repulsion: every pair pushes apart, scaled to keep readable spacing.
    for (let leftIndex = 0; leftIndex < peopleCount; leftIndex += 1) {
      const left = componentPeople[leftIndex];
      const leftPosition = positions.get(left.groupId);
      const leftForces = forces.get(left.groupId);
      if (!leftPosition || !leftForces) continue;
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < peopleCount;
        rightIndex += 1
      ) {
        const right = componentPeople[rightIndex];
        const rightPosition = positions.get(right.groupId);
        const rightForces = forces.get(right.groupId);
        if (!rightPosition || !rightForces) continue;

        const dx = rightPosition.x - leftPosition.x;
        const dy = rightPosition.y - leftPosition.y;
        const distance = Math.max(8, Math.hypot(dx, dy));
        const minimumDistance = nodeRadius(left) + nodeRadius(right) + 64;
        const repulsion = minimumDistance * minimumDistance * 1.4;
        const forceMagnitude = repulsion / (distance * distance);
        const fx = (dx / distance) * forceMagnitude;
        const fy = (dy / distance) * forceMagnitude;
        leftForces.x -= fx;
        leftForces.y -= fy;
        rightForces.x += fx;
        rightForces.y += fy;
      }
    }

    // Spring attraction: stronger edges pull harder + sit closer.
    for (const edge of componentEdges) {
      const sourcePosition = positions.get(edge.sourcePersonId);
      const targetPosition = positions.get(edge.targetPersonId);
      const sourceForces = forces.get(edge.sourcePersonId);
      const targetForces = forces.get(edge.targetPersonId);
      if (
        !sourcePosition ||
        !targetPosition ||
        !sourceForces ||
        !targetForces
      ) {
        continue;
      }
      const dx = targetPosition.x - sourcePosition.x;
      const dy = targetPosition.y - sourcePosition.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const strength = clamp(edge.strength, 0.05, 1);
      // Strong edges pull to ~110px, weak edges drift to ~260px.
      const idealDistance = 280 - strength * 170;
      const springStrength = 0.012 + strength * 0.06;
      const forceMagnitude = (distance - idealDistance) * springStrength;
      const fx = (dx / distance) * forceMagnitude;
      const fy = (dy / distance) * forceMagnitude;
      sourceForces.x += fx;
      sourceForces.y += fy;
      targetForces.x -= fx;
      targetForces.y -= fy;
    }

    // Mild centering — keeps disconnected stragglers from drifting forever.
    for (const person of componentPeople) {
      const position = positions.get(person.groupId);
      const force = forces.get(person.groupId);
      if (!position || !force) continue;
      force.x += (center.x - position.x) * 0.012;
      force.y += (center.y - position.y) * 0.012;
    }

    // Integrate.
    for (const person of componentPeople) {
      const position = positions.get(person.groupId);
      const force = forces.get(person.groupId);
      if (!position || !force) continue;
      if (position.pinned) {
        position.x = center.x;
        position.y = center.y;
        position.vx = 0;
        position.vy = 0;
        continue;
      }
      const damping = 0.78 + 0.16 * cooling;
      position.vx = (position.vx + force.x * 0.04) * damping;
      position.vy = (position.vy + force.y * 0.04) * damping;
      position.x = clamp(
        position.x + position.vx,
        center.x - halfWidth,
        center.x + halfWidth,
      );
      position.y = clamp(
        position.y + position.vy,
        center.y - halfHeight,
        center.y + halfHeight,
      );
    }
  }

  return new Map(
    Array.from(positions, ([groupId, position]) => [
      groupId,
      { x: position.x, y: position.y },
    ]),
  );
}

function buildFocusedNodePositions(
  people: RelationshipsPersonSummary[],
  edges: RelationshipsGraphEdge[],
  selectedGroupId: string,
): Map<string, GraphPosition> | null {
  if (!people.some((person) => person.groupId === selectedGroupId)) {
    return null;
  }
  const center = { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 };
  return runForceLayout(people, edges, center, {
    width: GRAPH_WIDTH - GRAPH_PADDING,
    height: GRAPH_HEIGHT - GRAPH_PADDING,
    pinnedGroupId: selectedGroupId,
    iterations: 360,
  });
}

function buildNodePositions(
  people: RelationshipsPersonSummary[],
  edges: RelationshipsGraphEdge[],
  selectedGroupId: string | null,
): Map<string, GraphPosition> {
  if (selectedGroupId) {
    const focusedPositions = buildFocusedNodePositions(
      people,
      edges,
      selectedGroupId,
    );
    if (focusedPositions) {
      return focusedPositions;
    }
  }

  const components = buildConnectedComponents(people, edges);
  const peopleById = new Map(people.map((person) => [person.groupId, person]));
  const componentCount = Math.max(components.length, 1);
  const columns = Math.ceil(Math.sqrt(componentCount));
  const rows = Math.ceil(componentCount / columns);
  const innerWidth = GRAPH_WIDTH - GRAPH_PADDING * 2;
  const innerHeight = GRAPH_HEIGHT - GRAPH_PADDING * 2;
  const cellWidth = innerWidth / columns;
  const cellHeight = innerHeight / rows;
  const positions = new Map<string, GraphPosition>();

  components.forEach((component, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const center = {
      x: GRAPH_PADDING + cellWidth * (column + 0.5),
      y: GRAPH_PADDING + cellHeight * (row + 0.5),
    };
    const componentPeople = component
      .map((groupId) => peopleById.get(groupId))
      .filter(
        (person): person is RelationshipsPersonSummary => person !== undefined,
      );
    const componentSet = new Set(component);
    const componentEdges = edges.filter(
      (edge) =>
        componentSet.has(edge.sourcePersonId) &&
        componentSet.has(edge.targetPersonId),
    );
    const componentPositions = runForceLayout(
      componentPeople,
      componentEdges,
      center,
      {
        width: cellWidth,
        height: cellHeight,
        pinnedGroupId: null,
        iterations: 280,
      },
    );
    for (const [groupId, position] of componentPositions) {
      positions.set(groupId, position);
    }
  });

  return positions;
}

function GraphIconButton({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 w-8 rounded-full p-0"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function GraphLegend() {
  const items: Array<{ icon: ReactNode; label: string }> = [
    {
      icon: <Crown className="h-3.5 w-3.5 text-[rgba(99,102,241,0.86)]" />,
      label: "Owner",
    },
    {
      icon: <Smile className="h-3.5 w-3.5 text-[rgba(34,197,94,0.9)]" />,
      label: "Positive",
    },
    {
      icon: <Meh className="h-3.5 w-3.5 text-[rgba(240,185,11,0.9)]" />,
      label: "Neutral",
    },
    {
      icon: <Frown className="h-3.5 w-3.5 text-[rgba(239,68,68,0.9)]" />,
      label: "Negative",
    },
  ];
  return (
    <div className="flex items-center gap-1">
      {items.map((item) => (
        <Tooltip key={item.label}>
          <TooltipTrigger asChild>
            <span
              role="img"
              aria-label={item.label}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border/24 bg-card/40"
            >
              {item.icon}
            </span>
          </TooltipTrigger>
          <TooltipContent>{item.label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

type TooltipState =
  | { kind: "node"; person: RelationshipsPersonSummary; x: number; y: number }
  | { kind: "edge"; edge: RelationshipsGraphEdge; x: number; y: number }
  | null;

function GraphTooltip({ state }: { state: TooltipState }) {
  if (!state) return null;

  const style: CSSProperties = {
    position: "absolute",
    left: state.x,
    top: state.y,
    transform: "translate(-50%, -100%) translateY(-12px)",
    pointerEvents: "none",
    zIndex: 50,
  };

  if (state.kind === "node") {
    const { person } = state;
    return (
      <div
        style={style}
        className="rounded-xl border border-border/40 bg-card/95 px-3 py-2.5 shadow-lg backdrop-blur-md"
      >
        <div className="flex items-center gap-1.5 text-sm font-semibold text-txt">
          {person.isOwner ? (
            <Crown className="h-3.5 w-3.5 text-[rgba(99,102,241,0.86)]" />
          ) : null}
          {person.displayName}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-2xs text-muted">
          <span className="inline-flex items-center gap-1">
            <Fingerprint className="h-3 w-3" />
            {person.memberEntityIds.length}
          </span>
          <span className="inline-flex items-center gap-1">
            <Link2 className="h-3 w-3" />
            {person.relationshipCount}
          </span>
          <span className="inline-flex items-center gap-1">
            <MessageCircle className="h-3 w-3" />
            {person.factCount}
          </span>
        </div>
      </div>
    );
  }

  const { edge } = state;
  const SentimentIcon =
    edge.sentiment === "positive"
      ? Smile
      : edge.sentiment === "negative"
        ? Frown
        : Meh;
  return (
    <div
      style={style}
      className="rounded-xl border border-border/40 bg-card/95 px-3 py-2.5 shadow-lg backdrop-blur-md"
    >
      <div className="text-sm font-semibold text-txt">
        {edge.sourcePersonName} / {edge.targetPersonName}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-2xs text-muted">
        <span
          className="inline-flex items-center gap-1"
          style={{ color: EDGE_COLORS[edgeTone(edge.sentiment)] }}
        >
          <SentimentIcon className="h-3 w-3" />
          {Math.round(edge.strength * 100)}%
        </span>
        <span className="inline-flex items-center gap-1">
          <MessageCircle className="h-3 w-3" />
          {edge.interactionCount}
        </span>
      </div>
    </div>
  );
}

export function RelationshipsGraphPanel({
  snapshot,
  selectedGroupId,
  compact = false,
  onSelectPersonId,
}: {
  snapshot: RelationshipsGraphSnapshot;
  selectedGroupId: string | null;
  compact?: boolean;
  onSelectPersonId: (primaryEntityId: string) => void;
}) {
  const [tooltip, setTooltip] = useState<TooltipState>(null);
  const fittedZoom = compact ? 0.68 : 0.9;
  const [zoom, setZoom] = useState(fittedZoom);

  const visibleGraph = useMemo(
    () => selectVisibleGraph(snapshot, selectedGroupId),
    [snapshot, selectedGroupId],
  );

  const positions = useMemo(
    () =>
      buildNodePositions(
        visibleGraph.people,
        visibleGraph.relationships,
        selectedGroupId,
      ),
    [selectedGroupId, visibleGraph],
  );

  const directNeighborIds = useMemo(() => {
    const ids = new Set<string>();
    if (!visibleGraph || !selectedGroupId) {
      return ids;
    }
    for (const edge of visibleGraph.relationships) {
      if (
        edge.sourcePersonId === selectedGroupId ||
        edge.targetPersonId === selectedGroupId
      ) {
        ids.add(otherEndpoint(edge, selectedGroupId));
      }
    }
    return ids;
  }, [selectedGroupId, visibleGraph]);

  const showTooltipForNode = (
    person: RelationshipsPersonSummary,
    event: MouseEvent,
  ) => {
    const container = event.currentTarget.closest("[data-graph-container]");
    if (!container) return;
    const rect = container.getBoundingClientRect();
    setTooltip({
      kind: "node",
      person,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };

  const showTooltipForEdge = (
    edge: RelationshipsGraphEdge,
    event: MouseEvent,
  ) => {
    const container = event.currentTarget.closest("[data-graph-container]");
    if (!container) return;
    const rect = container.getBoundingClientRect();
    setTooltip({
      kind: "edge",
      edge,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };

  const hideTooltip = () => setTooltip(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const shouldSuppressClickRef = useRef(false);
  const panStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
    moved: boolean;
  } | null>(null);
  const pinchStateRef = useRef<{
    startDistance: number;
    startZoom: number;
  } | null>(null);

  const activePointerPoints = (): Array<{ x: number; y: number }> =>
    Array.from(pointersRef.current.values());

  const distanceBetweenPointers = (): number => {
    const points = Array.from(pointersRef.current.values());
    if (points.length < 2) return 0;
    const [a, b] = points;
    return Math.hypot(b.x - a.x, b.y - a.y);
  };

  const pointerCenter = (): { x: number; y: number } | null => {
    const points = activePointerPoints();
    if (points.length < 2) return null;
    const [a, b] = points;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  const viewportCenter = (): { x: number; y: number } | null => {
    const container = containerRef.current;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  };

  const zoomTo = useCallback(
    (nextZoom: number, focalPoint: { x: number; y: number } | null = null) => {
      const container = containerRef.current;
      const clampedZoom = Number(
        clamp(nextZoom, MIN_ZOOM, MAX_ZOOM).toFixed(3),
      );

      if (!container || !focalPoint) {
        setZoom(clampedZoom);
        return;
      }

      const rect = container.getBoundingClientRect();
      const offsetX = focalPoint.x - rect.left;
      const offsetY = focalPoint.y - rect.top;

      setZoom((currentZoom) => {
        const graphX = (container.scrollLeft + offsetX) / currentZoom;
        const graphY = (container.scrollTop + offsetY) / currentZoom;
        window.requestAnimationFrame(() => {
          container.scrollLeft = graphX * clampedZoom - offsetX;
          container.scrollTop = graphY * clampedZoom - offsetY;
        });
        return clampedZoom;
      });
    },
    [],
  );

  const cancelPan = () => {
    panStateRef.current = null;
  };

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const container = containerRef.current;
    if (!container) return;

    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    if (pointersRef.current.size === 1) {
      panStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        scrollLeft: container.scrollLeft,
        scrollTop: container.scrollTop,
        moved: false,
      };
    } else if (pointersRef.current.size === 2) {
      cancelPan();
      pinchStateRef.current = {
        startDistance: distanceBetweenPointers(),
        startZoom: zoom,
      };
      hideTooltip();
    }
  };

  const updatePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointersRef.current.has(event.pointerId)) {
      pointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
    }

    const pinch = pinchStateRef.current;
    if (pinch && pointersRef.current.size >= 2) {
      const distance = distanceBetweenPointers();
      if (pinch.startDistance > 0 && distance > 0) {
        zoomTo(
          pinch.startZoom * (distance / pinch.startDistance),
          pointerCenter(),
        );
      }
      return;
    }

    const state = panStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const container = containerRef.current;
    if (!container) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (!state.moved && Math.hypot(dx, dy) > 4) {
      state.moved = true;
      hideTooltip();
      container.setPointerCapture(event.pointerId);
    }
    if (state.moved) {
      container.scrollLeft = state.scrollLeft - dx;
      container.scrollTop = state.scrollTop - dy;
    }
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) {
      pinchStateRef.current = null;
    }
    const state = panStateRef.current;
    if (state && state.pointerId === event.pointerId) {
      const container = containerRef.current;
      if (container?.hasPointerCapture(event.pointerId)) {
        container.releasePointerCapture(event.pointerId);
      }
      if (state.moved) {
        shouldSuppressClickRef.current = true;
        window.setTimeout(() => {
          shouldSuppressClickRef.current = false;
        }, 0);
      }
      panStateRef.current = null;
    }
  };

  const leavePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) return;
    endPan(event);
  };

  // Attach a non-passive wheel listener so we can preventDefault native scroll/zoom.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: globalThis.WheelEvent) => {
      if (Math.abs(event.deltaY) === 0) return;
      event.preventDefault();
      event.stopPropagation();
      setTooltip(null);
      zoomTo(zoom * (1 - event.deltaY * WHEEL_ZOOM_FACTOR), {
        x: event.clientX,
        y: event.clientY,
      });
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [zoom, zoomTo]);

  const zoomOut = () => zoomTo(zoom - ZOOM_STEP, viewportCenter());
  const zoomIn = () => zoomTo(zoom + ZOOM_STEP, viewportCenter());
  const handleZoomPercentClick = () =>
    zoomTo(
      Math.abs(zoom - fittedZoom) < 0.01 ? 1 : fittedZoom,
      viewportCenter(),
    );
  const zoomPercent = `${Math.round(zoom * 100)}%`;
  const graphWidth = GRAPH_WIDTH * zoom;
  const graphHeight = GRAPH_HEIGHT * zoom;

  return (
    <TooltipProvider delayDuration={160} skipDelayDuration={80}>
      <div className={compact ? "space-y-3" : "space-y-4"}>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <GraphLegend />
          <div className="inline-flex items-center gap-0.5 rounded-full border border-border/24 bg-card/40 px-1 py-0.5">
            <GraphIconButton
              label="Zoom out"
              disabled={zoom <= MIN_ZOOM}
              onClick={zoomOut}
            >
              <Minus className="h-3.5 w-3.5" />
            </GraphIconButton>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleZoomPercentClick}
                  className="min-w-10 rounded-full px-1 text-2xs font-semibold tabular-nums text-muted transition hover:text-txt"
                  aria-label="Toggle zoom (fit / 100%)"
                >
                  {zoomPercent}
                </button>
              </TooltipTrigger>
              <TooltipContent>Toggle fit / 100%</TooltipContent>
            </Tooltip>
            <GraphIconButton
              label="Zoom in"
              disabled={zoom >= MAX_ZOOM}
              onClick={zoomIn}
            >
              <Plus className="h-3.5 w-3.5" />
            </GraphIconButton>
          </div>
        </div>

        {/* biome-ignore lint/a11y/noStaticElementInteractions: graph container handles tooltip dismiss on mouse leave */}
        <div
          ref={containerRef}
          className={`${compact ? "max-h-[34rem]" : "max-h-[42rem]"} relative cursor-grab touch-none overflow-auto overscroll-contain rounded-2xl border border-border/26 bg-[radial-gradient(circle_at_top,rgba(240,185,11,0.12),transparent_42%),linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,transparent),color-mix(in_srgb,var(--bg)_97%,transparent))] active:cursor-grabbing`}
          data-graph-container
          onMouseLeave={hideTooltip}
          onPointerDown={beginPan}
          onPointerMove={updatePan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onPointerLeave={leavePan}
        >
          <GraphTooltip state={tooltip} />
          <svg
            viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
            className="block max-w-none"
            style={{ width: graphWidth, height: graphHeight }}
            role="img"
            aria-label="Relationships graph"
          >
            <defs>
              <radialGradient
                id="relationships-node-fill"
                cx="50%"
                cy="35%"
                r="70%"
              >
                <stop offset="0%" stopColor="rgba(255,240,199,0.96)" />
                <stop offset="100%" stopColor="rgba(240,185,11,0.9)" />
              </radialGradient>
              <radialGradient
                id="relationships-owner-fill"
                cx="50%"
                cy="35%"
                r="70%"
              >
                <stop offset="0%" stopColor="rgba(199,210,255,0.98)" />
                <stop offset="100%" stopColor="rgba(99,102,241,0.86)" />
              </radialGradient>
            </defs>

            {visibleGraph.relationships.map((edge) => {
              const source = positions.get(edge.sourcePersonId);
              const target = positions.get(edge.targetPersonId);
              if (!source || !target) {
                return null;
              }
              const touchesSelected =
                selectedGroupId !== null &&
                (edge.sourcePersonId === selectedGroupId ||
                  edge.targetPersonId === selectedGroupId);
              return (
                <g key={edge.id}>
                  <line
                    x1={source.x}
                    y1={source.y}
                    x2={target.x}
                    y2={target.y}
                    stroke={edgeColor(edge)}
                    strokeWidth={Math.max(
                      touchesSelected ? 3 : 1.5,
                      edge.strength * (touchesSelected ? 8 : 5.5),
                    )}
                    strokeLinecap="round"
                    opacity={
                      selectedGroupId ? (touchesSelected ? 0.95 : 0.24) : 0.78
                    }
                  />
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: SVG edge hover for tooltip display only */}
                  <line
                    x1={source.x}
                    y1={source.y}
                    x2={target.x}
                    y2={target.y}
                    stroke="transparent"
                    strokeWidth={18}
                    className="cursor-pointer"
                    onMouseEnter={(event) => showTooltipForEdge(edge, event)}
                    onMouseMove={(event) => showTooltipForEdge(edge, event)}
                    onMouseLeave={hideTooltip}
                  />
                </g>
              );
            })}

            {visibleGraph.people.map((person) => {
              const position = positions.get(person.groupId);
              if (!position) {
                return null;
              }
              const selected = selectedGroupId === person.groupId;
              const directlyConnected = directNeighborIds.has(person.groupId);
              const muted =
                selectedGroupId !== null && !selected && !directlyConnected;
              const radius = nodeRadius(person) + (selected ? 6 : 0);
              const isOwner = person.isOwner;
              const showLabel = isOwner || selected || directlyConnected;
              return (
                <g key={person.groupId}>
                  <g
                    transform={`translate(${position.x}, ${position.y})`}
                    className="pointer-events-none"
                    opacity={muted ? 0.52 : 1}
                  >
                    <circle
                      r={radius + (selected ? 18 : directlyConnected ? 8 : 0)}
                      fill="transparent"
                      stroke={
                        selected
                          ? "rgba(240,185,11,0.52)"
                          : directlyConnected
                            ? "rgba(34,197,94,0.38)"
                            : "transparent"
                      }
                      strokeWidth={selected ? 3 : directlyConnected ? 2 : 0}
                    />
                    {isOwner ? (
                      <circle
                        r={radius + 11}
                        fill="transparent"
                        stroke="rgba(99,102,241,0.56)"
                        strokeWidth={2}
                        strokeDasharray="5 4"
                      />
                    ) : null}
                    <circle
                      r={radius}
                      fill={
                        isOwner
                          ? "url(#relationships-owner-fill)"
                          : "url(#relationships-node-fill)"
                      }
                      stroke={
                        selected
                          ? "rgba(255,255,255,0.96)"
                          : isOwner
                            ? "rgba(99,102,241,0.78)"
                            : "rgba(28,34,43,0.56)"
                      }
                      strokeWidth={selected ? 3.5 : isOwner ? 2.5 : 1.5}
                    />
                    <text
                      textAnchor="middle"
                      y={5}
                      className={`text-sm font-semibold ${isOwner ? "fill-white" : "fill-black"}`}
                    >
                      {nodeInitials(person.displayName)}
                    </text>
                    {showLabel ? (
                      <text
                        textAnchor="middle"
                        y={radius + 24}
                        className="text-xs font-semibold"
                        fill="var(--txt)"
                        stroke="rgba(255,255,255,0.82)"
                        strokeWidth={4}
                        paintOrder="stroke"
                      >
                        {shortLabel(person.displayName, 19)}
                      </text>
                    ) : null}
                  </g>
                  <foreignObject
                    x={position.x - 90}
                    y={position.y - radius - 18}
                    width={180}
                    height={radius + 72}
                  >
                    <button
                      type="button"
                      onClick={(event) => {
                        if (shouldSuppressClickRef.current) {
                          event.preventDefault();
                          event.stopPropagation();
                          shouldSuppressClickRef.current = false;
                          return;
                        }
                        onSelectPersonId(person.primaryEntityId);
                      }}
                      onMouseEnter={(event) =>
                        showTooltipForNode(person, event)
                      }
                      onMouseMove={(event) => showTooltipForNode(person, event)}
                      onMouseLeave={hideTooltip}
                      className="h-full w-full rounded-2xl bg-transparent"
                      aria-label={`Select ${person.displayName}`}
                    />
                  </foreignObject>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    </TooltipProvider>
  );
}
