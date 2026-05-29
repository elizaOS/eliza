import { BrandButton, BrandCard, CornerBrackets } from "@elizaos/ui";
import { Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api-client";
import { useT } from "@/providers/I18nProvider";

interface MfaStatusResponse {
  enrolled: boolean;
  method?: "totp" | "webauthn" | null;
}

export function MfaPanel() {
  const t = useT();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "missing" }
    | { kind: "ready"; enrolled: boolean; method?: string | null }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<MfaStatusResponse>("/api/v1/me/mfa");
        if (cancelled) return;
        setState({
          kind: "ready",
          enrolled: !!data.enrolled,
          method: data.method ?? null,
        });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setState({ kind: "missing" });
          return;
        }
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
          <Lock className="h-5 w-5 text-[#FF5800]" />
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
            <BrandButton size="sm" variant="outline">
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
