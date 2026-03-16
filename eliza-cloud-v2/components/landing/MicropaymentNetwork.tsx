"use client";

import React, { useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  Node,
  Edge,
  useNodesState,
  useEdgesState,
  Position,
  Handle,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Image from "next/image";

// Custom floating node component
const FloatingNode = ({
  data,
}: {
  data: {
    label: string;
    color: string;
    isCenter?: boolean;
    type?: "agent" | "chain";
    image?: string;
  };
}) => {
  return (
    <div className="relative">
      {data.isCenter && (
        <>
          <Handle
            type="target"
            position={Position.Top}
            style={{ opacity: 0 }}
          />
          <Handle
            type="source"
            position={Position.Bottom}
            style={{ opacity: 0 }}
          />
          <Handle
            type="source"
            position={Position.Left}
            style={{ opacity: 0 }}
          />
          <Handle
            type="source"
            position={Position.Right}
            style={{ opacity: 0 }}
          />
        </>
      )}
      {!data.isCenter && (
        <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      )}

      <div
        className={`${data.isCenter ? "w-20 h-20" : data.type === "agent" ? "w-8 h-8" : "w-12 h-12"} ${data.type === "agent" ? "rounded-sm" : "rounded-full"} flex items-center justify-center transition-all duration-200 overflow-hidden`}
        style={{
          backgroundColor:
            data.isCenter || data.image ? "transparent" : data.color,
          boxShadow: `0 0 ${data.isCenter ? "30px" : data.type === "agent" ? "15px" : "20px"} ${data.color}80`,
        }}
      >
        {data.isCenter ? (
          <div className="relative w-full h-full rounded-full overflow-hidden">
            <Image
              src="/eliza.png"
              alt="Eliza"
              fill
              sizes="80px"
              className="object-cover"
            />
          </div>
        ) : data.image ? (
          <div
            className={`relative w-full h-full overflow-hidden ${data.type === "agent" ? "rounded-sm" : "rounded-full"}`}
          >
            <Image
              src={data.image}
              alt={data.label}
              fill
              sizes={data.type === "agent" ? "32px" : "48px"}
              className={
                data.type === "agent" ? "object-cover" : "object-contain p-1"
              }
            />
          </div>
        ) : null}
      </div>
    </div>
  );
};

const nodeTypes = {
  floating: FloatingNode,
};

export default function MicropaymentNetwork() {
  const { fitView } = useReactFlow();

  useEffect(() => {
    const handle = () => fitView({ padding: 0.2, duration: 300 });
    window.addEventListener("resize", handle);
    return () => window.removeEventListener("resize", handle);
  }, [fitView]);

  const initialNodes: Node[] = useMemo(
    () => [
      // Center agent
      {
        id: "center",
        data: { label: "Agent", color: "#FF5800", isCenter: true },
        position: { x: 250, y: 130 },
        type: "floating",
      },
      // Blockchain nodes with crypto logos
      {
        id: "eth",
        data: {
          label: "Ethereum",
          color: "#3b82f6",
          type: "chain",
          image: "/eth.png",
        },
        position: { x: 75, y: 40 },
        type: "floating",
      },
      {
        id: "sol",
        data: {
          label: "Solana",
          color: "#06b6d4",
          type: "chain",
          image: "/solana.png",
        },
        position: { x: 425, y: 50 },
        type: "floating",
      },
      {
        id: "base",
        data: {
          label: "Base",
          color: "#8b5cf6",
          type: "chain",
          image: "/base.png",
        },
        position: { x: 50, y: 190 },
        type: "floating",
      },
      {
        id: "hl",
        data: {
          label: "Hyperliquid",
          color: "#10b981",
          type: "chain",
          image: "/hl.png",
        },
        position: { x: 450, y: 200 },
        type: "floating",
      },
      // Small agent nodes with avatar images
      {
        id: "agent1",
        data: {
          label: "Agent 1",
          color: "#",
          type: "agent",
          image: "/otaku.png",
        },
        position: { x: 172, y: 93 },
        type: "floating",
      },
      {
        id: "agent2",
        data: {
          label: "Agent 2",
          color: "#",
          type: "agent",
          image: "/babylon.jpeg",
        },
        position: { x: 403, y: 141 },
        type: "floating",
      },
    ],
    [],
  );

  const initialEdges: Edge[] = useMemo(
    () => [
      {
        id: "e-center-eth",
        source: "center",
        target: "eth",
        animated: true,
        style: { stroke: "#316AFFCC", strokeWidth: 2.5 },
      },
      {
        id: "e-center-sol",
        source: "center",
        target: "sol",
        animated: true,
        style: { stroke: "#316AFFCC", strokeWidth: 2.5 },
      },
      {
        id: "e-center-base",
        source: "center",
        target: "base",
        animated: true,
        style: { stroke: "#316AFFCC", strokeWidth: 2.5 },
      },
      {
        id: "e-center-hl",
        source: "center",
        target: "hl",
        animated: true,
        style: { stroke: "#316AFFCC", strokeWidth: 2.5 },
      },
      {
        id: "e-center-agent1",
        source: "center",
        target: "agent1",
        animated: true,
        style: { stroke: "#FF5800CC", strokeWidth: 2.5 },
      },
      {
        id: "e-center-agent2",
        source: "center",
        target: "agent2",
        animated: true,
        style: { stroke: "#FF5800CC", strokeWidth: 2.5 },
      },
    ],
    [],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Store base positions
  const basePositions = useRef<Record<string, { x: number; y: number }>>(
    initialNodes.reduce(
      (acc, node) => {
        acc[node.id] = { x: node.position.x, y: node.position.y };
        return acc;
      },
      {} as Record<string, { x: number; y: number }>,
    ),
  );

  // Subtle hovering animation effect
  useEffect(() => {
    const animationInterval = setInterval(() => {
      const time = Date.now();
      setNodes((prevNodes) =>
        prevNodes.map((node) => {
          const amplitude = node.id === "center" ? 3 : 4;
          const frequency = 0.0008;
          const offset =
            Math.sin(time * frequency + node.id.charCodeAt(0)) * amplitude;
          const basePos = basePositions.current[node.id];

          return {
            ...node,
            position: {
              x: basePos.x,
              y: basePos.y + offset,
            },
          };
        }),
      );
    }, 16); // ~60fps

    return () => clearInterval(animationInterval);
  }, [setNodes]);

  return (
    <div className="relative w-full h-[280px] pointer-events-none">
      {/* Geometric criss-cross background lines */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{ opacity: 0.15 }}
      >
        <defs>
          <pattern
            id="criss-cross"
            x="0"
            y="0"
            width="60"
            height="60"
            patternUnits="userSpaceOnUse"
          >
            {/* Diagonal lines */}
            <line
              x1="0"
              y1="0"
              x2="60"
              y2="60"
              stroke="white"
              strokeWidth="0.5"
            />
            <line
              x1="60"
              y1="0"
              x2="0"
              y2="60"
              stroke="white"
              strokeWidth="0.5"
            />
            {/* Horizontal and vertical grid */}
            <line
              x1="0"
              y1="30"
              x2="60"
              y2="30"
              stroke="white"
              strokeWidth="0.3"
            />
            <line
              x1="30"
              y1="0"
              x2="30"
              y2="60"
              stroke="white"
              strokeWidth="0.3"
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#criss-cross)" />
      </svg>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        panOnScroll={false}
        panOnDrag={false}
        preventScrolling={true}
        style={{ background: "transparent" }}
      />
    </div>
  );
}
