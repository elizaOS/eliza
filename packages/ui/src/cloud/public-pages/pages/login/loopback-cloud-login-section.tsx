/**
 * Starts the existing hosted CLI-session handoff for loopback staging login.
 * Only the opaque session id returns to the app; Google uses its hosted callback.
 */
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "../../../../components/ui/button";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { ELIZA_CLOUD_DIRECT_API_BY_HOST } from "../../../shell/steward-url";
import { sanitizeLoginReturnTo } from "../../lib/login-return-to";

export default function LoopbackCloudLoginSection() {
  const t = useCloudT();
  const [searchParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const switchAccount = searchParams.get("switchAccount") === "1";
      if (switchAccount) {
        const { prepareSsoAccountSwitch } = await import(
          "../../../sso-bridge/sso-bridge"
        );
        await prepareSsoAccountSwitch();
      }
      const { client } = await import("../../../../api");
      const { resolveDirectCloudWebBase } = await import(
        "../../../../api/client-cloud"
      );
      const apiBase = ELIZA_CLOUD_DIRECT_API_BY_HOST["staging.eliza.app"];
      if (!apiBase) throw new Error("Eliza Cloud sign-in is not configured.");
      const session = await client.cloudLoginDirect(apiBase);
      if (!session.ok || !session.browserUrl || !session.sessionId) {
        throw new Error(session.error || "Could not start sign-in. Try again.");
      }
      const destination = new URL(session.browserUrl);
      if (
        destination.origin !==
          new URL(resolveDirectCloudWebBase(apiBase)).origin ||
        destination.pathname !== "/auth/cli-login" ||
        destination.searchParams.get("session") !== session.sessionId
      ) {
        throw new Error(
          "Eliza Cloud returned an invalid sign-in link. Try again.",
        );
      }
      const requested = sanitizeLoginReturnTo(searchParams.get("returnTo"));
      const returnTo = new URL(requested || "/chat", window.location.origin);
      // Public auth pages cannot consume the app's CLI completion marker.
      if (/^\/(?:login|join|auth)(?:\/|$)/.test(returnTo.pathname)) {
        returnTo.pathname = "/chat";
        returnTo.search = "";
        returnTo.hash = "";
      }
      returnTo.searchParams.set("elizaCloudLogin", "complete");
      returnTo.searchParams.set("elizaCloudLoginSession", session.sessionId);
      destination.searchParams.set("returnTo", returnTo.toString());
      if (switchAccount) {
        const login = new URL("/login", destination.origin);
        login.searchParams.set("switchAccount", "1");
        login.searchParams.set(
          "returnTo",
          destination.pathname + destination.search,
        );
        window.location.assign(login.toString());
      } else {
        window.location.assign(destination.toString());
      }
    } catch (failure) {
      // error-policy:J4 a failed handoff leaves a visible, retryable sign-in action.
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not start sign-in. Try again.",
      );
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        {t("cloud.login.loopbackHandoff", {
          defaultValue:
            "Sign in securely with Eliza Cloud, then return to this app.",
        })}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        className="w-full h-11"
        disabled={busy}
        onClick={() => void signIn()}
      >
        {busy
          ? t("cloud.login.opening", { defaultValue: "Opening sign-in…" })
          : t("cloud.login.continueCloud", {
              defaultValue: "Continue with Eliza Cloud",
            })}
      </Button>
    </div>
  );
}
