/** Validates an app-owned billing destination independently of OAuth callbacks, preserving query strings and fragments. */
import { AppDelegationError } from "./app-delegation";

export function validateAppBillingReturnUrl(
  value: string,
  allowedOrigins: ReadonlySet<string>,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // error-policy:J3 Malformed destinations are rejected before registration or provider dispatch.
    throw new AppDelegationError(
      400,
      "APP_BILLING_RETURN_INVALID",
      "Billing return destination must be an absolute HTTPS URL",
    );
  }
  if (url.protocol !== "https:" || url.username || url.password || !allowedOrigins.has(url.origin))
    throw new AppDelegationError(
      400,
      "APP_BILLING_RETURN_INVALID",
      "Billing return destination must use HTTPS on an allowed application origin without credentials",
    );
  return url.toString();
}
