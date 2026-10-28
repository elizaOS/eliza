/** Verify client attribution across Cloudflare zones before trusting a proxy address. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export function verifiedProxyClientIp(
  request: Request,
  secret: unknown,
  now: number = Date.now(),
): string | undefined {
  if (typeof secret !== "string" || !secret) return undefined;
  const ip = request.headers.get("x-steward-client-ip");
  const expiry = request.headers.get("x-steward-client-ip-expires");
  const signature = request.headers.get("x-steward-client-ip-signature");
  if (
    !ip ||
    !isIP(ip) ||
    !expiry ||
    !/^\d+$/.test(expiry) ||
    !signature ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return undefined;
  const expiresAt = Number(expiry);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < now ||
    expiresAt > now + 65_000
  )
    return undefined;
  const url = new URL(request.url);
  // Keep the domain-separated payload aligned with Cloud's signStewardClientIp.
  const payload = JSON.stringify([
    "steward-client-ip-v1",
    request.method.toUpperCase(),
    `${url.pathname}${url.search}`,
    expiry,
    ip,
  ]);
  const expected = createHmac("sha256", secret).update(payload).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"))
    ? ip
    : undefined;
}
