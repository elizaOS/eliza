import { useMemo, useState } from "react";
import type {
  RelationshipsGraphEdge,
  RelationshipsGraphSnapshot,
  RelationshipsPersonSummary,
} from "../../api/client-types-relationships";

const GRAPH_WIDTH = 960;
const GRAPH_HEIGHT = 540;
const GRAPH_PADDING = 56;
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

function toTimestamp(value?: string): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function nodeRadius(person: RelationshipsPersonSummary): number {
  return Math.min(
    42,
    16 +
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

function edgeColor(edge: RelationshipsGraphEdge): string {
  if (edge.sentiment === "positive") return "rgba(73, 197, 122, 0.55)";
  if (edge.sentiment === "negative") return "rgba(239, 68, 68, 0.5)";
  return "rgba(240, 185, 11, 0.38)";
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

function selectVisibleGraph(
  snapshot: RelationshipsGraphSnapshot,
  selectedGroupId: string | null,
): VisibleGraph {
  if (snapshot.people.length <= MAX_GLOBAL_NODES) {
    return {
      people: snapshot.people,
      relationships: snapshot.relationships,
      modeLabel: "Loaded relationship graph",
      truncated: false,
    };
  }

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

    const people = snapshot.people.filter((person) =>
      included.has(person.groupId),
    );
    return {
      people,
      relationships: snapshot.relationships.filter(
        (edge) =>
          included.has(edge.sourcePersonId) &&
          included.has(edge.targetPersonId),
      ),
      modeLabel: "Selected neighborhood",
      truncated: people.length < snapshot.people.length,
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

  const people = snapshot.people.filter((person) =>
    included.has(person.groupId),
  );
  return {
    people,
    relationships: snapshot.relationships.filter(
      (edge) =>
        included.has(edge.sourcePersonId) && included.has(edge.targetPersonId),
    ),
    modeLabel: "Most connected subgraph",
    truncated: people.length < snapshot.people.length,
  };
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
      x: center.x + (seededUnit(person.groupId, 1) - 0.5) * cellWidth * 0.5,
      y: center.y + (seededUnit(person.groupId, 2) - 0.5) * cellHeight * 0.5,
      vx: 0,
      vy: 0,
    });
  }

  for (let iteration = 0; iteration < 170; iteration += 1) {
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
        const minimumDistance = nodeRadius(left) + nodeRadius(right) + 24;
        const repulsion = minimumDistance * minimumDistance * 0.42;
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
        84 + Math.max(0, componentPeople.length - 6) * 4 - edge.strength * 16;
      const springStrength = 0.012 + edge.strength * 0.028;
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
      force.x += (center.x - position.x) * 0.018;
      force.y += (center.y - position.y) * 0.018;

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

function buildNodePositions(
  people: RelationshipsPersonSummary[],
  edges: RelationshipsGraphEdge[],
): Map<string, GraphPosition> {
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

function GraphLegend() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs-tight text-muted">
      <div className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[rgba(240,185,11,0.9)]" />
        People
      </div>
      <div className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full border-2 border-[rgba(99,102,241,0.7)] bg-[rgba(99,102,241,0.15)]" />
        Owner
      </div>
      <div className="flex items-center gap-1.5">
        <span className="h-[2px] w-6 bg-[rgba(73,197,122,0.48)]" />
        Positive
      </div>
      <div className="flex items-center gap-1.5">
        <span className="h-[2px] w-6 bg-[rgba(240,185,11,0.34)]" />
        Neutral
      </div>
      <div className="flex items-center gap-1.5">
        <span className="h-[2px] w-6 bg-[rgba(239,68,68,0.44)]" />
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

  const style: React.CSSProperties = {
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
            {person.memberEntityIds.length === 1 ? "y" : "ies"} ·{" "}
            {person.relationshipCount} links · {person.factCount} facts
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
        {edge.sourcePersonName} ↔ {edge.targetPersonName}
      </div>
      <div className="mt-1 space-y-0.5 text-xs-tight text-muted">
        <div>
          Strength {edge.strength.toFixed(2)} · {edge.sentiment} ·{" "}
          {edge.interactionCount} interactions
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
  onSelectGroupId,
}: {
  snapshot: RelationshipsGraphSnapshot | null;
  selectedGroupId: string | null;
  onSelectGroupId: (groupId: string) => void;
}) {
  const [tooltip, setTooltip] = useState<TooltipState>(null);

  const visibleGraph = useMemo(
    () =>
      snapshot && snapshot.people.length > 0
        ? selectVisibleGraph(snapshot, selectedGroupId)
        : null,
    [snapshot, selectedGroupId],
  );

  const positions = useMemo(
    () =>
      visibleGraph
        ? buildNodePositions(visibleGraph.people, visibleGraph.relationships)
        : new Map<string, GraphPosition>(),
    [visibleGraph],
  );

  if (!snapshot || !visibleGraph || snapshot.people.length === 0) {
    return (
      <div className="flex min-h-[20rem] flex-col items-center justify-center rounded-2xl border border-border/28 bg-card/35 px-6 py-10 text-center">
        <div className="text-sm font-semibold text-txt">
          No identities match the current filters.
        </div>
        <p className="mt-2 max-w-lg text-sm leading-6 text-muted">
          The graph will render once the relationships has people, identity
          links, and relationships to visualize.
        </p>
      </div>
    );
  }

  const showTooltipForNode = (
    person: RelationshipsPersonSummary,
    event: React.MouseEvent,
  ) => {
    const rect = (
      event.currentTarget.closest("[data-graph-container]") as HTMLElement
    )?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({
      kind: "node",
      person,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };

  const showTooltipForEdge = (
    edge: RelationshipsGraphEdge,
    event: React.MouseEvent,
  ) => {
    const rect = (
      event.currentTarget.closest("[data-graph-container]") as HTMLElement
    )?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({
      kind: "edge",
      edge,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };

  const hideTooltip = () => setTooltip(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
            Identity Graph
          </div>
          <div className="mt-2 text-xl font-semibold text-txt">
            Canonical people and cross-person relationships
          </div>
          <div className="mt-2 text-xs text-muted">
            {visibleGraph.modeLabel}
            {visibleGraph.truncated
              ? ` · showing ${visibleGraph.people.length} of ${snapshot.stats.totalPeople}`
              : null}
          </div>
        </div>
        <GraphLegend />
      </div>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: graph container handles tooltip dismiss on mouse leave */}
      <div
        className="relative overflow-hidden rounded-3xl border border-border/26 bg-[radial-gradient(circle_at_top,rgba(240,185,11,0.12),transparent_42%),linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,transparent),color-mix(in_srgb,var(--bg)_97%,transparent))]"
        data-graph-container
        onMouseLeave={hideTooltip}
      >
        <GraphTooltip state={tooltip} />
        <svg
          viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
          className="h-[24rem] w-full"
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
              <stop offset="0%" stopColor="rgba(255,240,199,0.92)" />
              <stop offset="100%" stopColor="rgba(240,185,11,0.86)" />
            </radialGradient>
            <radialGradient
              id="relationships-owner-fill"
              cx="50%"
              cy="35%"
              r="70%"
            >
              <stop offset="0%" stopColor="rgba(199,210,255,0.94)" />
              <stop offset="100%" stopColor="rgba(99,102,241,0.82)" />
            </radialGradient>
          </defs>

          {visibleGraph.relationships.map((edge) => {
            const source = positions.get(edge.sourcePersonId);
            const target = positions.get(edge.targetPersonId);
            if (!source || !target) {
              return null;
            }
            const midX = (source.x + target.x) / 2;
            const midY = (source.y + target.y) / 2;
            return (
              <g key={edge.id}>
                <line
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke={edgeColor(edge)}
                  strokeWidth={Math.max(1.5, edge.strength * 7)}
                  strokeLinecap="round"
                  opacity={0.9}
                />
                {/* biome-ignore lint/a11y/noStaticElementInteractions: SVG edge hover for tooltip display only */}
                <line
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke="transparent"
                  strokeWidth={16}
                  className="cursor-pointer"
                  onMouseEnter={(e) => {
                    const rect = (
                      e.currentTarget.closest(
                        "[data-graph-container]",
                      ) as HTMLElement
                    )?.getBoundingClientRect();
                    if (rect) {
                      setTooltip({
                        kind: "edge",
                        edge,
                        x: (midX / GRAPH_WIDTH) * rect.width,
                        y: (midY / GRAPH_HEIGHT) * rect.height,
                      });
                    }
                  }}
                  onMouseMove={(e) => showTooltipForEdge(edge, e)}
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
            const radius = nodeRadius(person);
            const selected = selectedGroupId === person.groupId;
            const isOwner = person.isOwner;
            return (
              <g key={person.groupId}>
                <g
                  transform={`translate(${position.x}, ${position.y})`}
                  className="pointer-events-none"
                >
                  {/* Selection halo */}
                  <circle
                    r={radius + (selected ? 10 : 0)}
                    fill={selected ? "rgba(240,185,11,0.12)" : "transparent"}
                    stroke={selected ? "rgba(240,185,11,0.34)" : "transparent"}
                    strokeWidth={selected ? 2 : 0}
                  />
                  {/* Owner outer ring */}
                  {isOwner && !selected ? (
                    <circle
                      r={radius + 5}
                      fill="transparent"
                      stroke="rgba(99,102,241,0.4)"
                      strokeWidth={2}
                      strokeDasharray="4 3"
                    />
                  ) : null}
                  {/* Main node */}
                  <circle
                    r={radius}
                    fill={
                      isOwner
                        ? "url(#relationships-owner-fill)"
                        : "url(#relationships-node-fill)"
                    }
                    stroke={
                      selected
                        ? "rgba(255,255,255,0.92)"
                        : isOwner
                          ? "rgba(99,102,241,0.7)"
                          : "rgba(28,34,43,0.55)"
                    }
                    strokeWidth={selected ? 3 : isOwner ? 2.5 : 1.5}
                  />
                  <text
                    textAnchor="middle"
                    y={-3}
                    className={`text-xs font-semibold ${isOwner ? "fill-white" : "fill-black"}`}
                  >
                    {shortLabel(person.displayName, 15)}
                  </text>
                  <text
                    textAnchor="middle"
                    y={12}
                    className={`text-3xs font-medium ${isOwner ? "fill-white/70" : "fill-black/70"}`}
                  >
                    {shortLabel(
                      person.relationshipCount > 0
                        ? `${person.relationshipCount} links`
                        : `${person.memberEntityIds.length} identities`,
                      18,
                    )}
                  </text>
                </g>
                <foreignObject
                  x={position.x - radius - 12}
                  y={position.y - radius - 12}
                  width={(radius + 12) * 2}
                  height={(radius + 12) * 2}
                >
                  <button
                    type="button"
                    onClick={() => onSelectGroupId(person.groupId)}
                    onMouseEnter={(e) => showTooltipForNode(person, e)}
                    onMouseMove={(e) => showTooltipForNode(person, e)}
                    onMouseLeave={hideTooltip}
                    className="h-full w-full rounded-full bg-transparent"
                    aria-label={`Select ${person.displayName}`}
                  />
                </foreignObject>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
