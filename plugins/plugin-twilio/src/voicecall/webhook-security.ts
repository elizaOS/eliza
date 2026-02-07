/**
 * Webhook security utilities for the Voice Call plugin.
 *
 * Provides URL reconstruction, host header injection prevention,
 * proxy IP validation, and timing-safe signature comparison.
 */

import crypto from "node:crypto";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface WebhookSecurityConfig {
  /** Hosts allowlisted for forwarding header trust. */
  allowedHosts?: string[];
  /** Trust forwarding headers without allowlist check. */
  trustForwardingHeaders?: boolean;
  /** Only trust forwarded headers from these proxy IPs. */
  trustedProxyIPs?: string[];
}

export interface WebhookUrlReconstructionOptions {
  /** Raw request URL path (req.url). */
  requestUrl: string;
  /** Host header. */
  hostHeader?: string;
  /** X-Forwarded-Proto header. */
  forwardedProto?: string;
  /** X-Forwarded-Host header. */
  forwardedHost?: string;
  /** X-Forwarded-Port header. */
  forwardedPort?: string;
  /** Remote IP of the incoming request. */
  remoteAddress?: string;
  /** Security config controlling forwarding trust. */
  security?: WebhookSecurityConfig;
  /** Fallback public URL if headers cannot be trusted. */
  fallbackUrl?: string;
}

// -----------------------------------------------------------------------------
// Timing-safe comparison
// -----------------------------------------------------------------------------

/**
 * Timing-safe string comparison.
 * Avoids leaking signature length/content via timing side channels.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Pad to same length to still do constant-time compare
    const maxLen = Math.max(a.length, b.length);
    const paddedA = Buffer.alloc(maxLen);
    const paddedB = Buffer.alloc(maxLen);
    paddedA.write(a);
    paddedB.write(b);
    crypto.timingSafeEqual(paddedA, paddedB);
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// -----------------------------------------------------------------------------
// Host header injection prevention
// -----------------------------------------------------------------------------

/** Valid host header: alphanumeric, dots, dashes, colons (port), no slashes. */
const VALID_HOST_RE = /^[a-zA-Z0-9._:-]+$/;

/**
 * Validate a host header value to prevent host header injection.
 */
export function isValidHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  return VALID_HOST_RE.test(host);
}

// -----------------------------------------------------------------------------
// Proxy IP validation
// -----------------------------------------------------------------------------

/**
 * Check if a remote address is a trusted proxy.
 */
export function isTrustedProxy(
  remoteAddress: string | undefined,
  trustedIPs: string[] | undefined,
): boolean {
  if (!trustedIPs || trustedIPs.length === 0) return false;
  if (!remoteAddress) return false;

  // Normalize IPv6-mapped IPv4 addresses
  const normalizedRemote = remoteAddress.replace(/^::ffff:/, "");

  return trustedIPs.some((trusted) => {
    const normalizedTrusted = trusted.replace(/^::ffff:/, "");
    return normalizedRemote === normalizedTrusted;
  });
}

// -----------------------------------------------------------------------------
// URL reconstruction
// -----------------------------------------------------------------------------

/**
 * Can we trust forwarding headers for this request?
 */
function canTrustForwardingHeaders(
  opts: WebhookUrlReconstructionOptions,
): boolean {
  const sec = opts.security;
  if (!sec) return false;

  // If trustForwardingHeaders is explicitly set, use it
  if (sec.trustForwardingHeaders === true) return true;

  // If trustedProxyIPs are configured, check the remote address
  if (sec.trustedProxyIPs && sec.trustedProxyIPs.length > 0) {
    return isTrustedProxy(opts.remoteAddress, sec.trustedProxyIPs);
  }

  // If allowedHosts are configured, check the forwarded host
  if (sec.allowedHosts && sec.allowedHosts.length > 0) {
    const fwdHost = opts.forwardedHost;
    if (!fwdHost) return false;
    const hostOnly = fwdHost.split(":")[0].toLowerCase();
    return sec.allowedHosts.some(
      (allowed) => allowed.toLowerCase() === hostOnly,
    );
  }

  return false;
}

/**
 * Reconstruct the public webhook URL from request headers.
 *
 * This is needed for Twilio signature verification when behind
 * a proxy, tunnel, or load balancer.
 */
export function reconstructWebhookUrl(
  opts: WebhookUrlReconstructionOptions,
): string {
  // If forwarding headers are trusted, reconstruct from them
  if (canTrustForwardingHeaders(opts)) {
    const proto = opts.forwardedProto || "https";
    const host = opts.forwardedHost;
    if (host && isValidHostHeader(host)) {
      return `${proto}://${host}${opts.requestUrl}`;
    }
  }

  // Fallback to explicit public URL
  if (opts.fallbackUrl) {
    // Append path from requestUrl if not already included
    const url = new URL(opts.fallbackUrl);
    return `${url.origin}${opts.requestUrl}`;
  }

  // Last resort: use the Host header directly
  if (opts.hostHeader && isValidHostHeader(opts.hostHeader)) {
    return `http://${opts.hostHeader}${opts.requestUrl}`;
  }

  return `http://localhost${opts.requestUrl}`;
}

// -----------------------------------------------------------------------------
// Twilio signature validation
// -----------------------------------------------------------------------------

/**
 * Compute Twilio signature (HMAC-SHA1, base64).
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  // Build the data string: URL + sorted params
  let data = url;
  const sortedKeys = Object.keys(params).sort();
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  return crypto.createHmac("sha1", authToken).update(data, "utf-8").digest("base64");
}

/**
 * Validate a Twilio webhook signature.
 */
export function validateTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string,
): boolean {
  const expected = computeTwilioSignature(authToken, url, params);
  return timingSafeEqual(expected, signature);
}
