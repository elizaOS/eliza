/**
 * Fixture stand-in for the `packages/ui/src/state` barrel used by
 * run-accounts-ui-e2e.mjs (mirrors the connectors __e2e__ state stub).
 *
 * The accounts surface only reads `s.t` through the selector hooks. Supplying
 * the real translator from a plain object keeps the browser bundle free of the
 * full app store while every component under test — AccountList, AccountCard,
 * AddAccountDialog, RotationStrategyPicker, EditableAccountLabel, useAccounts,
 * and the REAL ElizaClient network layer — stays real.
 */

import {
  appNameInterpolationVars,
  DEFAULT_BRANDING,
} from "../../../ui/src/config/branding-base";
import { createTranslator } from "../../../ui/src/i18n";

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
