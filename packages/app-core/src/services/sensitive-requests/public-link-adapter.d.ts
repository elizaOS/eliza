/**
 * `public_link` delivery adapter.
 *
 * Generates an unauthenticated payment URL for `kind === "payment"` with
 * `paymentContext.kind === "any_payer"`. Refuses every other shape with a
 * structured `DeliveryFailure` so the caller can fall back to a different
 * adapter (cloud authenticated link, DM, etc.).
 *
 * The adapter never makes network calls — URL construction is purely
 * declarative against the resolved cloud base URL.
 */
import { type SensitiveRequestDeliveryAdapter } from "@elizaos/core";
export declare const publicLinkSensitiveRequestAdapter: SensitiveRequestDeliveryAdapter;
//# sourceMappingURL=public-link-adapter.d.ts.map
