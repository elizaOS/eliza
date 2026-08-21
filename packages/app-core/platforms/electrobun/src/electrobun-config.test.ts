/** Exercises electrobun config behavior with deterministic app-core test fixtures. */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createElectrobunConfig,
  resolveElectrobunCopyMap,
  shouldEmbedRuntimeBundle,
} from "../electrobun.config";

describe("Electrobun Store packaging", () => {
  it("bundles CEF as the default Linux renderer", () => {
    const config = createElectrobunConfig();

    expect(config.build?.linux).toMatchObject({
      bundleCEF: true,
      defaultRenderer: "cef",
    });
  });

  it("renders the concrete Safari-matching Keychain group for signed macOS builds", () => {
    const previousTeamId = process.env.ELECTROBUN_TEAMID;
    const previousSafariTeam = process.env.ELIZA_SAFARI_SIGNING_TEAM;
    try {
      process.env.ELECTROBUN_TEAMID = "ABCDEFGHIJ";
      process.env.ELIZA_SAFARI_SIGNING_TEAM = "ABCDEFGHIJ";
      const config = createElectrobunConfig();
      expect(config.build?.mac?.entitlements).toMatchObject({
        "com.apple.security.application-groups": [
          "group.ai.elizaos.browserbridge",
        ],
        "keychain-access-groups": [
          "ABCDEFGHIJ.ai.elizaos.browserbridge.shared",
        ],
      });
    } finally {
      if (previousTeamId === undefined) delete process.env.ELECTROBUN_TEAMID;
      else process.env.ELECTROBUN_TEAMID = previousTeamId;
      if (previousSafariTeam === undefined)
        delete process.env.ELIZA_SAFARI_SIGNING_TEAM;
      else process.env.ELIZA_SAFARI_SIGNING_TEAM = previousSafariTeam;
    }
  });

  it("omits the embedded local agent runtime tree for Mac App Store builds", () => {
    const copy = resolveElectrobunCopyMap({
      buildVariant: "store",
      runtimeDistDir: "eliza-dist",
    });

    expect(Object.values(copy)).not.toContain("eliza-dist");
    expect(
      Object.values(copy).some((target) => target.startsWith("eliza-dist/")),
    ).toBe(false);
    expect(Object.values(copy)).not.toContain("remotes");
  });

  it("keeps the embedded runtime tree for direct desktop builds", () => {
    const copy = resolveElectrobunCopyMap({
      buildVariant: "direct",
      runtimeDistDir: "eliza-dist",
    });

    expect(
      Object.values(copy).some((target) => target.startsWith("eliza-dist/")),
    ).toBe(true);
    expect(Object.values(copy)).toContain("eliza-dist/package.json");
    expect(Object.values(copy)).not.toContain("remotes");
  });

  it("omits the embedded runtime tree for external API desktop builds", () => {
    const copy = resolveElectrobunCopyMap({
      buildVariant: "direct",
      runtimeDistDir: "eliza-dist",
      embedRuntime: shouldEmbedRuntimeBundle({
        ELIZA_DESKTOP_API_BASE: "http://127.0.0.1:31337",
      }),
    });

    expect(Object.values(copy)).not.toContain("eliza-dist");
    expect(Object.values(copy)).not.toContain("eliza-dist/package.json");
    expect(Object.values(copy)).not.toContain("remotes");
  });

  it("omits the embedded runtime tree for cloud-only consumer builds", () => {
    const copy = resolveElectrobunCopyMap({
      buildVariant: "direct",
      runtimeDistDir: "eliza-dist",
      embedRuntime: shouldEmbedRuntimeBundle({
        ELIZA_DESKTOP_CLOUD_ONLY: "1",
      }),
    });

    expect(Object.values(copy)).not.toContain("eliza-dist");
    expect(Object.values(copy)).not.toContain("eliza-dist/package.json");
    expect(
      Object.values(copy).some((target) => target.startsWith("eliza-dist/")),
    ).toBe(false);
  });

  it("keeps the embedded runtime tree when external API env is invalid", () => {
    const copy = resolveElectrobunCopyMap({
      buildVariant: "direct",
      runtimeDistDir: "eliza-dist",
      embedRuntime: shouldEmbedRuntimeBundle({
        ELIZA_DESKTOP_API_BASE: "not-a-url",
      }),
    });

    expect(
      Object.values(copy).some((target) => target.startsWith("eliza-dist/")),
    ).toBe(true);
    expect(Object.values(copy)).toContain("eliza-dist/package.json");
  });

  it("keeps generated brand overrides outside tracked source", () => {
    const originalNamespace = process.env.ELIZA_NAMESPACE;
    const outputPath = path.resolve(
      import.meta.dirname,
      "..",
      "tmp",
      "brand-config.json",
    );

    try {
      process.env.ELIZA_NAMESPACE = "eliza-test";
      createElectrobunConfig();

      expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toMatchObject({
        appName: "Eliza",
        appId: "ai.elizaos.app",
        namespace: "eliza-test",
        urlScheme: "elizaos",
      });
    } finally {
      if (originalNamespace === undefined) {
        delete process.env.ELIZA_NAMESPACE;
      } else {
        process.env.ELIZA_NAMESPACE = originalNamespace;
      }
      fs.rmSync(outputPath, { force: true });
    }
  });
});
