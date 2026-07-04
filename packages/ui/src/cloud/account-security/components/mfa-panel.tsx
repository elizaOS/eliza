/**
 * Two-factor authentication status panel. Reads GET /api/v1/me/mfa and renders
 * the backend's explicit unavailable state until enrollment support exists.
 *
 * NOTE: the "Enroll a second factor" button is not wired — there is no MFA
 * enrollment endpoint yet (only the read route). The CTA renders so the surface
 * is complete; wire it once the backend ships an enroll flow (TOTP / WebAuthn).
 */

import { Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { BrandButton, BrandCard, CornerBrackets } from "../../../cloud-ui";
import { api } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";

interface MfaStatusResponse {
  available?: boolean;
  enrolled: boolean;
  method?: "totp" | "webauthn" | null;
  reason?: string;
}

type MfaState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "ready"; enrolled: boolean; method?: string | null }
  | { kind: "error"; message: string };

export function MfaPanel() {
  const t = useCloudT();
  const [state, setState] = useState<MfaState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<MfaStatusResponse>("/api/v1/me/mfa");
        if (cancelled) return;
        if (data.available === false) {
          setState({ kind: "missing" });
          return;
        }
        if (typeof data.enrolled !== "boolean") {
          throw new Error("Malformed MFA status response");
        }
        setState({
          kind: "ready",
          enrolled: data.enrolled,
          method: data.method ?? null,
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />
      <div className="relative z-10 space-y-3">
        <div className="flex items-center gap-2">
          <Lock className="h-5 w-5 text-[var(--brand-orange)]" />
          <h3 className="text-lg font-bold text-white">
            {t("cloud.mfaPanel.title", {
              defaultValue: "Two-factor authentication",
            })}
          </h3>
        </div>
        {state.kind === "loading" ? (
          <p className="text-sm text-white/50">
            {t("cloud.mfaPanel.loading", {
              defaultValue: "Loading MFA status…",
            })}
          </p>
        ) : state.kind === "missing" ? (
          <p className="text-sm text-white/60">
            {t("cloud.mfaPanel.notAvailable", {
              defaultValue:
                "MFA enrollment is not yet available on this server. We'll surface this CTA once the backend ships.",
            })}
          </p>
        ) : state.kind === "error" ? (
          <p className="text-sm text-red-300">{state.message}</p>
        ) : state.enrolled ? (
          <p className="text-sm text-green-300">
            {t("cloud.mfaPanel.enabled", {
              method:
                state.method ??
                t("cloud.mfaPanel.unknownMethod", {
                  defaultValue: "unknown",
                }),
              defaultValue: "Enabled · method: {{method}}",
            })}
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-white/60">
              {t("cloud.mfaPanel.notEnabled", {
                defaultValue:
                  "MFA is not enabled. Adding a second factor protects your account even if your password is compromised.",
              })}
            </p>
            <BrandButton size="sm" variant="outline" disabled>
              {t("cloud.mfaPanel.enroll", {
                defaultValue: "Enroll a second factor",
              })}
            </BrandButton>
          </div>
        )}
      </div>
    </BrandCard>
  );
}
