/** Exercises electrobun config behavior with deterministic app-core test fixtures. */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createElectrobunConfig,
  resolveElectrobunCopyMap,
  resolveExperimentalExactWindowCopyMap,
  resolveLinuxRenderer,
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

  it("renders the exact Safari-matching App Group for provisioned macOS builds", () => {
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
      });
      expect(config.build?.mac?.entitlements).not.toHaveProperty(
        "keychain-access-groups",
      );
    } finally {
      if (previousTeamId === undefined) delete process.env.ELECTROBUN_TEAMID;
      else process.env.ELECTROBUN_TEAMID = previousTeamId;
      if (previousSafariTeam === undefined)
        delete process.env.ELIZA_SAFARI_SIGNING_TEAM;
      else process.env.ELIZA_SAFARI_SIGNING_TEAM = previousSafariTeam;
    }
  });

  it("supports a CEF-free native Linux package for sandbox qualification", () => {
    const originalRenderer = process.env.ELIZA_ELECTROBUN_LINUX_RENDERER;
    try {
      process.env.ELIZA_ELECTROBUN_LINUX_RENDERER = "native";
      const config = createElectrobunConfig();

      expect(config.build?.linux).toMatchObject({
        bundleCEF: false,
        bundleWGPU: true,
        defaultRenderer: "native",
      });
      expect(config.build?.linux).not.toHaveProperty("chromiumFlags");
    } finally {
      if (originalRenderer === undefined) {
        delete process.env.ELIZA_ELECTROBUN_LINUX_RENDERER;
      } else {
        process.env.ELIZA_ELECTROBUN_LINUX_RENDERER = originalRenderer;
      }
    }
  });

  it("rejects unknown Linux renderer selections", () => {
    expect(() =>
      resolveLinuxRenderer({ ELIZA_ELECTROBUN_LINUX_RENDERER: "unsafe" }),
    ).toThrow(/must be "native" or "cef"/);
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
    expect(copy["scripts/browser-bridge-unregister.ps1"]).toBe(
      "browser-bridge-unregister.ps1",
    );
  });

  it("includes the experimental helper only in an explicitly enabled direct macOS copy map", () => {
    const direct = resolveExperimentalExactWindowCopyMap({
      buildVariant: "direct",
      options: {
        enabled: true,
        platform: "darwin",
        helperPath: "/fixture/build/computeruse-exact-window-helper",
        manifestPath:
          "/fixture/build/computeruse-exact-window-helper.manifest.json",
        noticesPath: "/fixture/direct-only/THIRD_PARTY_NOTICES.txt",
        existsSync: () => true,
      },
    });
    expect(Object.values(direct)).toEqual([
      "computeruse-exact-window-helper",
      "computeruse-exact-window-helper.manifest.json",
      "computeruse-exact-window-THIRD_PARTY_NOTICES.txt",
    ]);
  });

  it("fails before manifest creation when the experimental helper is requested for Store", () => {
    expect(() =>
      resolveExperimentalExactWindowCopyMap({
        buildVariant: "store",
        options: {
          enabled: true,
          platform: "darwin",
          helperPath: "/fixture/helper",
          manifestPath: "/fixture/manifest",
          noticesPath: "/fixture/notices",
          existsSync: () => true,
        },
      }),
    ).toThrow(/forbidden in Mac App Store builds/);
  });

  it("keeps direct-only source outside the published Electrobun source manifest", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, "..", "package.json"),
        "utf8",
      ),
    ) as { files: string[] };
    expect(
      manifest.files.some(
        (entry) =>
          entry === "." ||
          entry === "*" ||
          entry.startsWith("direct-only") ||
          entry.startsWith("build"),
      ),
    ).toBe(false);
    const appCoreManifest = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, "../../..", "package.json"),
        "utf8",
      ),
    ) as { files: string[] };
    expect(appCoreManifest.files).toEqual(["dist"]);
    const sharedLauncher = fs.readFileSync(
      path.resolve(import.meta.dirname, "native", "agent.ts"),
      "utf8",
    );
    for (const forbidden of [
      "computeruse-exact-window-helper",
      "experimental_direct_exact_window",
      "SLEventPostToPid",
      "SkyLight.framework",
    ]) {
      expect(sharedLauncher).not.toContain(forbidden);
    }
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
