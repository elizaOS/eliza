/**
 * Unit coverage asserting required interface copy exists in the canonical
 * English catalog and startup-shell keys exist across all loaded catalogs.
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

const PASSKEY_ENROLLMENT_RECOVERY_MESSAGES = {
  "cloud.login.otp.recoveryLabel": "Other passkey options",
  "cloud.login.otp.recoveryMessage":
    "Already saved this passkey? Sign in with it, or use a Magic Link.",
} as const;

describe("i18n messages", () => {
  it("keeps passkey enrollment recovery copy in the English locale", () => {
    expect(englishMessages).toMatchObject(PASSKEY_ENROLLMENT_RECOVERY_MESSAGES);
  });

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
