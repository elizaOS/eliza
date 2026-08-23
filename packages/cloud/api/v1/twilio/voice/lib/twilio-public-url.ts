/** Resolves the externally signed Twilio webhook URL behind trusted proxies. */

import type { AppContext } from "@/types/cloud-worker-env";

export function resolveTwilioPublicUrl(c: AppContext, pathname: string): URL {
  const url = new URL(c.req.url);
  const forwardedProto = c.req.header("x-forwarded-proto");
  const forwardedHost = c.req.header("x-forwarded-host");
  if (forwardedProto) url.protocol = `${forwardedProto}:`;
  if (forwardedHost) url.host = forwardedHost;
  const configured = (c.env.TWILIO_PUBLIC_URL as string | undefined)?.trim();
  if (configured) {
    const publicBase = new URL(configured);
    url.protocol = publicBase.protocol;
    url.host = publicBase.host;
  }
  url.pathname = pathname;
  return url;
}
