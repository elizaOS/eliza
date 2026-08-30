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
import { seedAppValue } from "../../../state/app-store";
import { preOpenCloudLoginWindow } from "../../../state/cloud-login-launch";
import {
  ACCENT_PRESETS,
  DEFAULT_BACKGROUND_CONFIG,
} from "../../../state/ui-preferences";

declare const module: { exports: unknown };

const t = createTranslator("en", appNameInterpolationVars(DEFAULT_BRANDING));

const fixtureState: Record<string, unknown> = {
  t,
  uiLanguage: "en",
  setUiLanguage: () => {},
  uiAccentId: "default",
  setUiAccent: () => {},
  homeTimeWidgetHidden: false,
  setHomeTimeWidgetHidden: () => {},
  backgroundConfig: DEFAULT_BACKGROUND_CONFIG,
  setBackgroundConfig: () => {},
  undoBackgroundConfig: () => {},
  redoBackgroundConfig: () => {},
  canUndoBackground: false,
  canRedoBackground: false,
  loadPlugins: async () => {},
  walletEnabled: false,
  // SettingsView gates `cloudOnly` sections on the resolved runtime target.
  // The fixture covers the managed-Cloud surface (the Cloud group and its
  // "Connect Eliza Cloud" handoff), so it must boot as a managed target.
  startupCoordinator: { target: "cloud-managed" },
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
  handleInteractiveCloudLogin: async () => {
    // Mirrors the real interactive entry point: pre-open the named popup,
    // then record whether it is live so the e2e can assert the Settings
    // surface passed a real window into the flow.
    const popup = preOpenCloudLoginWindow();
    document.documentElement.dataset.elizaSettingsCloudLoginPopup = Boolean(
      popup && !popup.closed,
    )
      ? "live"
      : "blocked";
  },
};

const useApp = () => fixtureState;
const useAppSelector = <T,>(sel: (s: Record<string, unknown>) => T): T =>
  sel(fixtureState);
const useAppSelectorShallow = useAppSelector;
const useIsDeveloperMode = () => false;
const useIsPreviewMode = () => false;
const setDeveloperMode = () => {};
const setPreviewMode = () => {};

// Appearance owns a real content-pack hook in production. The browser fixture
// intentionally has no files/URLs to load, but it must still expose the full
// hook contract so the real Appearance section renders all portable controls
// instead of falling into its section error boundary.
const contentPackState = {
  activePack: null,
  loadedPacks: [],
  error: null,
  setError: () => {},
  canPickDirectory: false,
  activate: () => {},
  deactivate: () => {},
  toggle: () => {},
  loadFromUrl: async () => {},
  loadFromFiles: async () => {},
  isSafeContentPackUrl: (value: string) => /^https?:\/\//i.test(value),
};
const useContentPack = () => contentPackState;

// A few section bodies intentionally import the selector store directly rather
// than through the public state barrel. Seed that same production store with
// the fixture value so those sections exercise their real hooks without
// requiring the entire AppProvider shell.
seedAppValue(fixtureState as never);

// Runtime-resolving export surface: real hooks above, permissive no-op for any
// other named symbol a section imports from the barrel.
const noop = new Proxy(() => noop, { get: () => noop });
module.exports = new Proxy(
  {
    ACCENT_PRESETS,
    useApp,
    useAppSelector,
    useAppSelectorShallow,
    useContentPack,
    useIsDeveloperMode,
    useIsPreviewMode,
    setDeveloperMode,
    setPreviewMode,
    __esModule: true,
  },
  {
    get: (target, prop) =>
      prop in target ? (target as Record<PropertyKey, unknown>)[prop] : noop,
  },
);
