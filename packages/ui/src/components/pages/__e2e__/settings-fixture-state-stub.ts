/**
 * Fixture stand-in for the `src/state` barrel used by run-settings-e2e.mjs.
 * Supplies the fields SettingsView itself reads (t, loadPlugins,
 * walletEnabled) plus benign defaults for the common fields section bodies
 * select. Authored in CJS form (module.exports) so ANY named import a section
 * pulls from the barrel resolves at runtime (undefined when unlisted) instead
 * of failing the esbuild bundle. Deep `state/*` submodule imports stay real.
 */

import {
  appNameInterpolationVars,
  DEFAULT_BRANDING,
} from "../../../config/branding-base";
import { createTranslator } from "../../../i18n";

declare const module: { exports: unknown };

const t = createTranslator("en", appNameInterpolationVars(DEFAULT_BRANDING));

const fixtureState: Record<string, unknown> = {
  t,
  uiLanguage: "en",
  loadPlugins: async () => {},
  walletEnabled: false,
  plugins: [],
  pluginsLoaded: true,
  elizaCloudConnected: false,
  elizaCloudAuthRejected: false,
  characterData: { name: "Eliza" },
  agentStatus: { agentName: "Eliza", status: "running" },
  uiTheme: "dark",
  setState: () => {},
  setTab: () => {},
  setActionNotice: () => {},
};

const useApp = () => fixtureState;
const useAppSelector = <T,>(sel: (s: Record<string, unknown>) => T): T =>
  sel(fixtureState);
const useAppSelectorShallow = useAppSelector;

// Runtime-resolving export surface: real hooks above, permissive no-op for any
// other named symbol a section imports from the barrel.
const noop = new Proxy(() => noop, { get: () => noop });
module.exports = new Proxy(
  { useApp, useAppSelector, useAppSelectorShallow, __esModule: true },
  {
    get: (target, prop) =>
      prop in target ? (target as Record<PropertyKey, unknown>)[prop] : noop,
  },
);
