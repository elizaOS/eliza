/**
 * Agent summary card composed from the canonical Card surface.
 */
import type * as React from "react";
import { Card } from "../../../components/ui/card";
import { cn } from "../../lib/utils";
import { CornerBrackets } from "./corner-brackets";

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
    <Card variant="brand" className={cn("group", className)}>
      <CornerBrackets />
      <div
        className="mb-4 inline-flex rounded-sm border border-current/15 p-3"
        style={{
          backgroundColor: `${color}20`,
          color,
        }}
      >
        {icon}
      </div>

      <h3 className="text-xl font-bold text-txt-strong mb-2">{title}</h3>
      <p className="text-muted-foreground text-sm mb-4">{description}</p>

      {action}
    </Card>
  );
}
