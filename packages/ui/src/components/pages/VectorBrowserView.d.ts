import type { ReactNode } from "react";
import type * as Three from "three";
import { type MemoryRecord } from "./vector-browser-utils";
export declare function VectorGraph3D({
  memories,
  onSelect,
  createRenderer,
}: {
  memories: MemoryRecord[];
  onSelect: (mem: MemoryRecord) => void;
  createRenderer?: () => Promise<Three.WebGLRenderer>;
}): import("react/jsx-runtime").JSX.Element;
export declare function VectorBrowserView({
  leftNav,
  contentHeader,
}: {
  leftNav?: ReactNode;
  contentHeader?: ReactNode;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=VectorBrowserView.d.ts.map
