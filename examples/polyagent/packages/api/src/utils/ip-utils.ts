/**
 * IP Address Utility Functions
 *
 * Provides utilities for extracting and hashing IP addresses from requests.
 * Used for detecting self-referrals and preventing gaming of the referral system.
 */

import { createHash } from "node:crypto";

/**
 * Hash an IP address using SHA-256 for privacy
 *
 * @param ip - IP address to hash
 * @returns Hashed IP address (hex string)
 */
export function hashIpAddress(ip: string): string {
  return createHash("sha256").update(ip).digest("hex");
}

/**
 * Extract client IP address from request headers
 *
 * Handles various proxy headers and falls back to direct connection IP.
 * Checks X-Forwarded-For, X-Real-IP, and CF-Connecting-IP headers.
 *
 * @param headers - Headers object (from NextRequest or standard Headers)
 * @returns Client IP address or null if not found
 */
export function getClientIp(
  headers:
    | Headers
    | Map<string, string>
    | Record<string, string | string[] | undefined>,
): string | null {
  // Helper to get header value
  const getHeader = (name: string): string | null => {
    if (headers instanceof Headers) {
      return headers.get(name);
    }
    if (headers instanceof Map) {
      return headers.get(name) || null;
    }
    const value = headers[name];
    if (Array.isArray(value)) {
      return value[0] || null;
    }
    return value || null;
  };

  // Check X-Forwarded-For header (most common proxy header)
  const forwardedFor = getHeader("x-forwarded-for");
  if (forwardedFor) {
    // X-Forwarded-For can contain multiple IPs, take the first one (original client)
    const firstIp = forwardedFor.split(",")[0]?.trim();
    if (firstIp) return firstIp;
  }

  // Check X-Real-IP header (nginx proxy)
  const realIp = getHeader("x-real-ip");
  if (realIp) return realIp.trim();

  // Check CF-Connecting-IP header (Cloudflare)
  const cfIp = getHeader("cf-connecting-ip");
  if (cfIp) return cfIp.trim();

  // Fallback: try to get from headers
  const remoteAddress = getHeader("remote-addr");
  if (remoteAddress) return remoteAddress.trim();

  return null;
}

/**
 * Hash client IP from request headers
 *
 * Convenience function that combines getClientIp and hashIpAddress
 *
 * @param headers - Headers object (from NextRequest or standard Headers)
 * @returns Hashed IP address or null if IP not found
 */
export function getHashedClientIp(
  headers:
    | Headers
    | Map<string, string>
    | Record<string, string | string[] | undefined>,
): string | null {
  const ip = getClientIp(headers);
  if (!ip) return null;
  return hashIpAddress(ip);
}
