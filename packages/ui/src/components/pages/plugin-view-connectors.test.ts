import { describe, expect, it } from "vitest";
import { shouldRenderConnectorPluginConfig } from "./plugin-view-connectors";

describe("shouldRenderConnectorPluginConfig", () => {
  it("keeps local connector params visible when a companion setup panel is active", () => {
    expect(
      shouldRenderConnectorPluginConfig({
        hasParams: true,
        isCloudOAuthMode: false,
        isDiscordManagedMode: false,
      }),
    ).toBe(true);
  });

  it("hides local params for cloud-managed connector modes", () => {
    expect(
      shouldRenderConnectorPluginConfig({
        hasParams: true,
        isCloudOAuthMode: true,
        isDiscordManagedMode: false,
      }),
    ).toBe(false);
  });

  it("hides local params for managed Discord mode", () => {
    expect(
      shouldRenderConnectorPluginConfig({
        hasParams: true,
        isCloudOAuthMode: false,
        isDiscordManagedMode: true,
      }),
    ).toBe(false);
  });
});
