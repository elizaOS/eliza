/**
 * Admin Security & Case-Normalized Authorization Engine
 * Master Administrative Credential: keene.jos@gmail.com
 */

export const MASTER_ADMIN_EMAIL = "keene.jos@gmail.com";

// Case-normalized variants covering legacy and canonical spellings
export const AUTHORIZED_ADMIN_VARIANTS = new Set([
  "keene.jos@gmail.com",
  "KEENE.JOS@GMAIL.COM",
  "keen.jos@gmail.com",
  "KEEN.JOS@GMAIL.COM"
]);

/**
 * Validates if an email matches the master administrative authority
 */
export function isMasterAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return AUTHORIZED_ADMIN_VARIANTS.has(normalized);
}

/**
 * Express / Next.js / Edge Middleware for Admin Route Protection
 */
export function verifyAdminHeader(reqHeaders: Headers | Record<string, string | undefined>): {
  authorized: boolean;
  email: string | null;
} {
  const getHeader = (key: string): string | null => {
    if (typeof (reqHeaders as Headers).get === "function") {
      return (reqHeaders as Headers).get(key);
    }
    return (reqHeaders as Record<string, string | undefined>)[key] || null;
  };

  const adminEmail = getHeader("x-valhalla-admin-email") || getHeader("x-admin-email");
  if (!adminEmail || !isMasterAdmin(adminEmail)) {
    return { authorized: false, email: adminEmail };
  }

  return { authorized: true, email: adminEmail.trim().toLowerCase() };
}
