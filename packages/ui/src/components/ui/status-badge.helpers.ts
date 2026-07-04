/**
 * Pure mappers from raw status strings to StatusBadge tone + display label,
 * split out from the component so they can be unit-tested and reused without a
 * React render. `statusToneForState` classifies success/warning/danger/muted;
 * `agentLifecycleLabel` maps the cloud-agent lifecycle enum to friendlier
 * first-run copy while `statusLabelForState` stays a generic title-caser.
 */
import type { StatusVariant } from "./status-badge";

export function statusToneForBoolean(
  condition: boolean,
  onTone: StatusVariant = "success",
  offTone: StatusVariant = "muted",
): StatusVariant {
  return condition ? onTone : offTone;
}

export function statusToneForState(status: string): StatusVariant {
  const normalized = status.trim().toLowerCase();
  if (
    normalized === "success" ||
    normalized === "completed" ||
    normalized === "connected" ||
    normalized === "approved" ||
    normalized === "signed" ||
    normalized === "broadcast" ||
    normalized === "confirmed" ||
    normalized === "ready" ||
    // Agent lifecycle: a live container.
    normalized === "running"
  ) {
    return "success";
  }
  if (
    normalized === "warning" ||
    normalized === "pending" ||
    // Agent lifecycle: transitional states (showing the spinning badge).
    normalized === "provisioning" ||
    normalized === "starting" ||
    normalized === "stopping" ||
    normalized === "resuming" ||
    normalized === "suspending"
  ) {
    return "warning";
  }
  if (
    normalized === "error" ||
    normalized === "failed" ||
    normalized === "denied" ||
    normalized === "rejected"
  ) {
    return "danger";
  }
  // Agent lifecycle stopped/suspended/sleeping (and unknown) fall through to the
  // neutral "muted" tone.
  return "muted";
}

export function statusLabelForState(status: string): string {
  const normalized = status.trim().replace(/[_-]+/g, " ");
  if (!normalized) return status;
  return normalized.replace(/\b\w/g, (match) => match.toUpperCase());
}

/**
 * Product copy for cloud-agent *lifecycle* states on user-facing first-run /
 * handoff surfaces. `statusLabelForState` just title-cases the raw DB enum
 * (fine for dev/admin consoles, weak as onboarding copy — users should not see
 * "Resuming"/"Suspended"/"Provisioning" verbatim). This maps the lifecycle
 * enum to friendly copy and falls back to the title-cased label for anything
 * unknown, so it is safe to use anywhere `statusLabelForState` is used for an
 * agent status. It is intentionally separate from `statusLabelForState` so
 * non-lifecycle consumers (e.g. steward transaction states like
 * "broadcast"/"confirmed") keep their own labels.
 */
const AGENT_LIFECYCLE_LABELS: Record<string, string> = {
  running: "Ready",
  ready: "Ready",
  provisioning: "Setting up",
  starting: "Starting up",
  resuming: "Starting up",
  stopping: "Stopping",
  suspending: "Pausing",
  suspended: "Asleep",
  sleeping: "Asleep",
  stopped: "Stopped",
  error: "Failed to start",
  failed: "Failed to start",
};

export function agentLifecycleLabel(status: string): string {
  const normalized = status.trim().toLowerCase();
  return AGENT_LIFECYCLE_LABELS[normalized] ?? statusLabelForState(status);
}
