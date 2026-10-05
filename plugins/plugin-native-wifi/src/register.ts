import { isElizaOS } from "@elizaos/ui";
import { registerWifiApp } from "./components/wifi-app";

export function registerApp(): void {
  if (isElizaOS()) {
    registerWifiApp();
  }
}
