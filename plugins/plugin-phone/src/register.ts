/**
 * Side-effect entry point for bundled phone surfaces.
 *
 * The Phone Companion is an app-shell page and must register on every host
 * where the app shell can route to `/phone-companion`. The Android overlay app
 * still only registers on ElizaOS.
 */

import { isElizaOS } from "@elizaos/ui";
import { registerPhoneApp } from "./components/phone-app";
import "./register-companion-page";

if (isElizaOS()) {
  registerPhoneApp();
}
