/**
 * Side-effect entry point — registers the Contacts overlay app on MiladyOS only.
 *
 * Stock Android, web, iOS, and desktop get a no-op so the same import is safe
 * everywhere. Non-MiladyOS callers will simply not see Contacts in the apps catalog.
 *
 *   import "@elizaos/app-contacts/register";
 */

import { isMiladyOS } from "@elizaos/app-core";
import { registerContactsApp } from "./components/contacts-app";

if (isMiladyOS()) {
  registerContactsApp();
}
