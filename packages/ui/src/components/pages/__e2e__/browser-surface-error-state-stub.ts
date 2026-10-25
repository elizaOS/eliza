/**
 * Fixture stand-in for the `src/state` barrel used by
 * run-browser-surface-error-e2e.mjs. BrowserWorkspaceView reads
 * `{ getStewardPending, getStewardStatus, setActionNotice, t, plugins,
 * uiTheme, walletAddresses, walletConfig }` through the selector hooks;
 * supplying them from a plain object keeps the browser bundle free of the full
 * app store while the component under test stays real. The real English
 * translator is used so the error-card copy renders exactly as in the app.
 */

import {
  appNameInterpolationVars,
  DEFAULT_BRANDING,
} from "../../../config/branding-base";
import { createTranslator } from "../../../i18n";

const t = createTranslator("en", appNameInterpolationVars(DEFAULT_BRANDING));

const fixtureState: Record<string, unknown> = {
  t,
  getStewardPending: async () => [],
  getStewardStatus: async () => null,
  setActionNotice: () => {},
  plugins: [],
  uiTheme: "dark",
  walletAddresses: [],
  walletConfig: null,
};

export function useApp(): Record<string, unknown> {
  return fixtureState;
}

export function useAppSelector<T>(
  selector: (state: Record<string, unknown>) => T,
): T {
  return selector(fixtureState);
}

export function useAppSelectorShallow<T>(
  selector: (state: Record<string, unknown>) => T,
): T {
  return selector(fixtureState);
}
