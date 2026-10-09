/**
 * Helpers for the subscription/OAuth callback flow: normalize provider callback
 * input into a typed ok/error result and format request errors for display.
 * Keeps callback parsing consistent across the auth surfaces that consume it.
 */
export function formatSubscriptionRequestError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
