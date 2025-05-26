import { useMemo, useRef, useEffect, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { Memory } from '@elizaos/core';
import { computePca } from '@/lib/pca';

export default function MemoryGraph({
  memories,
  onSelect,
}: {
  memories: Memory[];
  onSelect: (m: Memory) => void;
}) {
  const graphRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (graphRef.current) {
      setDimensions({
        width: graphRef.current.offsetWidth,
        height: graphRef.current.offsetHeight,
      });
    }
    const handleResize = () => {
      if (graphRef.current) {
        setDimensions({
          width: graphRef.current.offsetWidth,
          height: graphRef.current.offsetHeight,
        });
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const data = useMemo(() => {
    console.log('Processing memories for graph:', memories.length);

    // Filter memories with valid embeddings
    const memoriesWithEmbeddings = memories.filter(
      (m) => m.embedding && Array.isArray(m.embedding) && m.embedding.length > 0
    );

    console.log('Memories with embeddings:', memoriesWithEmbeddings.length);

    if (memoriesWithEmbeddings.length === 0) {
      return { nodes: [], links: [], hasEmbeddings: false };
    }

    const embeddings = memoriesWithEmbeddings.map((m) => m.embedding as number[]);

    // Compute PCA coordinates
    const coords = computePca(embeddings, 2);

    // Scale coordinates to fit the graph area with some padding
    const padding = 50;
    const scale = Math.min(dimensions.width - 2 * padding, dimensions.height - 2 * padding) * 0.3;
    const centerX = dimensions.width / 2;
    const centerY = dimensions.height / 2;

    const nodes = memoriesWithEmbeddings.map((m, i) => ({
      id: m.id || String(i),
      memory: m,
      x: coords[i][0] * scale + centerX,
      y: coords[i][1] * scale + centerY,
      fx: coords[i][0] * scale + centerX, // Fixed position
      fy: coords[i][1] * scale + centerY, // Fixed position
      val: 8, // Slightly larger node size
      color: m.entityId === m.agentId ? '#3b82f6' : '#10b981', // Blue for agent, green for user
    }));

    // Create links between temporally adjacent memories
    const links: any[] = [];
    const sortedMemories = [...memoriesWithEmbeddings].sort(
      (a, b) => (a.createdAt || 0) - (b.createdAt || 0)
    );

    // Only create links if there are enough memories
    if (sortedMemories.length > 1) {
      for (let i = 0; i < sortedMemories.length - 1; i++) {
        const sourceNode = nodes.find((n) => n.memory.id === sortedMemories[i].id);
        const targetNode = nodes.find((n) => n.memory.id === sortedMemories[i + 1].id);

        if (sourceNode && targetNode) {
          links.push({
            source: sourceNode.id,
            target: targetNode.id,
            value: 0.2,
          });
        }
      }
    }

    return { nodes, links, hasEmbeddings: true };
  }, [memories, dimensions]);

  // Loading or empty state
  if (!data.hasEmbeddings) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground mb-2">No embeddings available for visualization</p>
          <p className="text-sm text-muted-foreground">
            Embeddings are required to display the memory graph
          </p>
        </div>
      </div>
    );
  }

  return (
    <div ref={graphRef} className="w-full h-full bg-muted/10 rounded-lg relative">
      {/* Legend */}
      <div className="absolute top-4 left-4 bg-background/90 backdrop-blur-sm border rounded-lg p-3 z-10">
        <h4 className="text-sm font-medium mb-2">Legend</h4>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-blue-500"></div>
            <span className="text-xs">Agent Messages</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-green-500"></div>
            <span className="text-xs">User Messages</span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-2">Click nodes to view details</p>
      </div>

      {dimensions.width > 0 && dimensions.height > 0 && data.nodes.length > 0 && (
        <ForceGraph2D
          width={dimensions.width}
          height={dimensions.height}
          graphData={data}
          nodeLabel={(node: any) => {
            const content = node.memory?.content;
            const text = content?.text || '';
            const truncated = text.length > 100 ? text.substring(0, 100) + '...' : text;
            return truncated || node.memory?.id || 'Memory';
          }}
          onNodeClick={(node: any) => {
            console.log('Node clicked:', node);
            if (node.memory) {
              onSelect(node.memory);
            }
          }}
          nodeCanvasObject={(node: any, ctx, globalScale) => {
            const label = node.memory?.entityId === node.memory?.agentId ? 'A' : 'U';
            const fontSize = 12 / globalScale;
            ctx.font = `${fontSize}px Sans-Serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            // Draw node circle
            ctx.beginPath();
            ctx.arc(node.x, node.y, node.val, 0, 2 * Math.PI, false);
            ctx.fillStyle = node.color;
            ctx.fill();

            // Draw label
            ctx.fillStyle = 'white';
            ctx.fillText(label, node.x, node.y);
          }}
          linkColor={() => '#64748b'}
          backgroundColor="#00000000"
          enableZoomInteraction={true}
          enableNodeDrag={false}
        />
      )}
    </div>
  );
}
