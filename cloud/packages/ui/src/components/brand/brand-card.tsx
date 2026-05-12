/**
 * Brand card component with brand styling and optional corner bracket decorations.
 * Supports hover effects and customizable corner styling.
 *
 * @param props - Brand card props
 * @param props.hover - Whether to enable hover effects
 * @param props.corners - Whether to display corner brackets
 * @param props.cornerSize - Size of corner brackets (sm, md, lg, xl)
 * @param props.cornerColor - Color of corner brackets
 * @param props.asChild - If true, renders as a child component
 */

import { Slot } from "@radix-ui/react-slot";
import * as React from "react";
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
  cornerColor = "#E1E1E1",
  asChild = false,
  ...props
}: BrandCardProps) {
  const Component = asChild ? Slot : "div";

  return (
    <Component
      className={cn(
        "relative border border-white/10 bg-black/55 p-4 md:p-6 !rounded-none backdrop-blur-sm",
        hover &&
          "group transition-[border-color,background-color,transform] duration-300 hover:border-white/25 hover:bg-black/65",
        className,
      )}
      {...props}
    >
      {corners && <CornerBrackets size={cornerSize} color={cornerColor} />}
      {children}
    </Component>
  );
}

// Agent card variant used in landing page
interface AgentCardProps {
  title: string;
  description: string;
  icon: React.ReactNode;
  color: string;
  action?: React.ReactNode;
  className?: string;
}

export function AgentCard({ title, description, icon, color, action, className }: AgentCardProps) {
  return (
    <BrandCard hover className={cn("group", className)}>
      {/* Icon */}
      <div
        className="mb-4 inline-flex border border-current/15 p-3 !rounded-none"
        style={{
          backgroundColor: `${color}20`,
          color: color,
        }}
      >
        {icon}
      </div>

      {/* Content */}
      <h3 className="text-xl font-bold text-white mb-2">{title}</h3>
      <p className="text-white/60 text-sm mb-4">{description}</p>

      {/* Action */}
      {action && action}
    </BrandCard>
  );
}
