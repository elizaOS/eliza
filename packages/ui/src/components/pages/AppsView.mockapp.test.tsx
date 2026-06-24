// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MockAppOptions } from "../../storybook/mock-providers";
import { MockAppProvider } from "../../storybook/mock-providers";
import { AppsView } from "./AppsView";

/**
 * Regression coverage for #9304: the `pages-appsview--*` stories threw
 * "function is not iterable (Symbol.iterator)" at `new Set(favoriteApps)`
 * (AppsView.tsx) because the `mockApp()` store-selector default resolved
 * `s.favoriteApps` to the Proxy's `noop` fallback (a function) instead of the
 * `string[]` the store contract guarantees. The fix defaults `favoriteApps`
 * (and `recentApps`) to real arrays in the mock store. These tests render the
 * real component under the same `MockAppProvider` the `mockApp()` decorator
 * uses, so they fail if that regression returns.
 */

function renderUnderMockApp(value?: MockAppOptions) {
  return render(
    <MockAppProvider value={value}>
      <AppsView />
    </MockAppProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("AppsView under mockApp()", () => {
  it("renders the apps shell without throwing on the default mock store (pages-appsview--default)", () => {
    const { getByTestId } = renderUnderMockApp();
    // The shell renders only if `new Set(favoriteApps)` did not throw on the
    // way down — the function-typed fallback used to crash before this line.
    expect(getByTestId("apps-shell")).not.toBeNull();
    // The catalog grid is the downstream consumer of the `favoriteAppNames`
    // Set; its presence proves the Set was built and passed through.
    expect(getByTestId("apps-catalog-grid")).not.toBeNull();
  });

  it("builds the favorite-names Set from the favoriteApps override and renders the catalog (with-favorites shape)", () => {
    const { getByTestId } = renderUnderMockApp({
      favoriteApps: ["companion", "feed", "wallet"],
      recentApps: ["feed", "companion"],
    });
    // A non-array `favoriteApps` would throw at `new Set(favoriteApps)`; the
    // grid only mounts once that Set is constructed from the real array.
    expect(getByTestId("apps-shell")).not.toBeNull();
    expect(getByTestId("apps-catalog-grid")).not.toBeNull();
  });

  it("renders the games sub-tab branch without throwing (pages-appsview--games-sub-tab)", () => {
    const { getByTestId } = renderUnderMockApp({ appsSubTab: "games" });
    expect(getByTestId("apps-shell")).not.toBeNull();
  });

  it("renders with wallet features enabled without throwing (pages-appsview--wallet-enabled)", () => {
    const { getByTestId } = renderUnderMockApp({ walletEnabled: true });
    expect(getByTestId("apps-shell")).not.toBeNull();
    expect(getByTestId("apps-catalog-grid")).not.toBeNull();
  });
});
