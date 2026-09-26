/**
 * Public package entry for plugin/runtime consumers. `ContactsView` remains the
 * raw embeddable surface; hosts that own page navigation load the framed
 * `ContactsPage` through the `/ui`, signed-registration, or view-bundle ABI.
 */
export { ContactsAppView } from "./components/ContactsAppView";
export { ContactsPage } from "./components/ContactsPage";
export { ContactsView } from "./components/ContactsView";
export {
  CONTACTS_APP_NAME,
  contactsApp,
  registerContactsApp,
} from "./components/contacts-app";
export { appContactsPlugin, contactsProvider } from "./plugin";
export * from "./register";
export * from "./ui";
