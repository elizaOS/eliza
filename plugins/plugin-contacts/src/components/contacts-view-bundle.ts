/**
 * Exposes the framed Contacts page and interaction handler under the names read
 * from the separately built Vite view bundle. This host-facing `ContactsView`
 * matches the `/ui` and signed-registration ABI, not the package-root raw view.
 */

export { interact } from "./ContactsAppView.interact.ts";
export { ContactsPage as ContactsView } from "./ContactsPage.tsx";
