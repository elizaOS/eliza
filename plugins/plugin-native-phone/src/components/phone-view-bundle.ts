/**
 * Exposes the embeddable Phone view and interaction handler under the names
 * read from the separately built Vite view bundle. The remote-view host owns
 * page chrome; signed native registration continues to mount `PhonePage`.
 */

export { PhoneView } from "./PhoneView.tsx";
export { interact } from "./phone-interact.ts";
