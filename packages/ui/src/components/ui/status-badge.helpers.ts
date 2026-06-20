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
