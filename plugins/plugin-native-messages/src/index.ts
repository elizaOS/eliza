import { registerPlugin } from "@capacitor/core";

import type { MessagesPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.MessagesWeb());

export const Messages = registerPlugin<MessagesPlugin>("ElizaMessages", {
  web: loadWeb,
});
