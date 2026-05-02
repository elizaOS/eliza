/**
 * Side-effect entry point — registers the Contacts overlay app on Android only.
 *
 * Other platforms (web, iOS, desktop) get a no-op so the same import is safe
 * everywhere. Web/iOS callers will simply not see Contacts in the apps catalog.
 *
 *   import "@elizaos/app-contacts/register";
 */

import { registerContactsApp } from "./components/contacts-app";

type CapacitorGlobal = {
  Capacitor?: {
    getPlatform?: () => string;
  };
};

function getCapacitorPlatform(): string | undefined {
  const cap = (globalThis as CapacitorGlobal).Capacitor;
  return cap?.getPlatform?.();
}

if (getCapacitorPlatform() === "android") {
  registerContactsApp();
}
