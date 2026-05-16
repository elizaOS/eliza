import { registerPlugin } from "@capacitor/core";

import type { WiFiPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.WiFiWeb());

export const WiFi = registerPlugin<WiFiPlugin>("ElizaWiFi", {
  web: loadWeb,
});
