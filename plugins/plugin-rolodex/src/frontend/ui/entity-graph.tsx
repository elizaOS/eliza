import type { Entity, Relationship, UUID } from '@elizaos/core';
import React, { useCallback, useEffect, useRef, useState } from 'react';
// @ts-ignore - react-force-graph-2d doesn't have type declarations
import ForceGraph2D, { ForceGraphMethods, LinkObject, NodeObject } from 'react-force-graph-2d';

// Type definitions for react-force-graph-2d
interface NodeObject {
  id?: string | number;
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
  vx?: number;
  vy?: number;
  val?: number;
  [key: string]: any;
}

interface LinkObject {
  source: string | number | NodeObject;
  target: string | number | NodeObject;
  value?: number;
  [key: string]: any;
}

interface ForceGraphMethods {
  d3Force(forceName: string): any;
  zoomToFit(duration?: number, padding?: number): void;
  centerAt(x?: number, y?: number, duration?: number): void;
  zoom(factor?: number, duration?: number): void;
}

interface EntityNode extends NodeObject {
  id: UUID;
  name: string;
  val?: number; // Node size
  entity: Entity;
  type: 'person' | 'bot' | 'organization';
  trustLevel?: number;
}

interface RelationshipLink extends LinkObject {
  source: UUID;
  target: UUID;
  value?: number; // Link strength/thickness
  type: 'friend' | 'colleague' | 'community' | 'acquaintance' | 'unknown';
  sentiment: 'positive' | 'negative' | 'neutral';
  strength: number;
}

interface EntityGraphProps {
  entities: Entity[];
  relationships: Relationship[];
  onNodeClick?: (entity: Entity) => void;
  selectedEntityId?: UUID;
}

// Process graph data
const processGraphData = (entities: Entity[], relationships: Relationship[]) => {
  const nodes: EntityNode[] = entities.map((entity) => {
    const metadata = entity.metadata || {};
    const trustMetrics = metadata.trustMetrics as any || {};
    
    return {
      id: entity.id!,
      name: entity.names[0] || entity.id!.substring(0, 8),
      entity: entity,
      val: 5 + (trustMetrics.engagement || 0) / 2, // Size based on engagement
      type: (metadata.type || 'person') as 'person' | 'bot' | 'organization',
      trustLevel: trustMetrics.helpfulness - trustMetrics.suspicionLevel,
    };
  });

  const links: RelationshipLink[] = relationships.map((rel) => {
    const metadata = rel.metadata || {};
    return {
      source: rel.sourceEntityId,
      target: rel.targetEntityId,
      value: (rel.strength || 0.5) * 3, // Convert strength to link thickness
      type: (metadata.type || 'unknown') as 'friend' | 'colleague' | 'community' | 'acquaintance' | 'unknown',
      sentiment: (metadata.sentiment || 'neutral') as 'positive' | 'negative' | 'neutral',
      strength: rel.strength || 0.5,
    };
  });

  return { nodes, links };
};

