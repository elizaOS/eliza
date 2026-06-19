/**
 * Status pill for approvals / ballots / sensitive-requests.
 *
 * Maps each terminal/active status to a neutral, success, warning, or
 * destructive tone — no blue (per the migration design rules). Pending/active
 * states use the brand-accent (orange) outline; terminal-good uses success;
 * terminal-bad uses the destructive token; neutral-terminal uses the muted
 * outline.
 */

import { cn } from "../../../lib/utils";

type Tone = "accent" | "success" | "danger" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  accent: "border-accent/40 text-accent bg-accent/10",
  success: "border-success/40 text-success bg-success/10",
  danger: "border-destructive/40 text-danger bg-destructive/10",
  neutral: "border-border text-muted bg-bg-accent",
};

const STATUS_TONE: Record<string, Tone> = {
  // approval-requests
  pending: "accent",
  delivered: "accent",
  approved: "success",
  denied: "danger",
  expired: "neutral",
  canceled: "neutral",
  // ballots
  open: "accent",
  tallied: "success",
  // sensitive-requests
  fulfilled: "success",
  failed: "danger",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  delivered: "Awaiting signature",
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
  canceled: "Canceled",
  open: "Open",
  tallied: "Tallied",
  fulfilled: "Fulfilled",
  failed: "Failed",
};

export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? "neutral";
  const label = STATUS_LABEL[status] ?? status;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-2 py-0.5 text-xs font-medium",
        TONE_CLASS[tone],
      )}
    >
      {label}
    </span>
  );
}
