/**
 * Pins the Cloud tile's current/status behavior when cloud-proxy is
 * configured but the user is not signed in — the dishonest "current +
 * Available" state fixed in elizaOS/eliza#20045. Deterministic jsdom harness.
 */
// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProviderEntries } from "./useProviderEntries";

const platform = vi.hoisted(() => ({ value: "web" as string }));
vi.mock("../../platform/platform-guards", () => ({
  getFrontendPlatform: () => platform.value,
}));

function runEntry(
  overrides: Partial<{
    elizaCloudConnected: boolean;
    cloudCallsDisabled: boolean;
    isCloudSelected: boolean;
  }>,
) {
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
      ...overrides,
    }),
  );
  const cloud = result.current.providerEntries.find(
    (e) => e.id === "__cloud__",
  );
  if (!cloud) throw new Error("cloud entry missing");
  return cloud;
}

describe("useProviderEntries — cloud configured but not signed in (#20045)", () => {
  afterEach(() => {
    platform.value = "web";
  });

  it("marks Cloud current when connected and selected", () => {
    const cloud = runEntry({
      elizaCloudConnected: true,
      isCloudSelected: true,
      cloudCallsDisabled: false,
    });
    expect(cloud.current).toBe(true);
    expect(cloud.status).toEqual({ tone: "ok", label: "Connected" });
  });

  it("does NOT mark Cloud current when configured but not signed in", () => {
    const cloud = runEntry({
      elizaCloudConnected: false,
      isCloudSelected: true,
      cloudCallsDisabled: false,
    });
    expect(cloud.current).toBe(false);
  });

  it("shows 'Not signed in' warning when configured but disconnected", () => {
    const cloud = runEntry({
      elizaCloudConnected: false,
      isCloudSelected: true,
      cloudCallsDisabled: false,
    });
    expect(cloud.status).toEqual({ tone: "warn", label: "Not signed in" });
  });

  it("shows 'Available' when not configured and not connected", () => {
    const cloud = runEntry({
      elizaCloudConnected: false,
      isCloudSelected: false,
      cloudCallsDisabled: true,
    });
    expect(cloud.status).toEqual({ tone: "muted", label: "Available" });
    expect(cloud.current).toBe(false);
  });
});
