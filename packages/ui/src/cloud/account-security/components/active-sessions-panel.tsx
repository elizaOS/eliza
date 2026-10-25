/**
 * Active sessions panel. The Cloud API exposes an explicit session-inventory
 * contract even while revocable sessions are unavailable, so the panel renders
 * loading / unavailable / empty / error / ready from the DTO.
 */

import { useEffect, useState } from "react";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../../../components/settings/settings-layout";
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
        if (!Array.isArray(payload.sessions)) {
          setState({
            kind: "error",
            message: "Session inventory response was malformed.",
          });
          return;
        }
        setState({
          kind: "ready",
          sessions: payload.sessions,
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
    <SettingsStack data-testid="cloud-active-sessions">
      <SettingsGroup
        title={t("cloud.activeSessions.title", {
          defaultValue: "Active sessions",
        })}
        description={t("cloud.activeSessions.description", {
          defaultValue:
            "Devices and browsers currently signed in to your account.",
        })}
      >
        {state.kind === "loading" ? (
          <SettingsRow
            label={t("cloud.activeSessions.loading", {
              defaultValue: "Loading sessions...",
            })}
          />
        ) : state.kind === "unavailable" ? (
          <SettingsRow
            label={t("cloud.activeSessions.notAvailable", {
              reason: state.reason ?? "",
              defaultValue: "Session listing is unavailable on this server.",
            })}
          />
        ) : state.kind === "error" ? (
          <SettingsRow tone="danger" label={state.message} />
        ) : state.sessions.length === 0 ? (
          <SettingsRow
            label={t("cloud.activeSessions.noOther", {
              defaultValue: "No other active sessions found.",
            })}
          />
        ) : (
          state.sessions.map((session) => {
            const device =
              session.device ??
              t("cloud.activeSessions.unknownDevice", {
                defaultValue: "Unknown device",
              });
            return (
              <SettingsRow
                key={session.id}
                active={Boolean(session.current)}
                label={
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span>{device}</span>
                    {session.current ? (
                      <span className="rounded-full border border-border px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-muted">
                        {t("cloud.activeSessions.current", {
                          defaultValue: "current",
                        })}
                      </span>
                    ) : null}
                  </span>
                }
                description={t("cloud.activeSessions.ipLastSeen", {
                  ip: session.ip ?? "-",
                  lastSeen: session.last_seen
                    ? new Date(session.last_seen).toLocaleString()
                    : "-",
                  defaultValue: "{{ip}} - last seen {{lastSeen}}",
                })}
              />
            );
          })
        )}
      </SettingsGroup>
    </SettingsStack>
  );
}
