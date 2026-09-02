/**
 * Exposes the framed Phone page and interaction handler under the names read
 * from the separately built Vite view bundle. This host-facing `PhoneView`
 * matches the `/ui` and signed-registration ABI, not the package-root raw view.
 */

export { PhonePage as PhoneView } from "./PhonePage.tsx";
export { interact } from "./phone-interact.ts";
