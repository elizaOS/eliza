import { describe, expect, it } from "vitest";
import { resolveBrowserBridgeReleaseManifest } from "./packaging";

describe("browser bridge packaging", () => {
  it("synthesizes release metadata from the browser-bridge package itself", () => {
    const manifest = resolveBrowserBridgeReleaseManifest(null, {
      allowSynthesis: true,
    });

    expect(manifest).not.toBeNull();
    expect(manifest).toMatchObject({
      chrome: {
        asset: {
          fileName: "browser-bridge-chrome-v0.1.0.zip",
        },
      },
      releaseTag: "v0.1.0",
      releaseVersion: "0.1.0",
      repository: "milady-ai/milady",
      safari: {
        asset: {
          fileName: "browser-bridge-safari-v0.1.0.zip",
        },
      },
    });
  });
});
