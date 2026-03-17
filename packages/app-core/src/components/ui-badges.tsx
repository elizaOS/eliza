import {
  StatCard as UiStatCard,
  type StatCardProps as UiStatCardProps,
  StatusBadge,
  StatusDot,
  cn,
  statusToneForBoolean,
} from "@elizaos/ui";

export { StatusBadge, StatusDot, statusToneForBoolean };
export type {
  StatCardProps,
  StatusBadgeProps,
  StatusDotProps,
  StatusTone,
} from "@elizaos/ui";

export function StatCard(props: UiStatCardProps) {
  return (
    <UiStatCard
      {...props}
      valueClassName={cn(props.valueClassName, props.accent && "text-txt")}
    />
  );
}
