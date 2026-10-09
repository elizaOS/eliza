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
  createTranslator,
  DEFAULT_BRANDING,
} from "@elizaos/ui";

// The public UI barrel also imports state consumers. Defer reading its exports
// until rendering, after the barrel has completed module initialization.
let translator: ReturnType<typeof createTranslator> | undefined;
const t: ReturnType<typeof createTranslator> = (...args) => {
  translator ??= createTranslator(
    "en",
    appNameInterpolationVars(DEFAULT_BRANDING),
  );
  return translator(...args);
};

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

// This isolated surface has no shell notice sink; use the viewport fallback.
export function getActionNoticeSink(): null {
  return null;
}
