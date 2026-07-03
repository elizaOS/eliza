/**
 * Host-external importers this app build contributes to `DynamicViewLoader`.
 *
 * `DynamicViewLoader`'s trunk map (in `@elizaos/ui`) is framework-only. Plugin
 * view bundles that import a plugin package (e.g. the training view importing
 * `@elizaos/plugin-training`, or the health/finances views importing
 * `@elizaos/plugin-browser`) leave that specifier external and rely on the host
 * shell to resolve it to the host realm's singleton. This module — the app
 * (build-variant) entrypoint — registers those plugin-owned specifiers so the
 * shared UI package never has to name them.
 *
 * Registration runs synchronously at renderer module-eval (imported at the top
 * of `main.tsx`), before any view can navigate, so the importer is always in
 * the registry by the time a view bundle resolves its externals.
 *
 * Each thunk keeps the exact runtime shape the trunk map used: a `@vite-ignore`
 * bare-specifier dynamic import resolved against the host realm, so no plugin
 * package is pulled into the app's static graph.
 *
 * The view-bundle import guard (`packages/scripts/view-bundle-import-guard.mjs`)
 * scans this file's `registerHostExternalImporter("<specifier>", …)` calls, so
 * a specifier registered here is treated as loadable when validating built view
 * bundles. Add new host-external plugin specifiers here (or self-register from
 * the owning plugin's `register.ts`, adding it to the guard's scan set).
 */

import { registerHostExternalImporter } from "@elizaos/ui/app-shell-registry";

function importHostExternal(
  specifier: string,
): Promise<Record<string, unknown>> {
  return import(/* @vite-ignore */ specifier) as Promise<
    Record<string, unknown>
  >;
}

let registered = false;

export function registerAppHostExternalImporters(): void {
  if (registered) return;
  registered = true;

  registerHostExternalImporter("@elizaos/plugin-browser", () =>
    importHostExternal("@elizaos/plugin-browser"),
  );
  registerHostExternalImporter("@elizaos/plugin-training", () =>
    importHostExternal("@elizaos/plugin-training"),
  );
  registerHostExternalImporter(
    "@elizaos/plugin-health/screen-time/mobile-signal-setup",
    () =>
      importHostExternal(
        "@elizaos/plugin-health/screen-time/mobile-signal-setup",
      ),
  );
}
