// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { memo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../../api/client";
import { MESSAGES } from "../../i18n";
import { useTranslation } from "../TranslationContext.hooks";
import { TranslationProvider } from "../TranslationProvider";

let renders = 0;
let switchLanguage: ((language: "es") => void) | undefined;

// Memoized like real settings rows: it re-renders only when the translation
// context value changes identity.
const LanguageLabel = memo(function LanguageLabel() {
  const { t, setUiLanguage } = useTranslation();
  switchLanguage = setUiLanguage;
  renders += 1;
  return <span data-testid="label">{t("settings.language")}</span>;
});

beforeEach(() => {
  localStorage.clear();
  // Returning visit with an explicit English choice: no IP-geo suggestion.
  localStorage.setItem("eliza:ui-language", "en");
  renders = 0;
  MESSAGES.es = {};
  vi.spyOn(client, "updateConfig").mockResolvedValue(
    {} as Awaited<ReturnType<typeof client.updateConfig>>,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("TranslationProvider lazy locale load", () => {
  it("re-renders memoized consumers once the selected dictionary loads", async () => {
    const view = render(
      <TranslationProvider>
        <LanguageLabel />
      </TranslationProvider>,
    );
    expect(screen.getByTestId("label").textContent).toBe("Language");

    act(() => switchLanguage?.("es"));
    await waitFor(
      () => expect(screen.getByTestId("label").textContent).toBe("Idioma"),
      { timeout: 60_000 },
    );

    // A parent re-render with unchanged inputs keeps the context value stable.
    const settled = renders;
    view.rerender(
      <TranslationProvider>
        <LanguageLabel />
      </TranslationProvider>,
    );
    expect(renders).toBe(settled);
  });
});
