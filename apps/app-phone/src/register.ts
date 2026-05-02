/**
 * Side-effect entry point — registers the Phone overlay app on MiladyOS only.
 *
 * Stock Android, web, iOS, and desktop register a no-op so importing
 * `@elizaos/app-phone/register` never throws on those platforms.
 *
 * Usage:
 *   import "@elizaos/app-phone/register";
 */

import { isMiladyOS } from "@elizaos/app-core";
import { registerPhoneApp } from "./components/phone-app";

if (isMiladyOS()) {
  registerPhoneApp();
}
