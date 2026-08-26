/** Pure, deterministic lane matching for bounded backup-admission frontiers. */

export interface AgentBackupAdmissionMatchingCandidate {
  /** Stable work-item identity. Candidate ids must be unique within one call. */
  readonly id: string;
  readonly organizationId: string;
  /** Capture consumes this exact node lane; publication consumes no node lane. */
  readonly nodeLaneId?: string | null;
  /** Lower integers are stricter priority bands. */
  readonly effectivePriority: number;
}

interface IndexedCandidate<T extends AgentBackupAdmissionMatchingCandidate> {
  readonly candidate: T;
  readonly inputIndex: number;
  readonly nodeLaneId: string | null;
}

interface ResidualEdge {
  readonly to: number;
  readonly reverseIndex: number;
  capacity: 0 | 1;
  readonly cost: bigint;
}

interface CandidateResidualEdge<T extends AgentBackupAdmissionMatchingCandidate> {
  readonly candidate: IndexedCandidate<T>;
  readonly edge: ResidualEdge;
}

interface HeapEntry {
  readonly distance: bigint;
  readonly node: number;
}

/**
 * After pair de-duplication and intersection of endpoint ranks <= k, every
 * endpoint has degree <= k. By Konig's theorem, more than k(k - 1) edges then
 * force a matching of size k. A caller therefore needs at most this many
 * ordered frontier rows to preserve cardinality k.
 */
export function agentBackupAdmissionMatchingKernelBound(limit: number): number {
  requireLimit(limit);
  if (limit === 0) return 0;
  const bound = limit * (limit - 1) + 1;
  if (!Number.isSafeInteger(bound)) {
    throw new Error("Backup admission matching kernel bound exceeds safe integer range");
  }
  return bound;
}

/**
 * Select a deterministic matching from an already totally ordered frontier.
 *
 * Priority bands are processed from the lowest integer upward. Each band gets
 * its maximum possible cardinality before a later band is considered. Among
 * equal-cardinality matchings in one band, the earliest differing input row is
 * selected whenever a matching of that cardinality can contain it.
 *
 * The function is side-effect free. The caller remains responsible for locking
 * and revalidating the selected database rows and lane authorities atomically.
 */
export function selectAgentBackupAdmissionMatchingCandidates<
  T extends AgentBackupAdmissionMatchingCandidate,
>(candidates: readonly T[], limit: number): T[] {
  requireLimit(limit);
  if (limit === 0 || candidates.length === 0) return [];

  const byPriority = new Map<number, IndexedCandidate<T>[]>();
  const ids = new Set<string>();
  for (const [inputIndex, candidate] of candidates.entries()) {
    requireCandidate(candidate, ids);
    const indexed: IndexedCandidate<T> = {
      candidate,
      inputIndex,
      nodeLaneId: candidate.nodeLaneId ?? null,
    };
    const band = byPriority.get(candidate.effectivePriority);
    if (band) band.push(indexed);
    else byPriority.set(candidate.effectivePriority, [indexed]);
  }

  const selected: IndexedCandidate<T>[] = [];
  const usedOrganizations = new Set<string>();
  const usedNodeLanes = new Set<string>();
  const priorities = [...byPriority.keys()].sort((left, right) => left - right);

  for (const priority of priorities) {
    const remaining = limit - selected.length;
    if (remaining === 0) break;
    const available = (byPriority.get(priority) ?? []).filter(
      ({ candidate, nodeLaneId }) =>
        !usedOrganizations.has(candidate.organizationId) &&
        (nodeLaneId === null || !usedNodeLanes.has(nodeLaneId)),
    );
    const bandSelection = lexicographicMaximumMatching(available, remaining);
    for (const match of bandSelection) {
      selected.push(match);
      usedOrganizations.add(match.candidate.organizationId);
      if (match.nodeLaneId !== null) usedNodeLanes.add(match.nodeLaneId);
    }
  }

  return selected.map(({ candidate }) => candidate);
}

function requireLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error("Backup admission matching limit must be a non-negative safe integer");
  }
}

