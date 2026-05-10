/**
 * Side-effect entry point — registers the Phone overlay app on ElizaOS only.
 *
 * Stock Android, web, iOS, and desktop register a no-op so loading this
 * module never throws on those platforms.
 */

import { isElizaOS } from "@elizaos/ui";
import { registerPhoneApp } from "./components/phone-app";

if (isElizaOS()) {
  registerPhoneApp();
}
