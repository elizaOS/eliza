/**
 * Resizable panel components for creating resizable split-pane layouts.
 * Supports horizontal and vertical directions with configurable panel sizes.
 */

"use client";

import * as React from "react";
import { cn } from "../lib/utils";

interface ResizablePanelGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  direction?: "horizontal" | "vertical";
}

interface ResizablePanelProps extends React.HTMLAttributes<HTMLDivElement> {
  defaultSize?: number;
  minSize?: number;
  maxSize?: number;
}

interface ResizableHandleProps extends React.HTMLAttributes<HTMLDivElement> {
  withHandle?: boolean;
}

const ResizablePanelGroupContext = React.createContext<{
  direction: "horizontal" | "vertical";
  panels: Map<number, { size: number; minSize: number; maxSize: number }>;
  setPanelSize: (index: number, size: number) => void;
  registerPanel: (index: number, size: number, minSize: number, maxSize: number) => void;
  unregisterPanel: (index: number) => void;
}>({
  direction: "horizontal",
  panels: new Map(),
  setPanelSize: () => {},
  registerPanel: () => {},
  unregisterPanel: () => {},
});

export function ResizablePanelGroup({
  direction = "horizontal",
  className,
  children,
  ...props
}: ResizablePanelGroupProps) {
  const [panels, setPanels] = React.useState<
    Map<number, { size: number; minSize: number; maxSize: number }>
  >(new Map());

  const registerPanel = React.useCallback(
    (index: number, size: number, minSize: number, maxSize: number) => {
      setPanels((prev) => {
        const next = new Map(prev);
        next.set(index, { size, minSize, maxSize });
        return next;
      });
    },
    [],
  );

  const unregisterPanel = React.useCallback((index: number) => {
    setPanels((prev) => {
      const next = new Map(prev);
      next.delete(index);
      return next;
    });
  }, []);

  const setPanelSize = React.useCallback((index: number, size: number) => {
    setPanels((prev) => {
      const next = new Map(prev);
      const panel = next.get(index);
      if (panel) {
        next.set(index, { ...panel, size });
      }
      return next;
    });
  }, []);

  const contextValue = React.useMemo(
    () => ({
      direction,
      panels,
      setPanelSize,
      registerPanel,
      unregisterPanel,
    }),
    [direction, panels, setPanelSize, registerPanel, unregisterPanel],
  );

  return (
    <ResizablePanelGroupContext.Provider value={contextValue}>
      <div
        className={cn(
          "flex h-full w-full",
          direction === "horizontal" ? "flex-row" : "flex-col",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </ResizablePanelGroupContext.Provider>
  );
}

let panelIdCounter = 0;

export function ResizablePanel({
  defaultSize = 50,
  minSize = 15,
  maxSize = 85,
  className,
  children,
  style,
  ...props
}: ResizablePanelProps) {
  const { direction, registerPanel, unregisterPanel, panels } = React.useContext(
    ResizablePanelGroupContext,
  );
  const [panelId] = React.useState(() => panelIdCounter++);

  React.useEffect(() => {
    registerPanel(panelId, defaultSize, minSize, maxSize);
    return () => unregisterPanel(panelId);
  }, [panelId, defaultSize, minSize, maxSize, registerPanel, unregisterPanel]);

  const panel = panels.get(panelId);
  const size = panel?.size ?? defaultSize;

  return (
    <div
      className={cn("overflow-hidden", className)}
      style={{
        ...style,
        [direction === "horizontal" ? "width" : "height"]: `${size}%`,
        flexShrink: 0,
      }}
      {...props}
    >
      {children}
    </div>
  );
}

export function ResizableHandle({ withHandle = false, className, ...props }: ResizableHandleProps) {
  const { direction, panels, setPanelSize } = React.useContext(ResizablePanelGroupContext);
  const [isDragging, setIsDragging] = React.useState(false);

  const handleMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);

      const panelsArray = Array.from(panels.entries());
      if (panelsArray.length !== 2) return;

      const [[leftId, leftPanel], [rightId, rightPanel]] = panelsArray;
      const container = (e.currentTarget as HTMLElement).parentElement;
      if (!container) return;

      const containerRect = container.getBoundingClientRect();
      const startPos = direction === "horizontal" ? e.clientX : e.clientY;
      const containerSize = direction === "horizontal" ? containerRect.width : containerRect.height;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const currentPos = direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY;
        const _containerStart = direction === "horizontal" ? containerRect.left : containerRect.top;
        const delta = currentPos - startPos;
        const deltaPercent = (delta / containerSize) * 100;

        const newLeftSize = Math.min(
          Math.max(leftPanel.size + deltaPercent, leftPanel.minSize),
          leftPanel.maxSize,
        );
        const newRightSize = Math.min(
          Math.max(rightPanel.size - deltaPercent, rightPanel.minSize),
          rightPanel.maxSize,
        );

        // Ensure total is 100%
        const total = newLeftSize + newRightSize;
        if (total > 0) {
          setPanelSize(leftId, (newLeftSize / total) * 100);
          setPanelSize(rightId, (newRightSize / total) * 100);
        }
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [direction, panels, setPanelSize],
  );

  return (
    <div
      className={cn(
        "group relative flex items-center justify-center bg-transparent transition-colors hover:bg-white/5",
        direction === "horizontal" ? "w-[6px] cursor-col-resize" : "h-[6px] cursor-row-resize",
        isDragging && "bg-white/10",
        className,
      )}
      onMouseDown={handleMouseDown}
      {...props}
    >
      {withHandle && (
        <div
          className={cn(
            "absolute z-10 rounded-sm bg-white/20 transition-all group-hover:bg-white/40",
            direction === "horizontal" ? "h-12 w-1" : "h-1 w-12",
            isDragging && "bg-white/60",
          )}
        />
      )}
    </div>
  );
}
