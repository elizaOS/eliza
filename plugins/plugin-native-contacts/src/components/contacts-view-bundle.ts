/**
 * Exposes the embeddable Contacts view and interaction handler under the names
 * read from the separately built Vite view bundle. The remote-view host owns
 * page chrome; signed native registration continues to mount `ContactsPage`.
 */

export { interact } from "./ContactsAppView.interact.ts";
export { ContactsView } from "./ContactsView.tsx";
