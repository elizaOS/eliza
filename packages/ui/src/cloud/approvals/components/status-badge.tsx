/**
 * Status pill for approvals / ballots / sensitive-requests.
 *
 * Maps each terminal/active status to a neutral, success, warning, or
 * destructive tone — no blue (per the migration design rules). Pending/active
 * states use the brand-accent (orange) outline; terminal-good uses success;
 * terminal-bad uses the destructive token; neutral-terminal uses the muted
 * outline.
 */

import {
  StatusBadge as SharedStatusBadge,
  type StatusVariant,
} from "../../../components/ui/status-badge";

type Tone = "accent" | "success" | "danger" | "neutral";

const TONE_VARIANT: Record<Tone, StatusVariant> = {
  accent: "warning",
  success: "success",
  danger: "danger",
  neutral: "muted",
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

export function ApprovalStatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? "neutral";
  const label = STATUS_LABEL[status] ?? status;
  return (
    <SharedStatusBadge
      label={label}
      variant={TONE_VARIANT[tone]}
      className="text-xs font-medium normal-case"
    />
  );
}
