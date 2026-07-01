/**
 * Fixture stand-in for the `src/state` barrel used by run-connectors-e2e.mjs.
 * The connectors card only reads `{ t, elizaCloudConnected, setActionNotice,
 * setState, setTab }` through the selector hooks; supplying them from a plain
 * object keeps the browser bundle free of the full app store while every
 * component under test stays real.
 */

import {
  appNameInterpolationVars,
  DEFAULT_BRANDING,
} from "../../../config/branding-base";
import { createTranslator } from "../../../i18n";

const t = createTranslator("en", appNameInterpolationVars(DEFAULT_BRANDING));

const fixtureState: Record<string, unknown> = {
  t,
  elizaCloudConnected: false,
  setActionNotice: () => {},
  setState: () => {},
  setTab: () => {},
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
