/**
 * Brand card: flat surface, theme-token driven, xs rounding, with optional corner brackets.
 *
 * @param props.hover - Enable hover treatment (border + bg shift)
 * @param props.corners - Render corner brackets
 * @param props.cornerSize - Corner bracket size
 * @param props.cornerColor - Corner bracket color override (defaults to currentColor)
 * @param props.asChild - If true, render as Radix Slot child
 */

import type * as React from "react";
import { Card } from "../../../components/ui/card";
import { cn } from "../../lib/utils";
import { CornerBrackets } from "./corner-brackets";

interface BrandCardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  className?: string;
  hover?: boolean;
  corners?: boolean;
  cornerSize?: "sm" | "md" | "lg" | "xl";
  cornerColor?: string;
  asChild?: boolean;
}

export function BrandCard({
  children,
  className,
  hover = false,
  corners = true,
  cornerSize = "md",
  cornerColor,
  asChild = false,
  ...props
}: BrandCardProps) {
  return (
    <Card
      asChild={asChild}
      variant="brand"
      className={cn(hover && "group", className)}
      {...props}
    >
      {corners && <CornerBrackets size={cornerSize} color={cornerColor} />}
      {children}
    </Card>
  );
}

interface AgentCardProps {
  title: string;
  description: string;
  icon: React.ReactNode;
  color: string;
  action?: React.ReactNode;
  className?: string;
}

export function AgentCard({
  title,
  description,
  icon,
  color,
  action,
  className,
}: AgentCardProps) {
  return (
    <BrandCard hover className={cn("group", className)}>
      <div
        className="mb-4 inline-flex rounded-sm border border-current/15 p-3"
        style={{
          backgroundColor: `${color}20`,
          color: color,
        }}
      >
        {icon}
      </div>

      <h3 className="text-xl font-bold text-txt-strong mb-2">{title}</h3>
      <p className="text-muted-foreground text-sm mb-4">{description}</p>

      {action && action}
    </BrandCard>
  );
}