function requireCandidate(
  candidate: AgentBackupAdmissionMatchingCandidate,
  ids: Set<string>,
): void {
  if (candidate.id.length === 0) {
    throw new Error("Backup admission matching candidate id must be non-empty");
  }
  if (ids.has(candidate.id)) {
    throw new Error(`Duplicate backup admission matching candidate id: ${candidate.id}`);
  }
  ids.add(candidate.id);
  if (candidate.organizationId.length === 0) {
    throw new Error("Backup admission matching organization id must be non-empty");
  }
  if (candidate.nodeLaneId !== undefined && candidate.nodeLaneId !== null) {
    if (candidate.nodeLaneId.length === 0) {
      throw new Error("Backup admission matching node lane id must be non-empty when present");
    }
  }
  if (!Number.isSafeInteger(candidate.effectivePriority)) {
    throw new Error("Backup admission matching priority must be a safe integer");
  }
}

/** Exact maximum-cardinality, then lexicographically earliest, bipartite matching. */
function lexicographicMaximumMatching<T extends AgentBackupAdmissionMatchingCandidate>(
  candidates: readonly IndexedCandidate<T>[],
  limit: number,
): IndexedCandidate<T>[] {
  if (limit === 0 || candidates.length === 0) return [];

  const organizationKeys = [
    ...new Set(candidates.map(({ candidate }) => candidate.organizationId)),
  ];
  const sharedNodeKeys = [
    ...new Set(candidates.flatMap(({ nodeLaneId }) => (nodeLaneId === null ? [] : [nodeLaneId]))),
  ];
  const privateNodeKeys = [
    ...new Set(
      candidates.flatMap(({ candidate, nodeLaneId }) =>
        nodeLaneId === null ? [candidate.organizationId] : [],
      ),
    ),
  ];

  const source = 0;
  const organizationOffset = 1;
  const sharedNodeOffset = organizationOffset + organizationKeys.length;
  const privateNodeOffset = sharedNodeOffset + sharedNodeKeys.length;
  const sink = privateNodeOffset + privateNodeKeys.length;
  const graph: ResidualEdge[][] = Array.from({ length: sink + 1 }, () => []);
  const organizationNodeByKey = new Map(
    organizationKeys.map((key, index) => [key, organizationOffset + index]),
  );
  const sharedNodeByKey = new Map(
    sharedNodeKeys.map((key, index) => [key, sharedNodeOffset + index]),
  );
  const privateNodeByOrganization = new Map(
    privateNodeKeys.map((key, index) => [key, privateNodeOffset + index]),
  );

  for (const organizationNode of organizationNodeByKey.values()) {
    addResidualEdge(graph, source, organizationNode, 0n);
  }
  for (const node of sharedNodeByKey.values()) addResidualEdge(graph, node, sink, 0n);
  for (const node of privateNodeByOrganization.values()) {
    addResidualEdge(graph, node, sink, 0n);
  }

  const candidateEdges: CandidateResidualEdge<T>[] = [];
  for (const [candidateIndex, indexed] of candidates.entries()) {
    const organizationNode = organizationNodeByKey.get(indexed.candidate.organizationId);
    const laneNode =
      indexed.nodeLaneId === null
        ? privateNodeByOrganization.get(indexed.candidate.organizationId)
        : sharedNodeByKey.get(indexed.nodeLaneId);
    if (organizationNode === undefined || laneNode === undefined) {
      throw new Error("Backup admission matching graph lost a candidate endpoint");
    }
    // One bit per ordered candidate makes the objective exactly lexicographic:
    // an earlier bit is worth more than every later bit combined.
    const reward = 1n << BigInt(candidates.length - candidateIndex - 1);
    const edge = addResidualEdge(graph, organizationNode, laneNode, -reward);
    candidateEdges.push({ candidate: indexed, edge });
  }

  const potentials = initialShortestPathPotentials(graph, {
    source,
    organizationNodes: organizationNodeByKey.values(),
    laneNodes: [...sharedNodeByKey.values(), ...privateNodeByOrganization.values()],
    sink,
  });
  for (let flow = 0; flow < limit; flow += 1) {
    if (!augmentCheapestResidualPath(graph, source, sink, potentials)) break;
  }

  return candidateEdges
    .filter(({ edge }) => edge.capacity === 0)
    .map(({ candidate }) => candidate)
    .sort((left, right) => left.inputIndex - right.inputIndex);
}

function addResidualEdge(
  graph: ResidualEdge[][],
  from: number,
  to: number,
  cost: bigint,
): ResidualEdge {
  const forward: ResidualEdge = {
    to,
    reverseIndex: graph[to]?.length ?? 0,
    capacity: 1,
    cost,
  };
  const reverse: ResidualEdge = {
    to: from,
    reverseIndex: graph[from]?.length ?? 0,
    capacity: 0,
    cost: -cost,
  };
  graph[from]?.push(forward);
  graph[to]?.push(reverse);
  return forward;
}

