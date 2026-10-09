/**
 * Payment-success callback page (public). Handles redirects from external
 * payment providers (OxaPay/Stripe): checks the Steward session client-side and
 * redirects to billing settings — or to login with a returnTo when signed out.
 */

import { CheckCircle, Loader2 } from "lucide-react";
import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useSessionAuth } from "../../../lib/use-session-auth";
import { useCloudT } from "../../../shell/CloudI18nProvider";

export default function PaymentSuccessPage() {
  const t = useCloudT();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { ready, authenticated } = useSessionAuth();

  useEffect(() => {
    if (!ready) return;

    const trackId = searchParams.get("trackId");
    const status = searchParams.get("status");
    const targetParams = new URLSearchParams();
    targetParams.set("payment", "success");
    if (trackId) targetParams.set("trackId", trackId);
    if (status) targetParams.set("status", status);
    const targetPath = `/cloud/billing?${targetParams.toString()}`;

    if (authenticated) {
      navigate(targetPath, { replace: true });
    } else {
      const loginParams = new URLSearchParams({ returnTo: targetPath });
      navigate(`/login?${loginParams.toString()}`, { replace: true });
    }
  }, [ready, authenticated, navigate, searchParams]);

  return (
    <div className="theme-cloud flex min-h-[100dvh] w-full items-center justify-center bg-bg">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="relative">
          <CheckCircle className="size-12 text-status-success" />
          <Loader2 className="absolute -bottom-1 -right-1  size-5 animate-spin text-muted" />
        </div>
        <div className="space-y-2">
          <h1 className="text-xl text-txt">
            {t("cloud.paymentSuccess.received", {
              defaultValue: "Payment Received",
            })}
          </h1>
          <p className="text-sm text-muted">
            {t("cloud.paymentSuccess.redirecting", {
              defaultValue: "Redirecting to Cloud billing...",
            })}
          </p>
        </div>
      </div>
    </div>
  );
}
