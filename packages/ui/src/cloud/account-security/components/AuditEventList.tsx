/**
 * Renders the account-security audit event list (sign-in/security events) with
 * per-event shield iconography, on the cloud dashboard.
 */
import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { useCloudT } from "../../shell/CloudI18nProvider";

export interface AuditEventRow {
  event_id: string;
  ts: string;
  action: string;
  result: "allow" | "deny" | "error";
  resource?: { type: string; id: string } | null;
  ip?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface AuditEventListProps {
  events: AuditEventRow[];
  emptyMessage?: string;
  className?: string;
}

const RESULT_ICON = {
  allow: ShieldCheck,
  deny: ShieldX,
  error: ShieldAlert,
} as const;

const RESULT_TONE = {
  allow: "text-green-300",
  deny: "text-yellow-300",
  error: "text-red-300",
} as const;

export function AuditEventList({
  events,
  emptyMessage,
  className,
}: AuditEventListProps) {
  const t = useCloudT();
  if (events.length === 0) {
    return (
      <p className="text-sm text-muted">
        {emptyMessage ??
          t("cloud.auditEvents.empty", {
            defaultValue: "No audit events recorded yet.",
          })}
      </p>
    );
  }
  return (
    <ul
      className={`divide-y divide-border ${className ?? ""}`}
      data-testid="audit-event-list"
    >
      {events.map((event) => {
        const Icon = RESULT_ICON[event.result] ?? ShieldAlert;
        const tone = RESULT_TONE[event.result] ?? "text-muted";
        return (
          <li
            key={event.event_id}
            className="flex items-start gap-3 py-2 text-xs"
          >
            <Icon className={`mt-0.5 h-4 w-4 ${tone}`} aria-hidden />
            <div className="flex-1 space-y-0.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono font-medium text-txt-strong">
                  {event.action}
                </span>
                <time
                  className="text-muted"
                  dateTime={event.ts}
                  title={event.ts}
                >
                  {new Date(event.ts).toLocaleString()}
                </time>
              </div>
              {event.resource ? (
                <p className="text-muted">
                  {t("cloud.auditEvents.on", { defaultValue: "on" })}{" "}
                  <span className="font-mono">
                    {event.resource.type}:{event.resource.id}
                  </span>
                </p>
              ) : null}
              {event.ip ? (
                <p className="font-mono text-[11px] text-muted">
                  {t("cloud.auditEvents.ip", {
                    ip: event.ip,
                    defaultValue: "ip {{ip}}",
                  })}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
