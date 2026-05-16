import type * as React from "react";
import { cn } from "../../lib/utils";
import { CornerBrackets } from "./corner-brackets";

export interface HUDContainerProps
  extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  cornerSize?: "sm" | "md" | "lg" | "xl";
  cornerColor?: string;
}

export function HUDContainer({
  children,
  className,
  cornerSize = "md",
  cornerColor,
  ...props
}: HUDContainerProps) {
  return (
    <div
      className={cn(
        "relative rounded-sm border border-border/80 bg-bg-elevated/80 text-txt shadow-sm",
        className,
      )}
      {...props}
    >
      <CornerBrackets size={cornerSize} color={cornerColor} />
      {children}
    </div>
  );
}
