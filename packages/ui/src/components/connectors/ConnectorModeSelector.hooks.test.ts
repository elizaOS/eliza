/**
 * Unit tests for `useConnectorMode` (`ConnectorModeSelector.hooks.ts`):
 * default-mode seeding, cloud/lens filtering of the available mode list,
 * automatic re-defaulting when a selected mode stops being offered, and the
 * mode -> setup-plugin mapping. Fully deterministic — drives the real
 * connector-mode registry seed data (discord) through the real helpers; no
 * network, no DOM, no module mocks.
 */
// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useConnectorMode } from "./ConnectorModeSelector.hooks";
import { CONNECTOR_PLUGIN_MANAGED_MODE_ID } from "./connector-account-options";

describe("useConnectorMode", () => {
  it("seeds the ranked default and hides cloud-only modes while offline", () => {
    const { result } = renderHook(() => useConnectorMode("discord"));
    expect(result.current.modes.map((mode) => mode.id)).toEqual([
      "local",
      "bot",
    ]);
    expect(result.current.selectedMode).toBe("bot");
    expect(result.current.setupPluginId).toBe("discord");
  });

  it("offers the managed gateway first and defaults to it once cloud connects", () => {
    const { result } = renderHook(() =>
      useConnectorMode("x", { elizaCloudConnected: true }),
    );
    const ids = result.current.modes.map((mode) => mode.id);
    expect(ids[0]).toBe(CONNECTOR_PLUGIN_MANAGED_MODE_ID);
    expect(ids).toContain("oauth");
    expect(ids).toContain("local-oauth");
    expect(ids).toContain("developer");
    expect(result.current.selectedMode).toBe(CONNECTOR_PLUGIN_MANAGED_MODE_ID);
    expect(result.current.setupPluginId).toBe(
      "connector-account-management:x:x",
    );
  });

  it("offers the catalog-backed managed mode even while offline", () => {
    const { result } = renderHook(() => useConnectorMode("x"));
    expect(result.current.modes.map((mode) => mode.id)).toEqual([
      CONNECTOR_PLUGIN_MANAGED_MODE_ID,
      "local-oauth",
      "developer",
    ]);
    expect(result.current.selectedMode).toBe(CONNECTOR_PLUGIN_MANAGED_MODE_ID);
  });

  it("keeps an explicit selection that is still offered", () => {
    const { result } = renderHook(() =>
      useConnectorMode("discord", { elizaCloudConnected: true }),
    );
    act(() => {
      result.current.setSelectedMode("local");
    });
    expect(result.current.selectedMode).toBe("local");
    expect(result.current.setupPluginId).toBe("discordlocal");
  });

  it("re-defaults when the chosen mode is filtered out by a later option change", () => {
    const { result, rerender } = renderHook(
      ({
        connected,
        provisioned,
      }: {
        connected: boolean;
        provisioned: boolean;
      }) =>
        useConnectorMode("discord", {
          elizaCloudConnected: connected,
          cloudProvisioned: provisioned,
        }),
      { initialProps: { connected: true, provisioned: false } },
    );
    act(() => {
      result.current.setSelectedMode("local");
    });
    expect(result.current.selectedMode).toBe("local");
    rerender({ connected: true, provisioned: true });
    expect(result.current.modes.map((mode) => mode.id)).not.toContain("local");
    expect(result.current.selectedMode).not.toBe("local");
  });

  it("filters modes to the active channel-mode lens", () => {
    const { result } = renderHook(() =>
      useConnectorMode("discord", {
        elizaCloudConnected: true,
        channelMode: "delegate",
      }),
    );
    const ids = result.current.modes
      .filter((mode) => mode.id !== CONNECTOR_PLUGIN_MANAGED_MODE_ID)
      .map((mode) => mode.id);
    expect(ids).toEqual(["local"]);
    expect(result.current.selectedMode).toBe("local");
  });

  it("degrades to an empty selection for a connector with no declared modes", () => {
    const { result } = renderHook(() =>
      useConnectorMode("totally-unknown-connector"),
    );
    expect(result.current.modes).toEqual([]);
    expect(result.current.selectedMode).toBe("");
    expect(result.current.setupPluginId).toBeNull();
  });
});
