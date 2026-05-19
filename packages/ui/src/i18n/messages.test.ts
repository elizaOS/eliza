import { describe, expect, it } from "vitest";
import { ensureLanguageLoaded, MESSAGES, UI_LANGUAGES } from "./messages";

const STARTUP_SHELL_KEYS = [
  "startupshell.Starting",
  "startupshell.ConnectingBackend",
  "startupshell.InitializingAgent",
  "startupshell.Loading",
] as const;

describe("i18n messages", () => {
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
