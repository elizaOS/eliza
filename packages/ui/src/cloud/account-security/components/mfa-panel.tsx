/**
 * Two-factor authentication status panel. The Worker does not currently expose
 * an MFA status route, so keep the panel in the explicit unavailable state
 * instead of firing a dead request on Security page load.
 *
 * NOTE: the "Enroll a second factor" button is not wired — there is no MFA
 * enrollment endpoint yet (only the read route). The CTA renders so the surface
 * is complete; wire it once the backend ships an enroll flow (TOTP / WebAuthn).
 */

import { Lock } from "lucide-react";
import { useState } from "react";
import { BrandButton, BrandCard, CornerBrackets } from "../../../cloud-ui";
import { useCloudT } from "../../shell/CloudI18nProvider";

type MfaState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "ready"; enrolled: boolean; method?: string | null }
  | { kind: "error"; message: string };

export function MfaPanel() {
  const t = useCloudT();
  const [state] = useState<MfaState>({ kind: "missing" });

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
