/**
 * Entry point registering the `ElizaContacts` Capacitor plugin — the JS
 * bridge to Android's `ContactsContract` (list/create/import contacts) —
 * with `ContactsWeb` lazily loaded as the web fallback; re-exports the
 * shared types from `./definitions`.
 */
import { registerPlugin } from "@capacitor/core";

import type { ContactsPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.ContactsWeb());

export const Contacts = registerPlugin<ContactsPlugin>("ElizaContacts", {
  web: loadWeb,
});
