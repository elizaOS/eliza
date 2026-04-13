import { registerPlugin } from "@capacitor/core";
import type { GatewayPlugin } from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.GatewayWeb());

export const Gateway = registerPlugin<GatewayPlugin>("Gateway", {
  web: loadWeb,
});
