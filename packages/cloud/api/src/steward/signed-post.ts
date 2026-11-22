import { STEWARD_AUTH_UPSTREAM_TIMEOUT_MS } from "@elizaos/cloud-shared/lib/auth/steward-client";
import {
  signStewardClientIp,
  signStewardMutatingRequest,
} from "@elizaos/cloud-shared/lib/steward/sign";
import type { AppContext } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { resolveStewardBaseUrl } from "./base-url";

export async function signedStewardPost(
  c: AppContext,
  path: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Response | null> {
  const base = resolveStewardBaseUrl(c.env);
  if (!base) return null;
  const url = new URL(`${base}${path}`);
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extraHeaders,
  });
  const tenant = c.env.STEWARD_TENANT_ID?.trim();
  if (tenant) headers.set("X-Steward-Tenant", tenant);
  const text = JSON.stringify(body);
  const secret = c.env.STEWARD_REQUEST_SIGNING_SECRET;
  if (secret)
    await signStewardMutatingRequest(
      secret,
      "POST",
      `${url.pathname}${url.search}`,
      headers,
      new TextEncoder().encode(text),
    );
  // Steward rate-limits native sign-in per client IP: bind the edge address,
  // or every phone would share the Worker's egress bucket.
  await signStewardClientIp(
    secret ?? null,
    "POST",
    `${url.pathname}${url.search}`,
    headers,
    c.req.header("cf-connecting-ip")?.trim(),
  );
  return fetch(url.toString(), {
    method: "POST",
    headers,
    body: text,
    redirect: "error",
    signal: AbortSignal.timeout(STEWARD_AUTH_UPSTREAM_TIMEOUT_MS),
  });
}
