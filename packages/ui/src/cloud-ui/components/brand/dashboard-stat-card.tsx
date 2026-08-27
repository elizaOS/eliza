/**
 * A single dashboard stat card (label + value) built on canonical Card.
 */
import type { ReactNode } from "react";
import { Badge, type BadgeProps } from "../../../components/ui/badge";
import { Card } from "../../../components/ui/card";
import { cn } from "../../lib/utils";

type DashboardStatAccent =
  | "orange"
  | "amber"
  | "blue"
  | "emerald"
  | "red"
  | "violet"
  | "white";

const accentStyles: Record<DashboardStatAccent, string> = {
  orange: "text-accent",
  amber: "text-warn",
  blue: "text-status-info",
  emerald: "text-ok",
  red: "text-danger",
  violet: "text-status-info",
  white: "text-txt-strong",
};

const accentBadges: Record<
  DashboardStatAccent,
  NonNullable<BadgeProps["variant"]>
> = {
  orange: "primingIcon",
  amber: "statusWarning",
  blue: "statusInfo",
  emerald: "statusSuccess",
  red: "statusDanger",
  violet: "statusInfo",
  white: "providerMarkActive",
};

interface DashboardStatCardProps {
  label: string;
  value: string | number;
  icon?: ReactNode;
  helper?: string;
  accent?: DashboardStatAccent;
  className?: string;
  valueClassName?: string;
}

export function DashboardStatCard({
  label,
  value,
  icon,
  helper,
  accent = "white",
  className,
  valueClassName,
}: DashboardStatCardProps) {
  return (
    <Card
      className={cn("min-h-[108px] justify-between p-4", className)}
      variant="brand"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <p className="text-xs-tight uppercase tracking-[0.24em] text-muted-foreground">
            {label}
          </p>
          <p
            className={cn(
              "break-words text-xl font-semibold leading-tight md:text-2xl",
              accentStyles[accent],
              valueClassName,
            )}
          >
            {value}
          </p>
        </div>
        {icon ? (
          <Badge
            variant={accentBadges[accent]}
            size="providerMark"
            className="flex size-10 shrink-0 items-center justify-center"
          >
            {icon}
          </Badge>
        ) : null}
      </div>
      {helper ? (
        <p className="text-xs text-muted-foreground">{helper}</p>
      ) : null}
    </Card>
  );
}
