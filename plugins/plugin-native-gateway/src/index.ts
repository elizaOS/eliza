/**
 * Capacitor registration entry point for the `Gateway` plugin, exposing a
 * single cross-platform `Gateway` object backed by web (`web.ts`), iOS
 * (Swift), and Android (Kotlin) implementations. The web implementation is
 * dynamically imported so native builds don't pull in browser WebSocket code.
 */
import { registerPlugin } from "@capacitor/core";
import type { GatewayPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.GatewayWeb());

export const Gateway = registerPlugin<GatewayPlugin>("Gateway", {
  web: loadWeb,
});
