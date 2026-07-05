/**
 * `@elizaos/capacitor-messages` — Android SMS bridge (`SmsManager` send,
 * `content://sms` read). Registers as `ElizaMessages` on the Capacitor
 * bridge; the web fallback (`./web`) is loaded lazily since it is only ever
 * needed on non-Android platforms.
 */

import { registerPlugin } from "@capacitor/core";

import type { MessagesPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.MessagesWeb());

export const Messages = registerPlugin<MessagesPlugin>("ElizaMessages", {
  web: loadWeb,
});
