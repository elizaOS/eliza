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
    normalized === "ready"
  ) {
    return "success";
  }
  if (normalized === "warning" || normalized === "pending") {
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
  return "muted";
}

export function statusLabelForState(status: string): string {
  const normalized = status.trim().replace(/[_-]+/g, " ");
  if (!normalized) return status;
  return normalized.replace(/\b\w/g, (match) => match.toUpperCase());
}
