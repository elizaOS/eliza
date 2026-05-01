/**
 * Side-effect entry point — registers the Phone overlay app on Android only.
 *
 * Web and iOS register a no-op so importing `@elizaos/app-phone/register`
 * never throws on those platforms.
 *
 * Usage:
 *   import "@elizaos/app-phone/register";
 */

import { Capacitor } from "@capacitor/core";
import { registerPhoneApp } from "./components/phone-app";

if (Capacitor.getPlatform() === "android") {
  registerPhoneApp();
}
