import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@elizaos/ui";
import {
  Crown,
  Focus,
  Link2,
  Maximize2,
  Minus,
  Network,
  Plus,
  UserRound,
} from "lucide-react";
import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useMemo,
  useState,
} from "react";
import type {
  RelationshipsGraphEdge,
  RelationshipsGraphSnapshot,
  RelationshipsPersonSummary,
} from "../../api/client-types-relationships";

const GRAPH_WIDTH = 1320;
const GRAPH_HEIGHT = 760;
const GRAPH_PADDING = 92;
const MIN_ZOOM = 0.58;
const MAX_ZOOM = 1.35;
const ZOOM_STEP = 0.12;
const MAX_GLOBAL_NODES = 28;
const MAX_FOCUSED_NODES = 24;
const MAX_DIRECT_NEIGHBORS = 12;
const MAX_SECOND_WAVE_NEIGHBORS = 8;

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

function sentimentLabel(value: string): string {
  if (value === "positive") return "Positive";
  if (value === "negative") return "Negative";
  return "Neutral";
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

function layoutComponent(
  componentPeople: RelationshipsPersonSummary[],
  componentEdges: RelationshipsGraphEdge[],
  center: GraphPosition,
  cellWidth: number,
  cellHeight: number,
): Map<string, GraphPosition> {
  const positions = new Map<
    string,
    GraphPosition & {
      vx: number;
      vy: number;
    }
  >();
  if (componentPeople.length === 1) {
    const person = componentPeople[0];
    positions.set(person.groupId, { x: center.x, y: center.y, vx: 0, vy: 0 });
    return new Map(
      Array.from(positions, ([groupId, position]) => [groupId, position]),
    );
  }

  for (const person of componentPeople) {
    positions.set(person.groupId, {
      x: center.x + (seededUnit(person.groupId, 1) - 0.5) * cellWidth * 0.68,
      y: center.y + (seededUnit(person.groupId, 2) - 0.5) * cellHeight * 0.68,
      vx: 0,
      vy: 0,
    });
  }

  for (let iteration = 0; iteration < 240; iteration += 1) {
    const forces = new Map<string, { x: number; y: number }>();
    for (const person of componentPeople) {
      forces.set(person.groupId, { x: 0, y: 0 });
    }

    for (
      let leftIndex = 0;
      leftIndex < componentPeople.length;
      leftIndex += 1
    ) {
      const left = componentPeople[leftIndex];
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < componentPeople.length;
        rightIndex += 1
      ) {
        const right = componentPeople[rightIndex];
        const leftPosition = positions.get(left.groupId);
        const rightPosition = positions.get(right.groupId);
        const leftForces = forces.get(left.groupId);
        const rightForces = forces.get(right.groupId);
        if (!leftPosition || !rightPosition || !leftForces || !rightForces) {
          continue;
        }

        const dx = rightPosition.x - leftPosition.x;
        const dy = rightPosition.y - leftPosition.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const minimumDistance = nodeRadius(left) + nodeRadius(right) + 52;
        const repulsion = minimumDistance * minimumDistance * 0.8;
        const forceMagnitude = repulsion / (distance * distance);
        const fx = (dx / distance) * forceMagnitude;
        const fy = (dy / distance) * forceMagnitude;

        leftForces.x -= fx;
        leftForces.y -= fy;
        rightForces.x += fx;
        rightForces.y += fy;
      }
    }

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
      const idealDistance =
        142 + Math.max(0, componentPeople.length - 6) * 7 - edge.strength * 18;
      const springStrength = 0.006 + edge.strength * 0.018;
      const forceMagnitude = (distance - idealDistance) * springStrength;
      const fx = (dx / distance) * forceMagnitude;
      const fy = (dy / distance) * forceMagnitude;

      sourceForces.x += fx;
      sourceForces.y += fy;
      targetForces.x -= fx;
      targetForces.y -= fy;
    }

    for (const person of componentPeople) {
      const position = positions.get(person.groupId);
      const force = forces.get(person.groupId);
      if (!position || !force) {
        continue;
      }
      force.x += (center.x - position.x) * 0.01;
      force.y += (center.y - position.y) * 0.01;

      position.vx = (position.vx + force.x) * 0.86;
      position.vy = (position.vy + force.y) * 0.86;
      position.x = clamp(
        position.x + position.vx,
        center.x - cellWidth * 0.42,
        center.x + cellWidth * 0.42,
      );
      position.y = clamp(
        position.y + position.vy,
        center.y - cellHeight * 0.4,
        center.y + cellHeight * 0.4,
      );
    }
  }

  return new Map(
    Array.from(positions, ([groupId, position]) => [groupId, position]),
  );
}

