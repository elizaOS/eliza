/**
 * Phone Companion surface — three-view Capacitor app that pairs with a desktop
 * Eliza agent (QR handshake), mirrors chat, and serves as the remote-session
 * viewer for the paired Mac.
 *
 * Mounted at the root of the app shell when the host bundle runs in
 * companion mode (e.g. the iOS Capacitor build with `?mode=companion`).
 */

export { Chat } from "./components/Chat";
export { Pairing } from "./components/Pairing";
export { PhoneCompanionApp } from "./components/PhoneCompanionApp";
export { RemoteSession } from "./components/RemoteSession";
export * from "./services";
