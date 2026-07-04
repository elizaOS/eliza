/**
 * Declares the side-effect app-module loader list the renderer runs at boot. The
 * `SideEffectAppModuleLoader` type below pairs a stable key with a lazy
 * `import()`; the exported array is a build-time seam populated by vite (see its
 * own doc for the plugin-discovery mechanism).
 */
export type SideEffectAppModuleLoader = {
  key: string;
  load: () => Promise<unknown>;
};

/**
 * Renderer side-effect app modules — plugins imported at app boot purely to
 * register UI surfaces/pages (route handlers + runtime services stay
 * server-side).
 *
 * The list is NOT hardcoded. Each app plugin self-declares
 * `"elizaos": { "appRegister": "register" | "ui" }` in its own package.json; the
 * renderer build scans for that marker and rewrites the array literal below with
 * the discovered loaders (see `appSideEffectModulesPlugin` in
 * `vite/app-side-effect-modules.ts`, wired in `vite.config.ts`). Adding or
 * deleting a plugin directory updates the boot set automatically — there is no
 * app-side list to keep in sync.
 *
 * The empty default is the fallback when the build transform has not run (e.g. a
 * raw, non-vite import). The app shell always loads through vite, so the array
 * is populated at boot.
 */
export const SIDE_EFFECT_APP_MODULE_LOADERS: readonly SideEffectAppModuleLoader[] =
  /* @__ELIZA_APP_REGISTER_LOADERS__ */ [];
