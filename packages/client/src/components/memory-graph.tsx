import { useMemo } from 'react';
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
  const data = useMemo(() => {
    const embeddings = memories
      .map((m) => m.embedding)
      .filter((e): e is number[] => Array.isArray(e));
    if (embeddings.length === 0) return { nodes: [], links: [] };
    const coords = computePca(embeddings, 2);
    const nodes = memories.map((m, i) => ({
      id: m.id || String(i),
      memory: m,
      fx: coords[i][0],
      fy: coords[i][1],
    }));
    return { nodes, links: [] };
  }, [memories]);

  return (
    <ForceGraph2D
      graphData={data}
      nodeLabel={(node) =>
        (node as any).memory?.metadata?.title ||
        (node as any).memory?.content?.text ||
        (node as any).id
      }
      onNodeClick={(node) => onSelect((node as any).memory)}
    />
  );
}
