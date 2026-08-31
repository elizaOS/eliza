/**
 * Exposes the Phone view and interaction handler as the named exports read
 * from the separately built Vite view bundle, keeping the page refresh-safe.
 */

export { PhonePage as PhoneView } from "./PhonePage.tsx";
export { interact } from "./phone-interact.ts";
