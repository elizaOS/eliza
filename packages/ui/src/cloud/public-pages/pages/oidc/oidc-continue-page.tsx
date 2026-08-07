/**
 * `/oidc/continue` — the one hop between the console login page and the OpenID
 * Provider's `/authorize/resume` endpoint on the API origin.
 *
 * The provider cannot send a signed-out browser back to itself directly: the
 * login page sanitizes `returnTo` to a same-origin path, so the round trip
 * carries only an opaque request id. This page turns that id back into the
 * absolute resume URL and hard-navigates, which is also what makes the Steward
 * session cookie present on arrival.
 *
 * The destination origin comes from the configured issuer, never from the URL,
 * so this route cannot be used as an open redirect. An expired link and a
 * deployment that never configured the issuer are DIFFERENT screens: only the
 * first is worth retrying, and the second names the variable to set rather than
 * blaming the user's link.
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import {
  buildOidcResumeTarget,
  OIDC_ISSUER_ENV_VAR,
  type OidcResumeTarget,
} from "../../lib/oidc-continue";
import { usePageTitle } from "../../lib/use-page-title";

export default function OidcContinuePage() {
  const t = useCloudT();
  const [searchParams] = useSearchParams();
  const [failure, setFailure] = useState<OidcResumeTarget["status"] | null>(
    null,
  );

  usePageTitle(
    t("cloud.oidcContinue.metaTitle", {
      defaultValue: "Signing in | Eliza Cloud",
    }),
  );

  const requestId = searchParams.get("rid");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const target = buildOidcResumeTarget(
      requestId,
      window.location.hostname,
      window.location.origin,
    );
    if (target.status !== "ok") {
      setFailure(target.status);
      return;
    }
    // `replace` keeps the bounce out of history, so Back returns to the
    // application the user came from rather than re-triggering the resume.
    window.location.replace(target.url);
  }, [requestId]);

  return (
    <div className="theme-cloud relative flex min-h-[100dvh] items-center justify-center bg-bg p-4">
      <div className="relative w-full max-w-md bg-card border border-border p-8 text-center">
        {failure === "issuer_unconfigured" ? (
          <p className="text-fg">
            {t("cloud.oidcContinue.issuerUnconfigured", {
              defaultValue:
                "Single sign-on is not configured for this deployment: {{envVar}} is unset, so there is no identity provider to return to.",
              envVar: OIDC_ISSUER_ENV_VAR,
            })}
          </p>
        ) : failure ? (
          <p className="text-fg">
            {t("cloud.oidcContinue.expired", {
              defaultValue:
                "This sign-in request is no longer valid. Return to the application and start sign-in again.",
            })}
          </p>
        ) : (
          <p className="text-muted-fg">
            {t("cloud.oidcContinue.redirecting", {
              defaultValue: "Completing sign-in…",
            })}
          </p>
        )}
      </div>
    </div>
  );
}
