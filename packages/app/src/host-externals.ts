/**
 * Host-external importers this app build contributes to `DynamicViewLoader`.
 *
 * `DynamicViewLoader`'s trunk map (in `@elizaos/ui`) is framework-only. Plugin
 * view bundles resolve native bridges and browser helpers through explicit
 * imports registered by the app. Runtime-only plugin barrels are not exposed
 * to browser views.
 *
 * Registration runs synchronously at renderer module-eval (imported at the top
 * of `main.tsx`), before any view can navigate, so the importer is always in
 * the registry by the time a view bundle resolves its externals.
 *
 * Native bridge thunks use literal imports so the bundler emits resolvable
 * browser chunks while preserving the host singleton.
 *
 * The view-bundle import guard (`packages/scripts/view-bundle-import-guard.ts`)
 * scans this file's `registerHostExternalImporter("<specifier>", …)` calls, so
 * a specifier registered here is treated as loadable when validating built view
 * bundles. Add new host-external plugin specifiers here (or self-register from
 * the owning plugin's `register.ts`, adding it to the guard's scan set).
 */

import { registerHostExternalImporter } from "@elizaos/ui/app-shell-registry";

let registered = false;

export function registerAppHostExternalImporters(): void {
  if (registered) return;
  registered = true;

  registerHostExternalImporter(
    "@elizaos/plugin-native-contacts/bridge",
    () => import("@elizaos/plugin-native-contacts/bridge"),
  );
  registerHostExternalImporter(
    "@elizaos/plugin-native-messages/bridge",
    () => import("@elizaos/plugin-native-messages/bridge"),
  );
  registerHostExternalImporter(
    "@elizaos/capacitor-mobile-signals",
    () => import("@elizaos/capacitor-mobile-signals"),
  );
  registerHostExternalImporter(
    "@elizaos/plugin-native-phone/bridge",
    () => import("@elizaos/plugin-native-phone/bridge"),
  );
  registerHostExternalImporter(
    "@elizaos/capacitor-system",
    () => import("@elizaos/capacitor-system"),
  );

  registerHostExternalImporter(
    "@elizaos/plugin-health/screen-time/mobile-signal-setup",
    () => import("@elizaos/plugin-health/screen-time/mobile-signal-setup"),
  );
}
