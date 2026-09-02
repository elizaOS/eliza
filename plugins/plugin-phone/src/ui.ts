/**
 * Host-facing UI re-exports. The stable `PhoneView` name deliberately resolves
 * to the framed page here, while the package root retains the raw embeddable
 * dialer for internal composition.
 */

export { Chat as PhoneCompanionChat } from "./companion/components/Chat.tsx";
export { Pairing as PhoneCompanionPairing } from "./companion/components/Pairing.tsx";
export { PhoneCompanionApp } from "./companion/components/PhoneCompanionApp.tsx";
export { RemoteSession as PhoneCompanionRemoteSession } from "./companion/components/RemoteSession.tsx";
export { PhonePage as PhoneView } from "./components/PhonePage.tsx";
