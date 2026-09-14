/**
 * Public package entry for plugin/runtime consumers. `MessagesView` remains the
 * raw embeddable surface; hosts that own page navigation load the framed
 * `MessagesPage` through the `/ui`, signed-registration, or view-bundle ABI.
 */

export { MessagesPage } from "./components/MessagesPage";
export { MessagesView } from "./components/MessagesView";
export { appMessagesPlugin, default } from "./plugin";
export * from "./register";
export * from "./ui";
