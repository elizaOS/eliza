/** Verifies useShellAuthGate against the shared auth snapshot. */
// @vitest-environment jsdom
//
// Thin React binding over deriveShellAuthGate. Real hook; branding and the
// auth snapshot are injected through their public test/context seams.

import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { BrandingConfig } from "../../../config/branding-base";
import { DEFAULT_BRANDING } from "../../../config/branding-base";
import { BrandingContext } from "../../../config/branding-react.hooks";
import {
  __resetAuthStatusForTests,
  __setAuthStatusForTests,
} from "../../../hooks/useAuthStatus";
import { useShellAuthGate } from "../useShellAuthGate";

function wrapperFor(cloudOnly: boolean) {
  const branding: BrandingConfig = { ...DEFAULT_BRANDING, cloudOnly };
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <BrandingContext.Provider value={branding}>
        {children}
      </BrandingContext.Provider>
    );
  };
}

afterEach(() => {
  cleanup();
  __resetAuthStatusForTests();
});

describe("useShellAuthGate", () => {
  it("stays clear on a local-runtime build even when the snapshot is unauthenticated", () => {
    __setAuthStatusForTests({ phase: "unauthenticated" });
    const { result } = renderHook(() => useShellAuthGate(), {
      wrapper: wrapperFor(false),
    });
    expect(result.current).toEqual({ gated: false, phase: "clear" });
  });

  it("gates a cloud-only unauthenticated snapshot as needs-auth", () => {
    __setAuthStatusForTests({ phase: "unauthenticated" });
    const { result } = renderHook(() => useShellAuthGate(), {
      wrapper: wrapperFor(true),
    });
    expect(result.current).toEqual({ gated: true, phase: "needs-auth" });
  });
});
