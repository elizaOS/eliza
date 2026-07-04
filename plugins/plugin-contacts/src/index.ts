/** Public package entry: re-exports the plugin, overlay app, views, and register side-effect. */
export { ContactsAppView } from "./components/ContactsAppView";
export { ContactsView } from "./components/ContactsView";
export {
  CONTACTS_APP_NAME,
  contactsApp,
  registerContactsApp,
} from "./components/contacts-app";
export { appContactsPlugin, contactsProvider } from "./plugin";
export * from "./register";
export * from "./ui";