function placeOnRing(
  positions: Map<string, GraphPosition>,
  people: RelationshipsPersonSummary[],
  center: GraphPosition,
  radius: number,
  startAngle: number,
) {
  people.forEach((person, index) => {
    const angle =
      startAngle + (index / Math.max(people.length, 1)) * Math.PI * 2;
    positions.set(person.groupId, {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  });
}

function buildFocusedNodePositions(
  people: RelationshipsPersonSummary[],
  edges: RelationshipsGraphEdge[],
  selectedGroupId: string,
): Map<string, GraphPosition> | null {
  const selected = people.find((person) => person.groupId === selectedGroupId);
  if (!selected) {
    return null;
  }

  const directEdges = sortEdges(
    edges.filter(
      (edge) =>
        edge.sourcePersonId === selectedGroupId ||
        edge.targetPersonId === selectedGroupId,
    ),
  );
  const directIds = new Set(
    directEdges.map((edge) => otherEndpoint(edge, selectedGroupId)),
  );
  const directPeople = directEdges
    .map((edge) =>
      people.find(
        (person) => person.groupId === otherEndpoint(edge, selectedGroupId),
      ),
    )
    .filter(
      (person): person is RelationshipsPersonSummary => person !== undefined,
    );
  const remainingPeople = people
    .filter(
      (person) =>
        person.groupId !== selectedGroupId && !directIds.has(person.groupId),
    )
    .sort((left, right) => rankPerson(right) - rankPerson(left));
  const positions = new Map<string, GraphPosition>();
  const center = { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 };

  positions.set(selectedGroupId, center);
  placeOnRing(
    positions,
    directPeople,
    center,
    clamp(190 + directPeople.length * 5, 210, 292),
    -Math.PI / 2,
  );
  placeOnRing(
    positions,
    remainingPeople,
    center,
    clamp(330 + remainingPeople.length * 2, 330, 360),
    -Math.PI / 2 + Math.PI / Math.max(remainingPeople.length, 3),
  );

  return positions;
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
    const componentPositions = layoutComponent(
      componentPeople,
      componentEdges,
      center,
      cellWidth,
      cellHeight,
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
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs-tight text-muted">
      <div className="flex items-center gap-1.5">
        <UserRound className="h-3.5 w-3.5 text-[rgba(240,185,11,0.9)]" />
        People
      </div>
      <div className="flex items-center gap-1.5">
        <Crown className="h-3.5 w-3.5 text-[rgba(99,102,241,0.86)]" />
        Owner
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className="h-[2px] w-6 rounded-full"
          style={{ backgroundColor: EDGE_COLORS.positive }}
        />
        Positive
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className="h-[2px] w-6 rounded-full"
          style={{ backgroundColor: EDGE_COLORS.neutral }}
        />
        Neutral
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className="h-[2px] w-6 rounded-full"
          style={{ backgroundColor: EDGE_COLORS.negative }}
        />
        Negative
      </div>
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
        <div className="text-sm font-semibold text-txt">
          {person.displayName}
        </div>
        <div className="mt-1 space-y-0.5 text-xs-tight text-muted">
          <div>
            {person.memberEntityIds.length} identit
            {person.memberEntityIds.length === 1 ? "y" : "ies"} /{" "}
            {person.relationshipCount} links / {person.factCount} facts
          </div>
          {person.platforms.length > 0 ? (
            <div>{person.platforms.join(", ")}</div>
          ) : null}
          {person.isOwner ? (
            <div className="font-semibold text-accent">Owner</div>
          ) : null}
        </div>
      </div>
    );
  }

  const { edge } = state;
  return (
    <div
      style={style}
      className="rounded-xl border border-border/40 bg-card/95 px-3 py-2.5 shadow-lg backdrop-blur-md"
    >
      <div className="text-sm font-semibold text-txt">
        {edge.sourcePersonName} / {edge.targetPersonName}
      </div>
      <div className="mt-1 space-y-0.5 text-xs-tight text-muted">
        <div>
          Strength {edge.strength.toFixed(2)} / {sentimentLabel(edge.sentiment)}{" "}
          / {edge.interactionCount} interactions
        </div>
        {edge.relationshipTypes.length > 0 ? (
          <div>{edge.relationshipTypes.join(", ")}</div>
        ) : null}
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

  const selectedPerson = useMemo(
    () =>
      visibleGraph.people.find(
        (person) => person.groupId === selectedGroupId,
      ) ?? null,
    [selectedGroupId, visibleGraph],
  );

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
  const zoomOut = () =>
    setZoom((currentZoom) =>
      clamp(Number((currentZoom - ZOOM_STEP).toFixed(2)), MIN_ZOOM, MAX_ZOOM),
    );
  const zoomIn = () =>
    setZoom((currentZoom) =>
      clamp(Number((currentZoom + ZOOM_STEP).toFixed(2)), MIN_ZOOM, MAX_ZOOM),
    );
  const fitGraph = () => setZoom(fittedZoom);
  const actualSize = () => setZoom(1);
  const zoomPercent = `${Math.round(zoom * 100)}%`;
  const graphWidth = GRAPH_WIDTH * zoom;
  const graphHeight = GRAPH_HEIGHT * zoom;

  return (
    <TooltipProvider delayDuration={160} skipDelayDuration={80}>
      <div className={compact ? "space-y-3" : "space-y-4"}>
        <div
          className={
            compact
              ? "flex flex-col gap-3"
              : "flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between"
          }
        >
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent/24 bg-accent/10 text-accent">
              <Network className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
                Relationship map
              </div>
              <div
                className={`${compact ? "mt-1 text-lg" : "mt-2 text-xl"} font-semibold text-txt`}
              >
                {selectedPerson
                  ? selectedPerson.displayName
                  : "People and links"}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                <span>{visibleGraph.modeLabel}</span>
                {visibleGraph.truncated ? (
                  <span>
                    showing {visibleGraph.people.length} of{" "}
                    {snapshot.stats.totalPeople}
                  </span>
                ) : null}
                <span className="inline-flex items-center gap-1">
                  <UserRound className="h-3.5 w-3.5" />
                  {visibleGraph.people.length}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Link2 className="h-3.5 w-3.5" />
                  {visibleGraph.relationships.length}
                </span>
              </div>
            </div>
          </div>

          <div
            className={
              compact
                ? "flex flex-col gap-2"
                : "flex flex-col gap-2 lg:items-end"
            }
          >
            <GraphLegend />
            <div className="flex flex-wrap items-center gap-2">
              <GraphIconButton
                label="Zoom out"
                disabled={zoom <= MIN_ZOOM}
                onClick={zoomOut}
              >
                <Minus className="h-4 w-4" />
              </GraphIconButton>
              <GraphIconButton label="Fit graph" onClick={fitGraph}>
                <Focus className="h-4 w-4" />
              </GraphIconButton>
              <GraphIconButton label="Actual size" onClick={actualSize}>
                <Maximize2 className="h-4 w-4" />
              </GraphIconButton>
              <GraphIconButton
                label="Zoom in"
                disabled={zoom >= MAX_ZOOM}
                onClick={zoomIn}
              >
                <Plus className="h-4 w-4" />
              </GraphIconButton>
              <span className="min-w-12 text-right text-xs-tight font-semibold tabular-nums text-muted">
                {zoomPercent}
              </span>
            </div>
          </div>
        </div>

        {/* biome-ignore lint/a11y/noStaticElementInteractions: graph container handles tooltip dismiss on mouse leave */}
        <div
          className={`${compact ? "max-h-[34rem]" : "max-h-[42rem]"} relative overflow-auto rounded-2xl border border-border/26 bg-[radial-gradient(circle_at_top,rgba(240,185,11,0.12),transparent_42%),linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,transparent),color-mix(in_srgb,var(--bg)_97%,transparent))]`}
          data-graph-container
          onMouseLeave={hideTooltip}
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
                  </g>
                  <foreignObject
                    x={position.x - 90}
                    y={position.y - radius - 18}
                    width={180}
                    height={radius + 72}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectPersonId(person.primaryEntityId)}
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
