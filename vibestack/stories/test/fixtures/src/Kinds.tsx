import type { ReactNode } from "react";

export interface KindsProps {
  /** What it is called. */
  label: string;
  flag?: boolean;
  count?: number;
  tone?: "info" | "warn" | "bad";
  onPick?: (id: string) => void;
  icon?: ReactNode;
  box?: { width: number };
  items?: string[];
  anything?: unknown;
}

/** One prop of every kind. */
export function Kinds({ label, flag, count = 2, tone = "info", onPick, icon, items = [] }: KindsProps) {
  return (
    <button data-tone={tone} data-flag={flag} onClick={() => onPick?.(label)}>
      {icon}
      {label} {count} {items.join(",")}
    </button>
  );
}

export const helper = 1;
export function notAComponent(): number {
  return 1;
}
