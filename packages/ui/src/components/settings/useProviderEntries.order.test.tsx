// @vitest-environment jsdom

/**
 * Pins useProviderEntries' provider ordering by platform: on mobile the local
 * provider sits right after cloud (before subscriptions); on desktop/web it
 * comes after the subscription providers. renderHook with the platform guard
 * mocked.
 */

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProviderEntries } from "./useProviderEntries";

const platform = vi.hoisted(() => ({ value: "web" as string }));
vi.mock("../../platform/platform-guards", () => ({
  getFrontendPlatform: () => platform.value,
}));

function run() {
  const { result } = renderHook(() =>
    useProviderEntries({
      allAiProviders: [],
      elizaCloudConnected: false,
      cloudCallsDisabled: false,
      isCloudSelected: true,
      resolvedSelectedId: null,
      subscriptionStatus: [],
      anthropicCliDetected: false,
      t: (key: string, vars?: Record<string, unknown>) =>
        (vars?.defaultValue as string) ?? key,
    }),
  );
  return result.current.providerEntries.map((e) => e.id);
}

describe("useProviderEntries provider ordering", () => {
  afterEach(() => {
    platform.value = "web";
  });

  it("on mobile surfaces the local provider right after cloud (before subscriptions)", () => {
    platform.value = "ios";
    const ids = run();
    expect(ids[0]).toBe("__cloud__");
    expect(ids[1]).toBe("__local__");
    // local must come before any subscription/key entry on mobile
    const firstSub = ids.findIndex(
      (id) => id !== "__cloud__" && id !== "__local__",
    );
    expect(ids.indexOf("__local__")).toBeLessThan(firstSub);
  });

  it("on desktop/web keeps the local provider after the subscription providers", () => {
    platform.value = "web";
    const ids = run();
    expect(ids[0]).toBe("__cloud__");
    expect(ids[1]).not.toBe("__local__");
    // a subscription entry precedes the local provider on desktop/web
    expect(ids.indexOf("__local__")).toBeGreaterThan(1);
  });
});
