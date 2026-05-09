/**
 * Side-effect entry point — registers the Phone overlay app on ElizaOS only.
 *
 * Stock Android, web, iOS, and desktop register a no-op so importing
 * `@elizaos/app-phone/register` never throws on those platforms.
 *
 * Usage:
 *   import "@elizaos/app-phone/register";
 */

import { isElizaOS } from "@elizaos/ui";
import { registerPhoneApp } from "./components/phone-app";

if (isElizaOS()) {
  registerPhoneApp();
}
