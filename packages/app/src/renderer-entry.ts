/**
 * Chooses the renderer boot boundary before the full application module graph
 * evaluates. Hosted public routes load their dedicated shell; every native,
 * harness, and agent-app route retains the established main entry.
 */

import { renderBootFailure } from "./boot-failure";
import { shouldUsePublicWebEntry } from "./web-entry-policy";

declare const __ELIZA_WEB_SHELL__: boolean | undefined;
declare const __ELIZA_PUBLIC_WEB_ENTRY__: boolean | undefined;
declare const __ELIZA_CHAT_UI_HARNESS__: boolean | undefined;

const entryDecisionInput = {
  pathname: window.location.pathname,
  hostname: window.location.hostname,
  webShellEnabled: __ELIZA_WEB_SHELL__ === true,
  chatHarnessEnabled: __ELIZA_CHAT_UI_HARNESS__ === true,
  forceApexConsole:
    import.meta.env?.DEV === true &&
    import.meta.env?.VITE_FORCE_APEX_CONSOLE === "true",
};

const usePublicEntry =
  __ELIZA_PUBLIC_WEB_ENTRY__ === true &&
  shouldUsePublicWebEntry(entryDecisionInput);

// error-policy:J1 renderer-entry boundary — import failures render the same
// actionable reload card as failures inside the established main boot.
// Separate import callbacks let Vite attach each renderer's CSS dependencies.
// A conditional import callback can collapse those lists to shared CSS only.
if (usePublicEntry) {
  void import("./public-web-entry").catch(renderBootFailure);
} else {
  void import("./main").catch(renderBootFailure);
}