export function EntityGraph({ entities, relationships, onNodeClick, selectedEntityId }: EntityGraphProps) {
  const graphRef = useRef<any>(undefined);
  const [initialized, setInitialized] = useState(false);
  const [graphData, setGraphData] = useState<{ nodes: EntityNode[]; links: RelationshipLink[] }>({
    nodes: [],
    links: [],
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [selectedRelationType, setSelectedRelationType] = useState<string | null>(null);

  const NODE_REL_SIZE = 4;

  // Process graph data
  useEffect(() => {
    const processed = processGraphData(entities, relationships);
    setGraphData(processed);
  }, [entities, relationships]);

  // Update dimensions on load and resize
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
    window.addEventListener('resize', updateDimensions);

    return () => {
      window.removeEventListener('resize', updateDimensions);
    };
  }, []);

  // Highlight selected node
  useEffect(() => {
    if (initialized && graphRef.current && selectedEntityId) {
      const node = graphData.nodes.find((n: EntityNode) => n.id === selectedEntityId);
      if (node) {
        graphRef.current.centerAt(node.x, node.y, 1000);
        graphRef.current.zoom(2.5, 1000);
      }
    }
  }, [selectedEntityId, initialized, graphData.nodes]);

  // Graph initialization
  const handleGraphInit = useCallback((graph: any) => {
    graphRef.current = graph;

    if (graph) {
      const chargeForce = graph.d3Force('charge');
      if (chargeForce) {
        chargeForce.strength(-200); // Stronger repulsion for entities
      }

      const linkForce = graph.d3Force('link');
      if (linkForce) {
        linkForce.distance(80); // More distance between entities
      }

      graph.zoomToFit(400);
      setInitialized(true);
    }
  }, []);

  // Get color for relationship type
  const getRelationshipColor = (link: RelationshipLink) => {
    if (selectedRelationType && link.type !== selectedRelationType) {
      return 'hsla(var(--muted-foreground), 0.1)';
    }

    const colors = {
      friend: 'hsl(120, 70%, 50%)', // Green
      colleague: 'hsl(210, 70%, 50%)', // Blue
      community: 'hsl(280, 70%, 50%)', // Purple
      acquaintance: 'hsl(60, 70%, 50%)', // Yellow
      unknown: 'hsl(0, 0%, 50%)', // Gray
    };

    return colors[link.type] || colors.unknown;
  };

  // Get node color based on trust level
  const getNodeColor = (node: EntityNode) => {
    const trustLevel = node.trustLevel || 0;
    if (trustLevel > 0.5) return 'hsl(120, 70%, 50%)'; // Green - trusted
    if (trustLevel < -0.5) return 'hsl(0, 70%, 50%)'; // Red - suspicious
    return 'hsl(210, 70%, 50%)'; // Blue - neutral
  };

  // Legend with filters
  const renderLegend = () => (
    <div className="absolute top-4 right-4 p-3 bg-card/90 text-card-foreground border border-border rounded-md shadow-sm text-xs backdrop-blur-sm">
      <div className="font-medium mb-2 text-xs">Entity Trust Level</div>
      <div className="flex items-center mb-1">
        <div className="w-3 h-3 rounded-full bg-green-500 mr-2"></div>
        <span>Trusted</span>
      </div>
      <div className="flex items-center mb-1">
        <div className="w-3 h-3 rounded-full bg-blue-500 mr-2"></div>
        <span>Neutral</span>
      </div>
      <div className="flex items-center mb-3">
        <div className="w-3 h-3 rounded-full bg-red-500 mr-2"></div>
        <span>Suspicious</span>
      </div>
      
      <div className="font-medium mb-2 text-xs">Relationship Types</div>
      {['friend', 'colleague', 'community', 'acquaintance'].map((type) => (
        <div 
          key={type}
          className={`flex items-center mb-1 cursor-pointer hover:opacity-80 ${selectedRelationType === type ? 'font-bold' : ''}`}
          onClick={() => setSelectedRelationType(selectedRelationType === type ? null : type)}
        >
          <div 
            className="w-8 h-1 mr-2" 
            style={{ backgroundColor: getRelationshipColor({ type } as RelationshipLink) }}
          ></div>
          <span className="capitalize">{type}</span>
        </div>
      ))}
    </div>
  );

  // Stats panel
  const renderStats = () => {
    const totalRelationships = graphData.links.length;
    const avgStrength = totalRelationships > 0 
      ? graphData.links.reduce((sum, link) => sum + link.strength, 0) / totalRelationships 
      : 0;
    
    const relationshipCounts = graphData.links.reduce((acc, link) => {
      acc[link.type] = (acc[link.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return (
      <div className="absolute bottom-4 left-4 p-3 bg-card/90 text-card-foreground border border-border rounded-md shadow-sm text-xs backdrop-blur-sm">
        <div className="font-medium mb-2">Network Stats</div>
        <div>Entities: {graphData.nodes.length}</div>
        <div>Relationships: {totalRelationships}</div>
        <div>Avg Strength: {avgStrength.toFixed(2)}</div>
        <div className="mt-2">
          {Object.entries(relationshipCounts).map(([type, count]) => (
            <div key={type} className="capitalize">
              {type}: {count}
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div ref={containerRef} className="w-full h-full relative">
      {renderLegend()}
      {renderStats()}
      {graphData.nodes.length > 0 && (
        <ForceGraph2D
          ref={graphRef as any}
          graphData={graphData as any}
          width={dimensions.width}
          height={dimensions.height}
          backgroundColor="hsla(var(--background), 0.8)"
          linkColor={(link: RelationshipLink) => getRelationshipColor(link)}
          linkWidth={(link: RelationshipLink) => link.value || 1}
          linkDirectionalArrowLength={6}
          linkDirectionalArrowRelPos={1}
          linkCurvature={0.2}
          nodeRelSize={NODE_REL_SIZE}
          nodeVal={(node: EntityNode) => node.val || 5}
          nodeColor={(node: EntityNode) => getNodeColor(node)}
          nodeLabel={(node: EntityNode) => {
            const metadata = node.entity.metadata || {};
            const platformIds = metadata.platformIdentities as any[] || [];
            const platforms = platformIds.map(p => `${p.platform}: ${p.handle}`).join('\n');
            return `${node.name}\n${platforms}\nTrust: ${(node.trustLevel || 0).toFixed(2)}`;
          }}
          onNodeClick={(node: EntityNode) => {
            if (onNodeClick) {
              onNodeClick(node.entity);
            }
          }}
          onNodeDragEnd={(node: EntityNode) => {
            node.fx = node.x;
            node.fy = node.y;
          }}
          onEngineStop={() => {
            if (graphRef.current && !initialized) {
              handleGraphInit(graphRef.current);
            }
          }}
          cooldownTicks={100}
          nodeCanvasObjectMode={(node: EntityNode) =>
            selectedEntityId === node.id ? 'after' : 'replace'
          }
          nodeCanvasObject={(node: EntityNode, ctx, globalScale) => {
            const { x, y } = node;
            const size = (node.val || 5) * NODE_REL_SIZE;
            const fontSize = 10 / globalScale;
            const isSelected = selectedEntityId === node.id;

            // Draw node circle
            ctx.beginPath();
            ctx.arc(x || 0, y || 0, size, 0, 2 * Math.PI);
            ctx.fillStyle = getNodeColor(node);
            ctx.fill();

            // Border
            ctx.strokeStyle = isSelected ? '#fff' : 'rgba(0,0,0,0.2)';
            ctx.lineWidth = isSelected ? 2 : 1;
            ctx.stroke();

            // Label
            if (globalScale >= 1.4 || isSelected) {
              const label = node.name;
              ctx.font = `${isSelected ? 'bold ' : ''}${fontSize}px Arial`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';

              // Text outline
              ctx.strokeStyle = 'hsla(var(--background), 0.8)';
              ctx.lineWidth = 3;
              ctx.strokeText(label, x || 0, y || 0);

              // Text
              ctx.fillStyle = 'hsla(var(--foreground), 0.9)';
              ctx.fillText(label, x || 0, y || 0);
            }

            // Selected glow
            if (isSelected) {
              const gradient = ctx.createRadialGradient(x || 0, y || 0, size, x || 0, y || 0, size * 2);
              gradient.addColorStop(0, 'rgba(255, 255, 255, 0.3)');
              gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
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