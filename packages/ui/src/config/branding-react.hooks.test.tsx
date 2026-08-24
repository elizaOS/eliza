/**
 * Unit coverage for the React branding surface: `BrandingContext` defaults and
 * the `useBranding()` fallback contract. Real React rendering via
 * @testing-library/react under jsdom — no mocks.
 */
// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { type PropsWithChildren, useContext } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { type BrandingConfig, DEFAULT_BRANDING } from "./branding-base";
import { BrandingContext, useBranding } from "./branding-react.hooks";

afterEach(() => {
  cleanup();
});

function makeBranding(overrides: Partial<BrandingConfig>): BrandingConfig {
  return {
    ...DEFAULT_BRANDING,
    ...overrides,
    appName: overrides.appName ?? "TestApp",
  };
}

describe("useBranding", () => {
  it("falls back to the module-level DEFAULT_BRANDING object when no provider is mounted", () => {
    const { result } = renderHook(() => useBranding());

    // Reference identity: the `??` branch hands back the imported constant
    // itself, so consumers share one frozen default rather than copies.
    expect(result.current).toBe(DEFAULT_BRANDING);
    expect(result.current.appName).toBe("Eliza");
  });

  it("returns the provider value by reference when a provider is mounted", () => {
    const provided = makeBranding({ hashtag: "#TestAgent" });

    const { result } = renderHook(() => useBranding(), {
      wrapper: ({ children }: PropsWithChildren) => (
        <BrandingContext.Provider value={provided}>
          {children}
        </BrandingContext.Provider>
      ),
    });

    expect(result.current).toBe(provided);
    expect(result.current.hashtag).toBe("#TestAgent");
  });

  it("prefers a non-default provider value over DEFAULT_BRANDING", () => {
    const provided = makeBranding({
      orgName: "acme",
      repoName: "fork",
      docsUrl: "https://docs.acme.example",
      cloudOnly: true,
    });

    const { result } = renderHook(() => useBranding(), {
      wrapper: ({ children }: PropsWithChildren) => (
        <BrandingContext.Provider value={provided}>
          {children}
        </BrandingContext.Provider>
      ),
    });

    expect(result.current.orgName).toBe("acme");
    expect(result.current.repoName).toBe("fork");
    expect(result.current.docsUrl).toBe("https://docs.acme.example");
    expect(result.current.cloudOnly).toBe(true);
  });

  it("tracks provider value changes across rerenders", () => {
    const first = makeBranding({ fileExtension: ".first-agent" });
    const second = makeBranding({ fileExtension: ".second-agent" });
    let provided = first;
    const { result, rerender } = renderHook(() => useBranding(), {
      wrapper: ({ children }: PropsWithChildren) => (
        <BrandingContext.Provider value={provided}>
          {children}
        </BrandingContext.Provider>
      ),
    });

    expect(result.current).toBe(first);
    expect(result.current.fileExtension).toBe(".first-agent");

    provided = second;
    rerender();

    expect(result.current).toBe(second);
    expect(result.current.fileExtension).toBe(".second-agent");
  });

  it("resolves through the innermost of nested providers", () => {
    const outer = makeBranding({ packageScope: "outer" });
    const inner = makeBranding({ packageScope: "inner" });

    const { result } = renderHook(() => useBranding(), {
      wrapper: ({ children }: PropsWithChildren) => (
        <BrandingContext.Provider value={outer}>
          <BrandingContext.Provider value={inner}>
            {children}
          </BrandingContext.Provider>
        </BrandingContext.Provider>
      ),
    });

    expect(result.current.packageScope).toBe("inner");
  });
});

describe("BrandingContext", () => {
  it("defaults to undefined so useBranding's fallback branch is what serves DEFAULT_BRANDING", () => {
    const { result } = renderHook(() => useContext(BrandingContext));

    expect(result.current).toBeUndefined();
  });
});
