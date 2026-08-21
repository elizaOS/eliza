/** RFC-compliant Accept-Language qvalues control supported-locale ordering. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/agent", () => ({
  loadElizaConfig: () => ({ ui: { language: "en" } }),
}));

import { resolveSuggestedUiLanguage } from "./i18n-locale-routes";

describe("Accept-Language q integers", () => {
  it("q=1e2 does not beat a real q=0.9 supported language", () => {
    expect(
      resolveSuggestedUiLanguage({
        acceptLanguage: "es;q=1e2,ja;q=0.9",
      }),
    ).toBe("ja");
  });

  it("q=007 does not beat a real q=0.9 supported language", () => {
    expect(
      resolveSuggestedUiLanguage({
        acceptLanguage: "es;q=007,ja;q=0.9",
      }),
    ).toBe("ja");
  });

  it("q=0x10 does not beat a real q=0.9 supported language", () => {
    expect(
      resolveSuggestedUiLanguage({
        acceptLanguage: "es;q=0x10,ja;q=0.9",
      }),
    ).toBe("ja");
  });

  it("canonical q=0.9 still wins over a lower q", () => {
    expect(
      resolveSuggestedUiLanguage({
        acceptLanguage: "es;q=0.9,en;q=0.1",
      }),
    ).toBe("es");
  });

  it.each(["1e-1", ".9", "0.1234", "1.001"])(
    "ignores invalid RFC qvalue %s",
    (q) => {
      expect(
        resolveSuggestedUiLanguage({
          acceptLanguage: `es;q=${q},ja;q=0.8`,
        }),
      ).toBe("ja");
    },
  );
});
