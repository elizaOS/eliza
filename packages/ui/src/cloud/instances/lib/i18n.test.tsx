/** Verifies the Instances i18n shim exposes the shell's CloudI18nProvider translator as a live useT hook. */
// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ensureLanguageLoaded } from "../../../i18n/messages";
import { CloudI18nProvider, useCloudT } from "../../shell/CloudI18nProvider";
import { useT } from "./i18n";

// Stable key bundled in every locale catalog; the en/es strings below are the
// committed values, so a catalog edit that changes them fails loudly here.
const KEY = "accounts.add.apikey.failed";

function providerWrapper({ children }: { children: ReactNode }) {
  return <CloudI18nProvider initialLang="en">{children}</CloudI18nProvider>;
}

describe("instances i18n shim (useT)", () => {
  it("re-exports the shell's useCloudT hook under the useT name", () => {
    expect(useT).toBe(useCloudT);
  });

  it("returns the provider translator for the mounted language", () => {
    const { result } = renderHook(() => useT(), { wrapper: providerWrapper });

    expect(result.current(KEY)).toBe("Failed to add account.");
  });

  it("interpolates vars through the shell translator", () => {
    const { result } = renderHook(() => useT(), { wrapper: providerWrapper });

    expect(result.current("accounts.add.signIn", { provider: "OpenAI" })).toBe(
      "Sign in with OpenAI",
    );
  });

  it("resolves a lazily loaded locale once its catalog is loaded", async () => {
    // Non-English catalogs load on demand; MESSAGES.es is empty until the real
    // loader populates it, and t() would silently fall back to English.
    await ensureLanguageLoaded("es");

    const { result } = renderHook(() => useT(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <CloudI18nProvider initialLang="es">{children}</CloudI18nProvider>
      ),
    });

    expect(result.current(KEY)).toBe("No se pudo agregar la cuenta.");
  });

  it("throws when used outside <CloudI18nProvider>", () => {
    expect(() => renderHook(() => useT())).toThrow(
      "useCloudI18n must be used inside <CloudI18nProvider>",
    );
  });
});
