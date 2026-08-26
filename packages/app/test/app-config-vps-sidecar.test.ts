import { describe, expect, it } from "vitest";
import { resolveAppConfig } from "../app.config";

describe("VPS sidecar app identity", () => {
  it("preserves the canonical app identity by default", () => {
    const config = resolveAppConfig({ ELIZA_ANDROID_VPS_SIDECAR: undefined });

    expect(config).toMatchObject({
      appName: "Eliza",
      appId: "ai.elizaos.app",
      namespace: "eliza",
      desktop: {
        bundleId: "ai.elizaos.app",
        urlScheme: "elizaos",
      },
      web: { shortName: "Eliza" },
      branding: { appName: "Eliza" },
    });
    expect(config.web).not.toHaveProperty("iconBackgroundColor");
  });

  it("uses a separately installable identity only for the explicit sidecar lane", () => {
    const config = resolveAppConfig({ ELIZA_ANDROID_VPS_SIDECAR: "1" });

    expect(config).toMatchObject({
      appName: "Eliza VPS",
      appId: "ai.elizaos.app.vps",
      namespace: "eliza-vps",
      desktop: {
        bundleId: "ai.elizaos.app.vps",
        urlScheme: "elizavps",
      },
      web: {
        shortName: "Eliza VPS",
        iconBackgroundColor: "#202124",
      },
      branding: { appName: "Eliza VPS" },
    });
  });
});
