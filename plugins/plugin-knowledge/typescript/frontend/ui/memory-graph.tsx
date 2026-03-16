import type { Memory, UUID } from "@elizaos/core";
import { useCallback, useEffect, useRef, useState } from "react";
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from "react-force-graph-2d";
import type { ExtendedMemoryMetadata } from "../../types";

type MemoryMetadata = ExtendedMemoryMetadata;

interface MemoryNode extends NodeObject {
  id: UUID;
  name: string;
  val?: number; // Node size
  memory: Memory;
  type: "document" | "fragment"; // Type to distinguish documents and fragments
}

interface MemoryLink extends LinkObject {
  source: UUID;
  target: UUID;
  value?: number; // Link strength/thickness
}

interface MemoryGraphProps {
  memories: Memory[];
  onNodeClick: (memory: Memory) => void;
  selectedMemoryId?: UUID;
}

const processGraphData = (memories: Memory[]) => {
  const documents: MemoryNode[] = [];
  const fragments: MemoryNode[] = [];
  const documentFragmentCounts = new Map<UUID, number>();

  memories.forEach((memory) => {
    const metadata = memory.metadata as MemoryMetadata;
    if (metadata?.type === "fragment" && metadata.documentId) {
      const count = documentFragmentCounts.get(metadata.documentId as UUID) || 0;
      documentFragmentCounts.set(metadata.documentId as UUID, count + 1);
    }
  });

  memories.forEach((memory) => {
    const metadata = memory.metadata as MemoryMetadata;

    if (!memory.id || !metadata || typeof metadata !== "object") {
      return;
    }

    const getNodeName = () => {
      let baseName = "";
      if (metadata.title) baseName = metadata.title;
      else if (metadata.filename) baseName = metadata.filename;
      else if (metadata.originalFilename) baseName = metadata.originalFilename;
      else if (metadata.path) baseName = metadata.path.split("/").pop() || metadata.path;
      else {
        const nodeType = (metadata.type || "").toLowerCase() === "document" ? "Doc" : "Fragment";
        baseName = `${nodeType} ${memory.id ? memory.id.substring(0, 8) : ""}`;
      }

      if (metadata.type === "document" && memory.id) {
        const fragmentCount = documentFragmentCounts.get(memory.id as UUID) || 0;
        if (fragmentCount > 0) {
          baseName += ` (${fragmentCount} fragments)`;
        }
      }

      return baseName;
    };

    const memoryNode: MemoryNode = {
      id: memory.id,
      name: getNodeName(),
      memory: memory,
      val: 3,
      type: (metadata.type || "").toLowerCase() === "document" ? "document" : "fragment",
    };

    if ((metadata.type || "").toLowerCase() === "document") {
      memoryNode.val = 5;
      documents.push(memoryNode);
    } else if (
      (metadata.type || "").toLowerCase() === "fragment" ||
      (metadata.documentId && (metadata.type || "").toLowerCase() !== "document")
    ) {
      memoryNode.val = 3;
      fragments.push(memoryNode);
    } else {
      documents.push(memoryNode);
    }
  });

  const links: MemoryLink[] = [];

  fragments.forEach((fragment) => {
    const fragmentMetadata = fragment.memory.metadata as MemoryMetadata;
    if (fragmentMetadata.documentId) {
      const sourceDoc = documents.find((doc) => doc.id === fragmentMetadata.documentId);
      if (sourceDoc) {
        links.push({
          source: sourceDoc.id,
          target: fragment.id,
          value: 1,
        });
      }
    }
  });

  const nodes = [...documents, ...fragments];

  return { nodes, links };
};

