import { registerPlugin } from "@capacitor/core";
import type { MobileAgentBridgePlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.MobileAgentBridgeWeb());

/**
 * Capacitor plugin entry point. The native bindings on iOS and Android
 * register themselves under the name `MobileAgentBridge`; the web
 * fallback loads on dev / Electrobun shells where no phone tunnel is
 * possible.
 */
export const MobileAgentBridge = registerPlugin<MobileAgentBridgePlugin>("MobileAgentBridge", {
  web: loadWeb,
});
