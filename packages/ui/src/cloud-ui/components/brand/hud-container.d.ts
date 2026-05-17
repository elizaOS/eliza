import type * as React from "react";
export interface HUDContainerProps
  extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  cornerSize?: "sm" | "md" | "lg" | "xl";
  cornerColor?: string;
}
export declare function HUDContainer({
  children,
  className,
  cornerSize,
  cornerColor,
  ...props
}: HUDContainerProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=hud-container.d.ts.map
