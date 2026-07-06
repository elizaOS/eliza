/**
 * Two-factor authentication status panel. The Cloud API exposes a status
 * contract even while enrollment is unavailable, so the panel reads the DTO and
 * renders loading / unavailable / error / ready as distinct states.
 */

import { Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { BrandCard, CornerBrackets } from "../../../cloud-ui";
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
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />
      <div className="relative z-10 space-y-3">
        <div className="flex items-center gap-2">
          <Lock className="h-5 w-5 text-muted" />
          <h3 className="text-lg font-bold text-txt-strong">
            {t("cloud.mfaPanel.title", {
              defaultValue: "Two-factor authentication",
            })}
          </h3>
        </div>
        {state.kind === "loading" ? (
          <p className="text-sm text-muted">
            {t("cloud.mfaPanel.loading", {
              defaultValue: "Loading MFA status...",
            })}
          </p>
        ) : state.kind === "unavailable" ? (
          <p className="text-sm text-muted">
            {t("cloud.mfaPanel.notAvailable", {
              reason: state.reason ?? "",
              defaultValue: "MFA enrollment is unavailable on this server.",
            })}
          </p>
        ) : state.kind === "error" ? (
          <p className="text-sm text-red-600 dark:text-red-300">
            {state.message}
          </p>
        ) : state.enrolled ? (
          <p className="text-sm text-green-700 dark:text-green-300">
            {t("cloud.mfaPanel.enabled", {
              method:
                state.method ??
                t("cloud.mfaPanel.unknownMethod", {
                  defaultValue: "unknown",
                }),
              defaultValue: "Enabled - method: {{method}}",
            })}
          </p>
        ) : (
          <p className="text-sm text-muted">
            {t("cloud.mfaPanel.notEnabled", {
              defaultValue:
                "MFA is not enabled. Adding a second factor protects your account even if your password is compromised.",
            })}
          </p>
        )}
      </div>
    </BrandCard>
  );
}
