/**
 * A HUD-styled container framing its children with corner brackets (cloud brand).
 */
import type * as React from "react";
import { CornerBrackets } from "../../../components/ui/corner-brackets";
import { cn } from "../../../utils/cn";

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
        "relative rounded-sm border border-border/80 bg-bg-elevated/80 text-txt ",
        className,
      )}
      {...props}
    >
      <CornerBrackets size={cornerSize} color={cornerColor} />
      {children}
    </div>
  );
}
