import type { Metadata } from "next";
import { requireAuth } from "@/lib/auth";
import { SettingsPageClient } from "@/components/settings/settings-page-client";

export const metadata: Metadata = {
  title: "Settings",
  description: "Manage your account preferences, profile, and settings",
};

// Force dynamic rendering since we use server-side auth (cookies)
export const dynamic = "force-dynamic";

/**
 * Settings page for managing user account preferences, profile, and settings.
 *
 * @returns The rendered settings page client component.
 */
export default async function SettingsPage() {
  const user = await requireAuth();

  return <SettingsPageClient user={user} />;
}

/* ============================================================
 * COMMENTED OUT: StripeElementsProvider
 *
 * The StripeElementsProvider was previously used to wrap the settings page
 * to provide Stripe Elements context for the payment method modals.
 *
 * Since the billing flow now uses Stripe Checkout (redirect-based) instead
 * of Stripe Elements (embedded forms), this provider is no longer needed.
 *
 * To restore, uncomment the import and wrapper below:
 *
 * import { StripeElementsProvider } from "@/lib/stripe/stripe-elements-provider";
 *
 * export default async function SettingsPage() {
 *   const user = await requireAuth();
 *
 *   return (
 *     <StripeElementsProvider>
 *       <SettingsPageClient user={user} />
 *     </StripeElementsProvider>
 *   );
 * }
 * ============================================================ */
