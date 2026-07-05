/**
 * Active sessions panel. The Cloud API exposes an explicit session-inventory
 * contract even while revocable sessions are unavailable, so the panel renders
 * loading / unavailable / empty / error / ready from the DTO.
 */

import { useEffect, useState } from "react";
import { BrandCard, CornerBrackets } from "../../../cloud-ui";
import { api } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";

interface SessionRow {
  id: string;
  device?: string | null;
  ip?: string | null;
  user_agent?: string | null;
  last_seen?: string | null;
  current?: boolean;
}

interface SessionsResponse {
  available?: boolean;
  reason?: string | null;
  sessions?: SessionRow[];
}

type SessionsState =
  | { kind: "loading" }
  | { kind: "unavailable"; reason: string | null }
  | { kind: "ready"; sessions: SessionRow[] }
  | { kind: "error"; message: string };

export function ActiveSessionsPanel() {
  const t = useCloudT();
  const [state, setState] = useState<SessionsState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    void api<SessionsResponse>("/api/v1/sessions")
      .then((payload) => {
        if (!active) return;
        if (payload.available === false) {
          setState({
            kind: "unavailable",
            reason: payload.reason ?? null,
          });
          return;
        }
        setState({
          kind: "ready",
          sessions: Array.isArray(payload.sessions) ? payload.sessions : [],
        });
      })
      .catch((error) => {
        if (!active) return;
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />
      <div className="relative z-10 space-y-4">
        <div>
          <h3 className="text-lg font-bold text-txt-strong">
            {t("cloud.activeSessions.title", {
              defaultValue: "Active sessions",
            })}
          </h3>
          <p className="text-sm text-muted">
            {t("cloud.activeSessions.description", {
              defaultValue:
                "Devices and browsers currently signed in to your account.",
            })}
          </p>
        </div>
        {state.kind === "loading" ? (
          <p className="text-sm text-muted">
            {t("cloud.activeSessions.loading", {
              defaultValue: "Loading sessions...",
            })}
          </p>
        ) : state.kind === "unavailable" ? (
          <p className="text-sm text-muted">
            {t("cloud.activeSessions.notAvailable", {
              reason: state.reason ?? "",
              defaultValue: "Session listing is unavailable on this server.",
            })}
          </p>
        ) : state.kind === "error" ? (
          <p className="text-sm text-red-300">{state.message}</p>
        ) : state.sessions.length === 0 ? (
          <p className="text-sm text-muted">
            {t("cloud.activeSessions.noOther", {
              defaultValue: "No other active sessions found.",
            })}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {state.sessions.map((session) => (
              <li
                key={session.id}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <div className="space-y-0.5">
                  <p className="font-medium text-txt-strong">
                    {session.device ??
                      t("cloud.activeSessions.unknownDevice", {
                        defaultValue: "Unknown device",
                      })}
                    {session.current ? (
                      <span className="ml-2 rounded-sm border border-green-500/40 bg-green-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-green-300">
                        {t("cloud.activeSessions.current", {
                          defaultValue: "current",
                        })}
                      </span>
                    ) : null}
                  </p>
                  <p className="font-mono text-[11px] text-muted">
                    {t("cloud.activeSessions.ipLastSeen", {
                      ip: session.ip ?? "-",
                      lastSeen: session.last_seen
                        ? new Date(session.last_seen).toLocaleString()
                        : "-",
                      defaultValue: "{{ip}} - last seen {{lastSeen}}",
                    })}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </BrandCard>
  );
}
