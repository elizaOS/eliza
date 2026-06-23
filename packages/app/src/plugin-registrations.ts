export type SideEffectAppModuleLoader = {
  key: string;
  load: () => Promise<unknown>;
};

/**
 * Renderer side-effect app modules — plugins imported at app boot purely to
 * register UI surfaces/pages (route handlers + runtime services stay
 * server-side).
 *
 * The list is NOT hardcoded here. Each app plugin self-declares
 * `"elizaos": { "appRegister": "register" | "ui" }` in its own package.json, and
 * the renderer build scans for that marker (see
 * `vite/app-side-effect-modules.ts`, wired in `vite.config.ts`) to generate this
 * list. Adding or deleting a plugin directory updates the boot set
 * automatically — there is no app-side list to keep in sync.
 */
export { SIDE_EFFECT_APP_MODULE_LOADERS } from "virtual:eliza-side-effect-app-modules";
