import type { Memory, UUID } from "@elizaos/core";
import { useCallback, useEffect, useRef, useState } from "react";
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from "react-force-graph-2d";

declare global {
  interface Window {
    ELIZA_CONFIG?: {
      agentId: string;
      apiBase: string;
    };
  }
}

const getApiBase = () => {
  if (window.ELIZA_CONFIG?.apiBase) {
    return window.ELIZA_CONFIG.apiBase;
  }
  return "/api";
};

interface GraphNode extends NodeObject {
  id: UUID;
  type: "document" | "fragment";
  label?: string;
  loading?: boolean;
  val?: number;
}

interface GraphLink extends LinkObject {
  source: UUID;
  target: UUID;
}

interface MemoryGraphOptimizedProps {
  onNodeClick: (memory: Memory) => void;
  selectedMemoryId?: UUID;
  agentId: UUID;
}

interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

interface PaginationInfo {
  currentPage: number;
  totalPages: number;
  hasMore: boolean;
  totalDocuments: number;
}

export function MemoryGraphOptimized({
  onNodeClick,
  selectedMemoryId,
  agentId,
}: MemoryGraphOptimizedProps) {
  const graphRef = useRef<ForceGraphMethods | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [loadingNodes, setLoadingNodes] = useState<Set<UUID>>(new Set());
  const [nodeDetails, setNodeDetails] = useState<Map<UUID, Memory>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [graphVersion, setGraphVersion] = useState(0);

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        const { offsetWidth, offsetHeight } = containerRef.current;
        setDimensions({
          width: offsetWidth,
          height: offsetHeight,
        });
      }
    };

    updateDimensions();
    window.addEventListener("resize", updateDimensions);
    return () => window.removeEventListener("resize", updateDimensions);
  }, []);

  const loadGraphNodes = useCallback(
    async (page = 1) => {
      setIsLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams();
        params.append("agentId", agentId);
        params.append("page", page.toString());
        params.append("limit", "20");

        const apiBase = getApiBase();
        const response = await fetch(`${apiBase}/graph/nodes?${params.toString()}`);

        if (!response.ok) {
          throw new Error(`Failed to load graph nodes: ${response.statusText}`);
        }

        const result = await response.json();

        if (result.success && result.data) {
          const { nodes, links, pagination } = result.data;

          const graphNodes: GraphNode[] = nodes.map(
            (node: { id: UUID; type: "document" | "fragment" }) => ({
              id: node.id,
              type: node.type,
              loading: false,
              val: node.type === "document" ? 8 : 4,
            })
          );

          if (page === 1) {
            setGraphData({ nodes: graphNodes, links });
            setGraphVersion(1);
          } else {
            setGraphData((prev) => {
              const existingNodeIds = new Set(prev.nodes.map((node: GraphNode) => node.id));
              const newNodes = graphNodes.filter((node: GraphNode) => {
                return !existingNodeIds.has(node.id);
              });

              const existingLinkIds = new Set(
                prev.links.map((link: GraphLink) => `${link.source}->${link.target}`)
              );
              const newLinks = links.filter((link: GraphLink) => {
                const linkId = `${link.source}->${link.target}`;
                return !existingLinkIds.has(linkId);
              });

              return {
                nodes: [...prev.nodes, ...newNodes],
                links: [...prev.links, ...newLinks],
              };
            });
            setGraphVersion((prev) => prev + 1);
          }

          setPagination(pagination);
        }
      } catch (err) {
        console.error("Error loading graph nodes:", err);
        setError(err instanceof Error ? err.message : "Failed to load graph");
      } finally {
        setIsLoading(false);
      }
    },
    [agentId]
  );

  const loadMore = useCallback(() => {
    if (pagination?.hasMore) {
      loadGraphNodes(pagination.currentPage + 1);
    }
  }, [pagination, loadGraphNodes]);

  const fetchNodeDetails = useCallback(
    async (nodeId: UUID) => {
      if (nodeDetails.has(nodeId)) {
        const memory = nodeDetails.get(nodeId);
        if (memory) {
          onNodeClick(memory);
          return;
        }
      }

      setLoadingNodes((prev) => new Set(prev).add(nodeId));

      try {
        const params = new URLSearchParams();
        params.append("agentId", agentId);

        const apiBase = getApiBase();
        const url = `${apiBase}/graph/node/${nodeId}?${params.toString()}`;

        const response = await fetch(url);

        if (!response.ok) {
          const errorText = await response.text();
          console.error("API error response:", errorText);
          throw new Error(`Failed to fetch node details: ${response.statusText}`);
        }

        const result = await response.json();

        if (result.success && result.data) {
          const memory: Memory = {
            id: result.data.id,
            content: result.data.content,
            metadata: result.data.metadata,
            createdAt: result.data.createdAt,
            entityId: result.data.entityId,
            roomId: result.data.roomId,
            agentId: result.data.agentId,
            worldId: result.data.worldId,
          };

          setNodeDetails((prev) => new Map(prev).set(nodeId, memory));
          onNodeClick(memory);
        } else {
          console.error("Invalid API response format:", result);
          throw new Error("Invalid response format from API");
        }
      } catch (err) {
        console.error("Error fetching node details:", err);
        alert(`Failed to load node details: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setLoadingNodes((prev) => {
          const newSet = new Set(prev);
          newSet.delete(nodeId);
          return newSet;
        });
      }
    },
    [agentId, nodeDetails, onNodeClick]
  );

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      fetchNodeDetails(node.id);
    },
    [fetchNodeDetails]
  );

  useEffect(() => {
    loadGraphNodes(1);
  }, [loadGraphNodes]);

  const getNodeColor = useCallback(
    (node: GraphNode) => {
      const isSelected = selectedMemoryId === node.id;
      const isLoading = loadingNodes.has(node.id);

      if (isLoading) {
        return "hsl(210, 70%, 80%)";
      }

      if (node.type === "document") {
        if (isSelected) return "hsl(30, 100%, 60%)";
        return "hsl(30, 100%, 50%)";
      } else {
        if (isSelected) return "hsl(200, 70%, 70%)";
        return "hsl(200, 70%, 60%)";
      }
    },
    [selectedMemoryId, loadingNodes]
  );

  // Render loading state
  if (isLoading && graphData.nodes.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <div className="text-muted-foreground">Loading graph...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <div className="text-destructive">Error: {error}</div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full h-full relative">
      {/* Legend */}
      <div className="absolute top-4 right-4 p-3 bg-card/90 text-card-foreground border border-border rounded-md shadow-sm text-xs backdrop-blur-sm z-10">
        <div className="font-medium mb-2">Legend</div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-orange-500"></div>
            <span>Document</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-blue-300"></div>
            <span>Fragment</span>
          </div>
        </div>
      </div>

      {/* Pagination */}
      {pagination?.hasMore && (
        <div className="absolute bottom-4 left-4 z-10">
          <button
            onClick={loadMore}
            disabled={isLoading}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md shadow-sm hover:bg-primary/90 disabled:opacity-50"
          >
            Load More Documents ({pagination.currentPage}/{pagination.totalPages})
          </button>
        </div>
      )}

      <ForceGraph2D
        key={`graph-${graphVersion}`}
        ref={graphRef}
        graphData={graphData}
        width={dimensions.width}
        height={dimensions.height}
        backgroundColor="transparent"
        linkColor={() => "hsla(var(--muted-foreground), 0.2)"}
        linkWidth={1}
        linkDirectionalParticles={2}
        linkDirectionalParticleSpeed={0.005}
        nodeRelSize={1}
        nodeVal={(node: GraphNode) => node.val || 4}
        nodeColor={getNodeColor}
        nodeLabel={(node: GraphNode) => {
          if (loadingNodes.has(node.id)) return "Loading...";
          const typeLabel = node.type === "document" ? "Document" : "Fragment";
          return `${typeLabel}: ${node.id.substring(0, 8)}`;
        }}
        onNodeClick={handleNodeClick}
        enableNodeDrag={true}
        enableZoomInteraction={true}
        enablePanInteraction={true}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
        warmupTicks={100}
        cooldownTicks={0}
        nodeCanvasObject={(node: GraphNode, ctx, _globalScale) => {
          const size = node.val || 4;
          const isSelected = selectedMemoryId === node.id;
          const isLoading = loadingNodes.has(node.id);

          ctx.beginPath();
          ctx.arc(node.x ?? 0, node.y ?? 0, size, 0, 2 * Math.PI);
          ctx.fillStyle = getNodeColor(node);
          ctx.fill();

          ctx.strokeStyle = isSelected ? "hsl(var(--primary))" : "hsl(var(--border))";
          ctx.lineWidth = isSelected ? 2 : 1;
          ctx.stroke();

          if (isLoading) {
            ctx.beginPath();
            ctx.arc(node.x ?? 0, node.y ?? 0, size * 1.5, 0, Math.PI * 2 * 0.3);
            ctx.strokeStyle = "hsl(var(--primary))";
            ctx.lineWidth = 2;
            ctx.stroke();
          }
        }}
        onEngineStop={() => {
          if (graphRef.current) {
            graphRef.current.zoomToFit(400);
          }
        }}
      />
    </div>
  );
}
