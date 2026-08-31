/**
 * Exposes the Contacts view and interaction handler as the named exports read
 * from the separately built Vite view bundle, keeping the page refresh-safe.
 */

export { interact } from "./ContactsAppView.interact.ts";
export { ContactsPage as ContactsView } from "./ContactsPage.tsx";
