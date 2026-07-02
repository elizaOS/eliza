import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mobileWebDistReuseStatus } from "./mobile-web-build-reuse.mjs";
import {
  RENDERER_BUILD_MANIFEST_FILENAME,
  writeRendererBuildManifest,
} from "./renderer-build-manifest.mjs";
import { resolveRepoRootFromImportMeta } from "./repo-root.mjs";

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);
const cleanupHelperScript = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);

function removePathRecursive(targetPath: string) {
  execFileSync(process.execPath, [cleanupHelperScript, targetPath], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-web-reuse-"));
});

afterEach(() => {
  removePathRecursive(tmp);
});

function makeAppDist(
  meta: {
    variant?: string;
    capacitorTarget?: string;
    runtimeMode?: string;
  } = {},
) {
  const appDir = path.join(tmp, "app");
  const distDir = path.join(appDir, "dist");
  fs.mkdirSync(path.join(distDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(distDir, "index.html"), "<div id=root></div>");
  fs.writeFileSync(path.join(distDir, "assets", "index-abc123.js"), "boot()");
  writeRendererBuildManifest(distDir, meta);
  return { appDir, distDir };
}

describe("mobileWebDistReuseStatus", () => {
  it("reuses dist only when manifest variant/target match and Vite says it is fresh", () => {
    const { appDir } = makeAppDist({
      variant: "direct",
      capacitorTarget: "android",
    });

    const status = mobileWebDistReuseStatus({
      appDir,
      repoRoot: tmp,
      expectedVariant: "direct",
      expectedTarget: "android",
    });

    expect(status.reusable).toBe(true);
    expect(status.problems).toEqual([]);
    expect(status.manifest?.variant).toBe("direct");
  });

  it("does not auto-reuse an old manifest that lacks variant or target metadata", () => {
    const { appDir } = makeAppDist();

    const status = mobileWebDistReuseStatus({
      appDir,
      repoRoot: tmp,
      expectedVariant: "direct",
      expectedTarget: "ios",
    });

    expect(status.reusable).toBe(false);
    expect(status.problems).toContain(
      "dist manifest is missing variant; this build targets 'direct'",
    );
    expect(status.problems).toContain(
      "dist manifest is missing capacitor target; this build targets 'ios'",
    );
  });

  it("does not auto-reuse a dist built for another mobile target", () => {
    const { appDir } = makeAppDist({
      variant: "store",
      capacitorTarget: "ios",
    });

    const status = mobileWebDistReuseStatus({
      appDir,
      repoRoot: tmp,
      expectedVariant: "store",
      expectedTarget: "android",
    });

    expect(status.reusable).toBe(false);
    expect(status.problems).toContain(
      "dist built for capacitor target 'ios' but this build targets 'android'",
    );
  });

  it("does not auto-reuse a malformed manifest without a build id", () => {
    const { appDir, distDir } = makeAppDist({
      variant: "direct",
      capacitorTarget: "android",
    });
    fs.writeFileSync(
      path.join(distDir, RENDERER_BUILD_MANIFEST_FILENAME),
      `${JSON.stringify({
        schema: "elizaos.renderer.build/v1",
        variant: "direct",
        capacitorTarget: "android",
      })}\n`,
    );

    const status = mobileWebDistReuseStatus({
      appDir,
      repoRoot: tmp,
      expectedVariant: "direct",
      expectedTarget: "android",
    });

    expect(status.reusable).toBe(false);
    expect(status.problems).toContain("dist manifest is missing buildId");
  });

  it("does not reuse a dist baked for another lane's runtime mode (#11030)", () => {
    // The exact leak: an ios cloud/store build left a cloud-hybrid renderer in
    // dist, and a later build:ios:local (runtimeMode=local) picked it up.
    const { appDir } = makeAppDist({
      variant: "direct",
      capacitorTarget: "ios",
      runtimeMode: "cloud-hybrid",
    });

    const status = mobileWebDistReuseStatus({
      appDir,
      repoRoot: tmp,
      expectedVariant: "direct",
      expectedTarget: "ios",
      expectedRuntimeMode: "local",
    });

    expect(status.reusable).toBe(false);
    expect(status.problems).toContain(
      "dist built for runtime mode 'cloud-hybrid' but this build targets 'local'",
    );
  });

  it("does not reuse a dist with no runtime mode when the lane bakes one", () => {
    const { appDir } = makeAppDist({
      variant: "direct",
      capacitorTarget: "ios",
    });

    const status = mobileWebDistReuseStatus({
      appDir,
      repoRoot: tmp,
      expectedVariant: "direct",
      expectedTarget: "ios",
      expectedRuntimeMode: "local",
    });

    expect(status.reusable).toBe(false);
    expect(status.problems).toContain(
      "dist manifest is missing runtime mode; this build targets 'local'",
    );
  });

  it("reuses a matching runtime-mode dist, and skips the mode check when the option is omitted", () => {
    const { appDir } = makeAppDist({
      variant: "direct",
      capacitorTarget: "ios",
      runtimeMode: "local",
    });

    expect(
      mobileWebDistReuseStatus({
        appDir,
        repoRoot: tmp,
        expectedVariant: "direct",
        expectedTarget: "ios",
        expectedRuntimeMode: "local",
      }).reusable,
    ).toBe(true);

    // Omitted option (web/desktop surfaces without a runtime-mode lane):
    // a baked mode is not held against the dist.
    expect(
      mobileWebDistReuseStatus({
        appDir,
        repoRoot: tmp,
        expectedVariant: "direct",
        expectedTarget: "ios",
      }).reusable,
    ).toBe(true);
  });

  it("asserts an explicitly modeless lane with expectedRuntimeMode: null", () => {
    const { appDir } = makeAppDist({
      variant: "direct",
      capacitorTarget: "ios",
      runtimeMode: "cloud-hybrid",
    });

    const status = mobileWebDistReuseStatus({
      appDir,
      repoRoot: tmp,
      expectedVariant: "direct",
      expectedTarget: "ios",
      expectedRuntimeMode: null,
    });

    expect(status.reusable).toBe(false);
    expect(status.problems).toContain(
      "dist built for runtime mode 'cloud-hybrid' but this build targets an unset runtime mode",
    );
  });

  it("reports stale dist using the existing Vite staleness check", () => {
    const { appDir } = makeAppDist({
      variant: "direct",
      capacitorTarget: "android",
    });

    const status = mobileWebDistReuseStatus({
      appDir,
      repoRoot: tmp,
      expectedVariant: "direct",
      expectedTarget: "android",
      buildNeeded: () => true,
    });

    expect(status.reusable).toBe(false);
    expect(status.problems).toContain(
      "dist is older than renderer sources (stale)",
    );
  });
});
