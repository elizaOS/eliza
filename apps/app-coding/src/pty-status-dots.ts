/** Status dot color classes for coding-agent activity. */
export const STATUS_DOT: Record<string, string> = {
  active: "bg-ok",
  tool_running: "bg-accent",
  blocked: "bg-warn",
  error: "bg-danger",
};

export const PULSE_STATUSES = new Set(["active", "tool_running"]);
