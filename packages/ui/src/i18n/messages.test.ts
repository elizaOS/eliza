/**
 * Unit coverage asserting the startup-shell keys exist across the loaded
 * language catalogs. Pure data, no runtime.
 */
import { describe, expect, it } from "vitest";
import englishMessages from "./locales/en.json" with { type: "json" };
import { ensureLanguageLoaded, MESSAGES, UI_LANGUAGES } from "./messages";

const STARTUP_SHELL_KEYS = [
  "startupshell.Starting",
  "startupshell.ConnectingBackend",
  "startupshell.InitializingAgent",
  "startupshell.Loading",
] as const;

const PERMISSION_PRIMING_RECOVERY_MESSAGES = {
  "permissionpriming.recheck": "Re-check",
  "permissionpriming.recheckFailedDescription":
    "Eliza couldn’t re-check the system setting. Try again, or open Settings and confirm it is enabled.",
  "permissionpriming.recheckFailedTitle": "Couldn’t verify permission",
  "permissionpriming.requestFailedDescription":
    "The system request failed. Try again, or open Settings and re-check.",
  "permissionpriming.requestFailedTitle": "Couldn’t request permission",
  "permissionpriming.openingSettings": "Opening…",
  "permissionpriming.settingsOpenFailed":
    "Couldn’t open Settings. Open System Settings manually, then re-check.",
} as const;

describe("i18n messages", () => {
  it("keeps permission recovery copy in the English locale", () => {
    expect(englishMessages).toMatchObject(PERMISSION_PRIMING_RECOVERY_MESSAGES);
  });

  it("has translated startup shell phase labels for every supported language", async () => {
    for (const language of UI_LANGUAGES) {
      // Non-`en` dictionaries are lazy-loaded; await before asserting.
      await ensureLanguageLoaded(language);
      for (const key of STARTUP_SHELL_KEYS) {
        expect(MESSAGES[language][key], `${language}:${key}`).toEqual(
          expect.any(String),
        );
        expect(MESSAGES[language][key].trim()).not.toBe("");
      }
    }
  });
});
