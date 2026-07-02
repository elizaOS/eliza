/**
 * Payment-success callback page (public). Handles redirects from external
 * payment providers (OxaPay/Stripe): checks the Steward session client-side and
 * redirects to billing settings (or the app-charge page) — or to login with a
 * returnTo when signed out.
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
    const appId = searchParams.get("app_id");
    const chargeRequestId = searchParams.get("charge_request_id");

    if (appId && chargeRequestId) {
      const chargeParams = new URLSearchParams();
      chargeParams.set("payment", "success");
      if (trackId) chargeParams.set("trackId", trackId);
      if (status) chargeParams.set("status", status);
      navigate(
        `/payment/app-charge/${encodeURIComponent(appId)}/${encodeURIComponent(chargeRequestId)}?${chargeParams.toString()}`,
        { replace: true },
      );
      return;
    }

    const targetParams = new URLSearchParams();
    targetParams.set("tab", "billing");
    targetParams.set("payment", "success");
    if (trackId) targetParams.set("trackId", trackId);
    if (status) targetParams.set("status", status);
    const targetPath = `/dashboard/settings?${targetParams.toString()}`;

    if (authenticated) {
      navigate(targetPath, { replace: true });
    } else {
      const loginParams = new URLSearchParams({ returnTo: targetPath });
      navigate(`/login?${loginParams.toString()}`, { replace: true });
    }
  }, [ready, authenticated, navigate, searchParams]);

  return (
    <div className="flex h-screen w-full items-center justify-center bg-[#0A0A0A]">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="relative">
          <CheckCircle className="h-12 w-12 text-green-500" />
          <Loader2 className="absolute -bottom-1 -right-1 h-5 w-5 animate-spin text-white/60" />
        </div>
        <div className="space-y-2">
          <h1 className="text-xl font-mono text-white">
            {t("cloud.paymentSuccess.received", {
              defaultValue: "Payment Received",
            })}
          </h1>
          <p className="text-sm text-white/74 font-mono">
            {t("cloud.paymentSuccess.redirecting", {
              defaultValue: "Redirecting to your dashboard...",
            })}
          </p>
        </div>
      </div>
    </div>
  );
}
