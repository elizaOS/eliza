/**
 * Side-effect entry point — registers the Contacts overlay app on ElizaOS only.
 *
 * Stock Android, web, iOS, and desktop get a no-op so the same import is safe
 * everywhere. Non-ElizaOS callers will simply not see Contacts in the apps catalog.
 * Load this module once during app startup to register the app.
 */

import { isElizaOS } from "@elizaos/ui";
import { registerContactsApp } from "./components/contacts-app";

if (isElizaOS()) {
  registerContactsApp();
}
