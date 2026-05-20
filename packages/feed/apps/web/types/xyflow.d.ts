declare module '@xyflow/react' {
  import type { ComponentType, CSSProperties } from 'react';

  export interface Node<T = Record<string, unknown>> {
    id: string;
    type?: string;
    data: T;
    position: { x: number; y: number };
    style?: CSSProperties;
    [key: string]: unknown;
  }

  export interface Edge {
    id: string;
    source: string;
    target: string;
    type?: string;
    animated?: boolean;
    style?: CSSProperties;
    label?: string;
    markerEnd?: { type: string; color?: string };
    [key: string]: unknown;
  }

  export const MarkerType: { ArrowClosed: string };

  export interface NodeProps<T = Record<string, unknown>> {
    id: string;
    data: T;
    type?: string;
    selected?: boolean;
  }

  export const Position: {
    Top: string;
    Bottom: string;
    Left: string;
    Right: string;
  };

  export const Handle: ComponentType<{
    type: 'source' | 'target';
    position: string;
    style?: CSSProperties;
    id?: string;
  }>;

  // biome-ignore lint/suspicious/noExplicitAny: ambient type for uninstalled package
  export function useNodesState<_T = any>(initial: any[]): [any[], any, any];
  // biome-ignore lint/suspicious/noExplicitAny: ambient type for uninstalled package
  export function useEdgesState<_T = any>(initial: any[]): [any[], any, any];

  // biome-ignore lint/suspicious/noExplicitAny: ambient type for uninstalled package
  export const ReactFlow: ComponentType<any>;
  export const Controls: ComponentType<{ style?: CSSProperties }>;
  // biome-ignore lint/suspicious/noExplicitAny: ambient type for uninstalled package
  export const MiniMap: ComponentType<any>;
  // biome-ignore lint/suspicious/noExplicitAny: ambient type for uninstalled package
  export const Background: ComponentType<any>;
  export const BackgroundVariant: { Dots: string };
}

declare module '@xyflow/react/dist/style.css' {}
