/**
 * Two-factor authentication status panel. The Cloud API exposes a status
 * contract even while enrollment is unavailable, so the panel reads the DTO and
 * renders loading / unavailable / error / ready as distinct states. Status-only:
 * there is no enrollment form on this surface.
 */

import { Lock } from "lucide-react";
import { useEffect, useState } from "react";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../../../components/settings/settings-layout";
import { api } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";

interface MfaStatusResponse {
  available?: boolean;
  reason?: string | null;
  enrolled?: boolean;
  method?: string | null;
}

type MfaState =
  | { kind: "loading" }
  | { kind: "unavailable"; reason: string | null }
  | { kind: "ready"; enrolled: boolean; method: string | null }
  | { kind: "error"; message: string };

export function MfaPanel() {
  const t = useCloudT();
  const [state, setState] = useState<MfaState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    void api<MfaStatusResponse>("/api/v1/me/mfa")
      .then((payload) => {
        if (!active) return;
        if (payload.available === false) {
          setState({ kind: "unavailable", reason: payload.reason ?? null });
          return;
        }
        if (typeof payload.enrolled !== "boolean") {
          setState({
            kind: "error",
            message: "MFA status response was malformed.",
          });
          return;
        }
        setState({
          kind: "ready",
          enrolled: payload.enrolled,
          method: payload.method ?? null,
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
    <SettingsStack data-testid="cloud-mfa-panel">
      <SettingsGroup
        title={t("cloud.mfaPanel.title", {
          defaultValue: "Two-factor authentication",
        })}
      >
        {state.kind === "loading" ? (
          <SettingsRow
            label={t("cloud.mfaPanel.loading", {
              defaultValue: "Loading MFA status...",
            })}
          />
        ) : state.kind === "unavailable" ? (
          <SettingsRow
            label={t("cloud.mfaPanel.notAvailable", {
              reason: state.reason ?? "",
              defaultValue: "MFA enrollment is unavailable on this server.",
            })}
          />
        ) : state.kind === "error" ? (
          <SettingsRow tone="danger" label={state.message} />
        ) : state.enrolled ? (
          <SettingsRow
            icon={Lock}
            label={t("cloud.mfaPanel.enabled", {
              method:
                state.method ??
                t("cloud.mfaPanel.unknownMethod", {
                  defaultValue: "unknown",
                }),
              defaultValue: "Enabled - method: {{method}}",
            })}
          />
        ) : (
          <SettingsRow
            label={t("cloud.mfaPanel.notEnabled", {
              defaultValue:
                "MFA is not enabled. Adding a second factor protects your account even if your password is compromised.",
            })}
          />
        )}
      </SettingsGroup>
    </SettingsStack>
  );
}
