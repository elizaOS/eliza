import * as React from "react";
export type StatusVariant =
  | "success"
  | "warning"
  | "danger"
  | "error"
  | "info"
  | "neutral"
  | "processing"
  | "muted";
export type StatusTone = StatusVariant;
export declare function statusToneForBoolean(
  condition: boolean,
  onTone?: StatusVariant,
  offTone?: StatusVariant,
): StatusVariant;
export declare function statusToneForState(status: string): StatusVariant;
export declare function statusLabelForState(status: string): string;
export interface StatusBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  label: string;
  status?: StatusVariant;
  variant?: StatusVariant;
  tone?: StatusTone;
  withDot?: boolean;
  pulse?: boolean;
  icon?: React.ReactNode;
}
export declare const StatusBadge: React.ForwardRefExoticComponent<
  StatusBadgeProps & React.RefAttributes<HTMLSpanElement>
>;
export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Semantic status string — mapped to a variant internally. */
  status?: string;
  /** Direct variant override — when provided, `status` is ignored. */
  tone?: StatusVariant;
}
export declare const StatusDot: React.ForwardRefExoticComponent<
  StatusDotProps & React.RefAttributes<HTMLSpanElement>
>;
//# sourceMappingURL=status-badge.d.ts.map
