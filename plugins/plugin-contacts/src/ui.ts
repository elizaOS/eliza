/**
 * Host-facing UI entry. The stable `ContactsView` name deliberately resolves
 * to the framed page here, while the package root retains the raw embeddable
 * view for internal composition.
 */
export { ContactsAppView } from "./components/ContactsAppView.tsx";
export {
  ContactsPage,
  ContactsPage as ContactsView,
} from "./components/ContactsPage.tsx";
export {
  CONTACTS_APP_NAME,
  contactsApp,
  registerContactsApp,
} from "./components/contacts-app.ts";
