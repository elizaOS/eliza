/**
 * Host-facing UI entry. The stable `MessagesView` name deliberately resolves
 * to the framed page here, while the package root retains the raw embeddable
 * view for internal composition.
 */

export {
  MessagesPage,
  MessagesPage as MessagesView,
} from "./components/MessagesPage.tsx";
