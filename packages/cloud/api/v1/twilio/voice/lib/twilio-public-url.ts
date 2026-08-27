/** Resolves signed Twilio webhook URLs from the canonical configured origin. */

import { ElizaError } from "@elizaos/core/edge";
import type { AppContext } from "@/types/cloud-worker-env";

export function resolveTwilioPublicUrl(c: AppContext, pathname: string): URL {
  const configured = (c.env.TWILIO_PUBLIC_URL as string | undefined)?.trim();
  if (!configured) {
    throw new ElizaError(
      "TWILIO_PUBLIC_URL must configure the public HTTPS origin",
      {
        code: "TWILIO_PUBLIC_URL_REQUIRED",
        context: { pathname },
        severity: "fatal",
      },
    );
  }

  let publicBase: URL;
  try {
    publicBase = new URL(configured);
  } catch (cause) {
    // error-policy:J2 retain the invalid configured value's parse failure while
    // exposing only its stable setting name at the route boundary.
    throw new ElizaError("TWILIO_PUBLIC_URL must be a valid HTTPS origin", {
      code: "TWILIO_PUBLIC_URL_INVALID",
      context: { setting: "TWILIO_PUBLIC_URL", pathname },
      cause,
      severity: "fatal",
    });
  }
  if (
    publicBase.protocol !== "https:" ||
    publicBase.username !== "" ||
    publicBase.password !== "" ||
    publicBase.pathname !== "/" ||
    publicBase.search !== "" ||
    publicBase.hash !== ""
  ) {
    throw new ElizaError(
      "TWILIO_PUBLIC_URL must be a credential-free HTTPS origin",
      {
        code: "TWILIO_PUBLIC_URL_INVALID",
        context: { setting: "TWILIO_PUBLIC_URL", pathname },
        severity: "fatal",
      },
    );
  }

  const url = new URL(publicBase.origin);
  url.pathname = pathname;
  // The request query is part of Twilio's signed callback URL. Preserve it,
  // while deriving authority exclusively from the configured origin.
  url.search = new URL(c.req.url).search;
  return url;
}
