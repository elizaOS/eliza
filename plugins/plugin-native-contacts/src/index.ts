import { registerPlugin } from "@capacitor/core";

import type { ContactsPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.ContactsWeb());

export const Contacts = registerPlugin<ContactsPlugin>("ElizaContacts", {
  web: loadWeb,
});
