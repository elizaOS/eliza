/** Verifies the reconciled Cloud selection flags through the package's configured test harness. */
// @vitest-environment jsdom
//
// `isCloudSelected` and `cloudCallsDisabled` used to be derived from config
// alone, so every consumer had to remember to re-qualify them with
// `elizaCloudConnected`; forgetting once is how the Cloud tile came to be
// marked current while local answered every turn (elizaOS/eliza#20045 U1/U2).
// The hook now reconciles at source and exposes config intent separately.

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProviderSelection } from "./useProviderSelection";

vi.mock("../../state", () => ({
  useAppSelectorShallow: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      setActionNotice: vi.fn(),
      handleCloudDisconnect: vi.fn(async () => undefined),
    }),
}));
vi.mock("../../config/branding", () => ({
  useBranding: () => ({ cloudOnly: false }),
}));
vi.mock("../../first-run/mobile-runtime-mode", () => ({
  isElizaCloudRuntimeLocked: () => false,
}));
vi.mock("../../api", () => ({ client: {} }));

function run(elizaCloudConnected: boolean) {
  const { result } = renderHook(() =>
    useProviderSelection(new Set<string>(), vi.fn(), elizaCloudConnected),
  );
  return result;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useProviderSelection — config intent vs serving capability", () => {
  it("keeps Cloud configured but not selected while signed out", () => {
    const result = run(false);
    // Default selection resolves to Cloud (resolvedSelectedId === null).
    expect(result.current.isCloudConfigured).toBe(true);
    // ...but Cloud cannot serve, so it is not the selected serving source.
    expect(result.current.isCloudSelected).toBe(false);
  });

  it("disables cloud calls when Cloud is configured but unreachable", () => {
    // Previously config-only, so it stayed false in exactly the state where
    // Cloud calls cannot be made.
    expect(run(false).current.cloudCallsDisabled).toBe(true);
  });

  it("selects Cloud and enables cloud calls once connected", () => {
    const result = run(true);
    expect(result.current.isCloudConfigured).toBe(true);
    expect(result.current.isCloudSelected).toBe(true);
    expect(result.current.cloudCallsDisabled).toBe(false);
  });

  it("opens the Local panel on first paint while Cloud is unusable", () => {
    expect(run(false).current.visibleProviderPanelId).toBe("__local__");
  });
});
