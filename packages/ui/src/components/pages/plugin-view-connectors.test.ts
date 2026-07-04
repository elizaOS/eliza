/**
 * Unit tests for `shouldRenderConnectorPluginConfig` — the pure predicate that
 * decides whether a connector's local config params render alongside a companion
 * setup panel in `PluginsView`.
 */
import { describe, expect, it } from "vitest";
import { shouldRenderConnectorPluginConfig } from "./plugin-view-connectors";

describe("shouldRenderConnectorPluginConfig", () => {
  it("keeps local connector params visible when a companion setup panel is active", () => {
    expect(
      shouldRenderConnectorPluginConfig({
        hasParams: true,
        isCloudOAuthMode: false,
        isManagedAgentGatewayMode: false,
      }),
    ).toBe(true);
  });

  it("hides local params for cloud-managed connector modes", () => {
    expect(
      shouldRenderConnectorPluginConfig({
        hasParams: true,
        isCloudOAuthMode: true,
        isManagedAgentGatewayMode: false,
      }),
    ).toBe(false);
  });

  it("hides local params for managed agent gateway mode", () => {
    expect(
      shouldRenderConnectorPluginConfig({
        hasParams: true,
        isCloudOAuthMode: false,
        isManagedAgentGatewayMode: true,
      }),
    ).toBe(false);
  });

  it("hides the config form when both managed-mode exclusions apply", () => {
    expect(
      shouldRenderConnectorPluginConfig({
        hasParams: true,
        isCloudOAuthMode: true,
        isManagedAgentGatewayMode: true,
      }),
    ).toBe(false);
  });

  it("renders nothing when the plugin exposes no params, regardless of mode", () => {
    for (const isCloudOAuthMode of [false, true]) {
      for (const isManagedAgentGatewayMode of [false, true]) {
        expect(
          shouldRenderConnectorPluginConfig({
            hasParams: false,
            isCloudOAuthMode,
            isManagedAgentGatewayMode,
          }),
        ).toBe(false);
      }
    }
  });
});
