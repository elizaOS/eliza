/**
 * Chooses the renderer boot boundary before the full application module graph
 * evaluates. Hosted public routes load their dedicated shell; every native,
 * desktop, harness, and agent-app route retains the established main entry.
 */

import {
  shouldUseMarketingHomeEntry,
  shouldUsePublicWebEntry,
} from "./web-entry-policy";

declare const __ELIZA_WEB_SHELL__: boolean | undefined;
declare const __ELIZA_CHAT_UI_HARNESS__: boolean | undefined;

type ShellWindow = Window & {
  __electrobunWindowId?: number;
  __electrobunWebviewId?: number;
  __ELIZA_ELECTROBUN_RPC__?: unknown;
};

function hasDesktopShellMarker(): boolean {
  const runtimeWindow = window as ShellWindow;
  return (
    typeof runtimeWindow.__electrobunWindowId === "number" ||
    typeof runtimeWindow.__electrobunWebviewId === "number" ||
    runtimeWindow.__ELIZA_ELECTROBUN_RPC__ !== undefined
  );
}

const entryDecisionInput = {
  pathname: window.location.pathname,
  hostname: window.location.hostname,
  webShellEnabled: __ELIZA_WEB_SHELL__ === true,
  chatHarnessEnabled: __ELIZA_CHAT_UI_HARNESS__ === true,
  desktopShell: hasDesktopShellMarker(),
  forceApexConsole:
    import.meta.env?.DEV === true &&
    import.meta.env?.VITE_FORCE_APEX_CONSOLE === "true",
  forceMarketingHome:
    import.meta.env?.DEV === true &&
    import.meta.env?.VITE_FORCE_MARKETING_HOME === "true",
};

const useMarketingHomeEntry = shouldUseMarketingHomeEntry(entryDecisionInput);
const usePublicEntry = shouldUsePublicWebEntry(entryDecisionInput);

const rendererEntry = useMarketingHomeEntry
  ? import("./marketing-home-entry")
  : usePublicEntry
    ? import("./public-web-entry")
    : import("./main");

// error-policy:J1 renderer-entry boundary — import failures render the same
// actionable reload card as failures inside the established main boot.
void rendererEntry.catch(async (error) => {
  const { renderBootFailure } = await import("./boot-failure");
  renderBootFailure(error);
});