function initialShortestPathPotentials(
  graph: readonly ResidualEdge[][],
  nodes: {
    readonly source: number;
    readonly organizationNodes: Iterable<number>;
    readonly laneNodes: readonly number[];
    readonly sink: number;
  },
): bigint[] {
  const potentials = Array<bigint>(graph.length).fill(0n);
  for (const organizationNode of nodes.organizationNodes) {
    for (const edge of graph[organizationNode] ?? []) {
      if (edge.capacity === 1 && edge.to !== nodes.source && edge.cost < potentials[edge.to]!) {
        potentials[edge.to] = edge.cost;
      }
    }
  }
  let sinkPotential: bigint | null = null;
  for (const laneNode of nodes.laneNodes) {
    const lanePotential = potentials[laneNode]!;
    if (sinkPotential === null || lanePotential < sinkPotential) sinkPotential = lanePotential;
  }
  potentials[nodes.sink] = sinkPotential ?? 0n;
  return potentials;
}

function augmentCheapestResidualPath(
  graph: ResidualEdge[][],
  source: number,
  sink: number,
  potentials: bigint[],
): boolean {
  const distances: Array<bigint | null> = Array(graph.length).fill(null);
  const previousNodes = Array<number>(graph.length).fill(-1);
  const previousEdges = Array<number>(graph.length).fill(-1);
  const heap: HeapEntry[] = [];
  distances[source] = 0n;
  pushHeap(heap, { distance: 0n, node: source });

  while (heap.length > 0) {
    const current = popHeap(heap);
    if (!current || distances[current.node] !== current.distance) continue;
    for (const [edgeIndex, edge] of (graph[current.node] ?? []).entries()) {
      if (edge.capacity === 0) continue;
      const reducedCost = edge.cost + potentials[current.node]! - potentials[edge.to]!;
      if (reducedCost < 0n) {
        throw new Error("Backup admission matching residual potential became infeasible");
      }
      const nextDistance = current.distance + reducedCost;
      const previousDistance = distances[edge.to];
      if (previousDistance !== null && previousDistance <= nextDistance) continue;
      distances[edge.to] = nextDistance;
      previousNodes[edge.to] = current.node;
      previousEdges[edge.to] = edgeIndex;
      pushHeap(heap, { distance: nextDistance, node: edge.to });
    }
  }

  if (distances[sink] === null) return false;
  for (const [node, distance] of distances.entries()) {
    if (distance !== null) potentials[node] = potentials[node]! + distance;
  }

  for (let node = sink; node !== source; ) {
    const previousNode = previousNodes[node];
    const edgeIndex = previousEdges[node];
    if (previousNode < 0 || edgeIndex < 0) {
      throw new Error("Backup admission matching augmenting path was incomplete");
    }
    const edge = graph[previousNode]?.[edgeIndex];
    if (!edge || edge.capacity === 0) {
      throw new Error("Backup admission matching augmenting path lost residual capacity");
    }
    const reverse = graph[node]?.[edge.reverseIndex];
    if (!reverse) {
      throw new Error("Backup admission matching augmenting path lost its reverse edge");
    }
    edge.capacity = 0;
    reverse.capacity = 1;
    node = previousNode;
  }
  return true;
}

function pushHeap(heap: HeapEntry[], entry: HeapEntry): void {
  heap.push(entry);
  for (let index = heap.length - 1; index > 0; ) {
    const parent = Math.floor((index - 1) / 2);
    if (compareHeapEntries(heap[parent]!, heap[index]!) <= 0) break;
    [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
    index = parent;
  }
}

function popHeap(heap: HeapEntry[]): HeapEntry | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (!first || !last || heap.length === 0) return first;
  heap[0] = last;
  for (let index = 0; ; ) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < heap.length && compareHeapEntries(heap[left]!, heap[smallest]!) < 0) {
      smallest = left;
    }
    if (right < heap.length && compareHeapEntries(heap[right]!, heap[smallest]!) < 0) {
      smallest = right;
    }
    if (smallest === index) break;
    [heap[index], heap[smallest]] = [heap[smallest]!, heap[index]!];
    index = smallest;
  }
  return first;
}

function compareHeapEntries(left: HeapEntry, right: HeapEntry): number {
  if (left.distance < right.distance) return -1;
  if (left.distance > right.distance) return 1;
  return left.node - right.node;
}