export function MemoryGraph({ memories, onNodeClick, selectedMemoryId }: MemoryGraphProps) {
  const graphRef = useRef<ForceGraphMethods | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [shouldRender, setShouldRender] = useState(true);
  const [graphData, setGraphData] = useState<{ nodes: MemoryNode[]; links: MemoryLink[] }>({
    nodes: [],
    links: [],
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const NODE_REL_SIZE = 4;

  useEffect(() => {
    if (memories.length > 0) {
      const processed = processGraphData(memories);
      setGraphData(processed);
    }
  }, [memories]);

  // Clean up when component unmounts
  useEffect(() => {
    return () => {
      // Clean up references on unmount
      graphRef.current = null;
      setInitialized(false);
      setShouldRender(false);
    };
  }, []);

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

    return () => {
      window.removeEventListener("resize", updateDimensions);
    };
  }, []);

  // Highlight selected node
  useEffect(() => {
    if (initialized && graphRef.current && selectedMemoryId) {
      const node = graphData.nodes.find((n: MemoryNode) => n.id === selectedMemoryId);
      if (node) {
        graphRef.current.centerAt(node.x, node.y, 1000);
        graphRef.current.zoom(2.5, 1000);
      }
    }
  }, [selectedMemoryId, initialized, graphData.nodes]);

  const handleGraphInit = useCallback((graph: ForceGraphMethods) => {
    graphRef.current = graph;

    // Configure the graph force simulation only if graphRef is defined
    if (graph) {
      const chargeForce = graph.d3Force("charge");
      if (chargeForce) {
        chargeForce.strength(-120);
      }

      const linkForce = graph.d3Force("link");
      if (linkForce) {
        linkForce.distance(50);
      }

      graph.zoomToFit(400);
      setInitialized(true);
    }
  }, []);

  const renderLegend = () => (
    <div className="absolute top-4 right-4 p-3 bg-card/90 text-card-foreground border border-border rounded-md shadow-sm text-xs backdrop-blur-sm">
      <div className="font-medium mb-2 text-xs">Legend</div>
      <div className="flex items-center mb-2">
        <div className="w-3 h-3 rounded-full bg-orange-500/90 mr-2 border border-orange-600/60"></div>
        <span>Document</span>
      </div>
      <div className="flex items-center">
        <div className="w-3 h-3 rounded-full bg-gray-400/90 mr-2 border border-gray-500/60"></div>
        <span>Fragment</span>
      </div>
    </div>
  );

  return (
    <div ref={containerRef} className="w-full h-full relative">
      {renderLegend()}
      {shouldRender && (
        <ForceGraph2D
          ref={(graph: ForceGraphMethods | null) => {
            graphRef.current = graph;
            if (graph && !initialized) {
              handleGraphInit(graph);
            }
          }}
          graphData={graphData}
          width={dimensions.width}
          height={dimensions.height}
          backgroundColor="hsla(var(--background), 0.8)"
          linkColor={() => "hsla(var(--muted-foreground), 0.2)"}
          linkWidth={1}
          linkDirectionalParticles={1}
          linkDirectionalParticleWidth={1}
          linkDirectionalParticleSpeed={0.003}
          nodeRelSize={NODE_REL_SIZE}
          nodeVal={(node: MemoryNode) => node.val || 3}
          nodeColor={(node: MemoryNode) =>
            node.type === "document" ? "hsl(30, 100%, 50%)" : "hsl(210, 10%, 70%)"
          }
          nodeLabel={(node: MemoryNode) => {
            const metadata = node.memory.metadata as MemoryMetadata;
            return `${node.type === "document" ? "Document" : "Fragment"}: ${metadata.title || node.id.substring(0, 8)}`;
          }}
          onNodeClick={(node: MemoryNode) => {
            onNodeClick(node.memory);
          }}
          onNodeDragEnd={(node: MemoryNode) => {
            node.fx = node.x;
            node.fy = node.y;
          }}
          cooldownTicks={100}
          nodeCanvasObjectMode={(node: MemoryNode) =>
            selectedMemoryId === node.id ? "after" : "replace"
          }
          nodeCanvasObject={(node: MemoryNode, ctx, globalScale) => {
            const { x, y } = node;
            const size = (node.val || 3) * NODE_REL_SIZE;
            const fontSize = 10 / globalScale;
            const isSelected = selectedMemoryId === node.id;
            const isDocument = node.type === "document";

            ctx.beginPath();
            ctx.arc(x || 0, y || 0, size, 0, 2 * Math.PI);

            ctx.fillStyle = isDocument ? "hsl(30, 100%, 50%)" : "hsl(210, 10%, 70%)";

            ctx.fill();

            ctx.strokeStyle = isDocument ? "hsl(30, 100%, 35%)" : "hsl(210, 10%, 45%)";
            ctx.lineWidth = isSelected ? 2 : 1;
            ctx.stroke();

            if (globalScale >= 1.4 || isSelected) {
              const label = node.name || node.id.substring(0, 6);
              const metadata = node.memory.metadata as MemoryMetadata;
              const nodeText = isDocument
                ? label
                : metadata.position !== undefined
                  ? `#${metadata.position}`
                  : label;

              ctx.font = `${isSelected ? "bold " : ""}${fontSize}px Arial`;
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";

              ctx.strokeStyle = "hsla(var(--background), 0.8)";
              ctx.lineWidth = 3;
              ctx.strokeText(nodeText, x || 0, y || 0);

              ctx.fillStyle = "hsla(var(--foreground), 0.9)";
              ctx.fillText(nodeText, x || 0, y || 0);
            }

            if (isSelected) {
              ctx.beginPath();
              ctx.arc(x || 0, y || 0, size * 1.4, 0, 2 * Math.PI);
              ctx.strokeStyle = isDocument
                ? "hsla(30, 100%, 60%, 0.8)"
                : "hsla(210, 10%, 80%, 0.8)";
              ctx.lineWidth = 1.5;
              ctx.stroke();

              const gradient = ctx.createRadialGradient(
                x || 0,
                y || 0,
                size,
                x || 0,
                y || 0,
                size * 2
              );
              gradient.addColorStop(
                0,
                isDocument ? "hsla(30, 100%, 60%, 0.3)" : "hsla(210, 10%, 80%, 0.3)"
              );
              gradient.addColorStop(1, "hsla(0, 0%, 0%, 0)");

              ctx.fillStyle = gradient;
              ctx.beginPath();
              ctx.arc(x || 0, y || 0, size * 2, 0, 2 * Math.PI);
              ctx.fill();
            }
          }}
        />
      )}
    </div>
  );
}
