/**
 * Public UI re-exports: the companion components and the unified PhoneView under
 * stable, package-scoped names for hosts that import views directly.
 */

export { Chat as PhoneCompanionChat } from "./companion/components/Chat.tsx";
export { Pairing as PhoneCompanionPairing } from "./companion/components/Pairing.tsx";
export { PhoneCompanionApp } from "./companion/components/PhoneCompanionApp.tsx";
export { RemoteSession as PhoneCompanionRemoteSession } from "./companion/components/RemoteSession.tsx";
export { PhoneView } from "./components/PhoneView.tsx";
