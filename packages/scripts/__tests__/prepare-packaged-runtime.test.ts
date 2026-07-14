/**
 * Builds and launches a real local npm runtime from prepared workspace
 * packages, while exercising incomplete and escaping package failures.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  auditRuntimeSourceResidue,
  auditRuntimeSymlinkContainment,
  parseArguments,
  parseLockedNpmAliasIdentities,
  preparationTesting,
  preparePackagedRuntime as prepareProductionRuntime,
  pruneGeneratedNativeBuildMetadata,
  pruneGeneratedPackageArtifacts,
  pruneIncompatibleNativeArtifacts,
  removeBundledMediaToolBinaries,
  removeInstallerLockArtifacts,
  resolveRuntimeWorkspaceClosure,
  runPackagerCommand,
  validatePackagePayload,
} from "../prepare-packaged-runtime.mjs";

const temporaryDirectories: string[] = [];
const assemblerScript = join(
  import.meta.dirname,
  "..",
  "prepare-packaged-runtime.mjs",
);
const nodeVersionResult = spawnSync("node", ["--version"], {
  encoding: "utf8",
});
if (nodeVersionResult.status !== 0) {
  throw new Error(
    `Could not resolve the fixture Node.js runtime: ${nodeVersionResult.stderr}`,
  );
}
const fixtureNodeVersion = nodeVersionResult.stdout.trim().replace(/^v/u, "");

function preparePackagedRuntime(
  options: Parameters<typeof prepareProductionRuntime>[0],
) {
  return prepareProductionRuntime({
    ...options,
    runtimeValidationPolicy: "lightweight-fixture",
  });
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function linkPackage(root: string, packageName: string, packageRoot: string) {
  const link = join(root, "node_modules", ...packageName.split("/"));
  mkdirSync(join(link, ".."), { recursive: true });
  symlinkSync(packageRoot, link);
}

function writeGeneratedRuntimeManifest(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "elizaos-packaged-runtime",
      version: "2.0.0",
      private: true,
      elizaosRuntime: {
        schemaVersion: 1,
        sourceLockSha256: "a".repeat(64),
        nativeArtifacts: { os: "linux", cpu: process.arch, libc: "glibc" },
        externalTools: { ffmpeg: { suppliedByRuntime: false } },
      },
    })}\n`,
  );
}

function fixture() {
  const sourceRoot = realpathSync(temporaryDirectory("eliza-runtime-source-"));
  const destinationRoot = join(
    tmpdir(),
    `eliza-runtime-${crypto.randomUUID()}`,
  );
  temporaryDirectories.push(destinationRoot);
  const agentRoot = join(sourceRoot, "packages", "agent");
  const agentDist = join(agentRoot, "dist");
  mkdirSync(agentDist, { recursive: true });
  writeFileSync(
    join(agentDist, "package.json"),
    JSON.stringify({
      name: "@elizaos/agent",
      version: "2.0.0",
      type: "module",
      bin: { "eliza-autonomous": "bin.js" },
      dependencies: { "@elizaos/shared": "^0.1.0" },
      peerDependencies: { "unpublished-optional-peer": "latest" },
      peerDependenciesMeta: {
        "unpublished-optional-peer": { optional: true },
      },
    }),
  );

  writeFileSync(
    join(agentRoot, "package.json"),
    JSON.stringify({
      name: "@elizaos/agent",
      version: "2.0.0",
      type: "module",
      bin: { "eliza-autonomous": "src/bin.js" },
      dependencies: { "@elizaos/shared": "workspace:*" },
      peerDependencies: { "unpublished-optional-peer": "latest" },
      peerDependenciesMeta: {
        "unpublished-optional-peer": { optional: true },
      },
    }),
  );

  writeFileSync(
    join(sourceRoot, "package.json"),
    JSON.stringify({
      name: "packaged-runtime-fixture",
      version: "1.0.0",
      private: true,
      packageManager: `bun@${Bun.version}`,
      engines: { node: fixtureNodeVersion },
      workspaces: ["packages/*"],
    }),
  );
  writeFileSync(join(sourceRoot, ".nvmrc"), `${fixtureNodeVersion}\n`);
  writeFileSync(join(sourceRoot, "LICENSE"), "MIT fixture license\n");
  writeFileSync(
    join(agentDist, "bin.js"),
    "#!/usr/bin/env node\nconsole.log(process.argv.includes('--version') ? '2.0.0' : 'Usage: eliza-autonomous');\n",
  );

  const sharedRoot = join(sourceRoot, "packages", "shared");
  mkdirSync(join(sharedRoot, "src"), { recursive: true });
  writeFileSync(
    join(sharedRoot, "package.json"),
    JSON.stringify({
      name: "@elizaos/shared",
      version: "0.1.0",
      type: "module",
      files: ["src/**/*", "PROJECT.md"],
      exports: { ".": "./src/index.js" },
    }),
  );
  writeFileSync(
    join(sharedRoot, "src", "index.js"),
    "export const shared = true;\n",
  );
  linkPackage(sourceRoot, "@elizaos/agent", agentRoot);
  linkPackage(sourceRoot, "@elizaos/shared", sharedRoot);
  const lockResult = Bun.spawnSync({
    cmd: [
      "bun",
      "install",
      "--lockfile-only",
      "--ignore-scripts",
      "--no-progress",
    ],
    cwd: sourceRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (lockResult.exitCode !== 0) {
    throw new Error(
      `Could not create fixture lock: ${lockResult.stderr.toString()}`,
    );
  }
  return { agentRoot, destinationRoot, sharedRoot, sourceRoot };
}

describe("preparePackagedRuntime", () => {
  test("rejects unknown runtime validation policies", () => {
    const { destinationRoot, sourceRoot } = fixture();

    expect(() =>
      prepareProductionRuntime({
        sourceRoot,
        destinationRoot,
        entryPackages: ["@elizaos/agent"],
        runtimeValidationPolicy: "unchecked-fixture",
      }),
    ).toThrow("Unknown packaged runtime validation policy");
  });

  test("restricts lightweight validation to the private test fixture", () => {
    const { destinationRoot, sourceRoot } = fixture();
    const manifestPath = join(sourceRoot, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...manifest, name: "production-lookalike" })}\n`,
    );

    expect(() =>
      prepareProductionRuntime({
        sourceRoot,
        destinationRoot,
        entryPackages: ["@elizaos/agent"],
        runtimeValidationPolicy: "lightweight-fixture",
      }),
    ).toThrow(
      "The lightweight packaged runtime policy is restricted to the private test fixture",
    );
  });

  test("replaces stubbed workspaces with inert payloads and drops their dependency trees", () => {
    const { agentRoot, destinationRoot, sourceRoot } = fixture();

    // A license-contaminated plugin the agent depends on, which itself pulls
    // in a transitive workspace dependency that must never enter the runtime.
    const contaminatedRoot = join(
      sourceRoot,
      "packages",
      "plugin-contaminated",
    );
    const contaminatedDepRoot = join(
      sourceRoot,
      "packages",
      "contaminated-dep",
    );
    for (const [root, manifest] of [
      [
        contaminatedRoot,
        {
          name: "@elizaos/plugin-contaminated",
          version: "0.2.0",
          type: "module",
          files: ["src/**/*"],
          exports: { ".": "./src/index.js" },
          dependencies: { "@elizaos/contaminated-dep": "workspace:*" },
          scripts: { postinstall: "exit 1" },
        },
      ],
      [
        contaminatedDepRoot,
        {
          name: "@elizaos/contaminated-dep",
          version: "0.3.0",
          type: "module",
          files: ["src/**/*"],
          exports: { ".": "./src/index.js" },
        },
      ],
    ] as const) {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        `${JSON.stringify(manifest)}\n`,
      );
      writeFileSync(
        join(root, "src", "index.js"),
        "export const contaminated = true;\n",
      );
    }
    const agentManifest = JSON.parse(
      readFileSync(join(agentRoot, "package.json"), "utf8"),
    );
    agentManifest.dependencies["@elizaos/plugin-contaminated"] = "workspace:*";
    writeFileSync(
      join(agentRoot, "package.json"),
      `${JSON.stringify(agentManifest)}\n`,
    );
    const agentDistManifest = JSON.parse(
      readFileSync(join(agentRoot, "dist", "package.json"), "utf8"),
    );
    agentDistManifest.dependencies["@elizaos/plugin-contaminated"] = "^0.2.0";
    writeFileSync(
      join(agentRoot, "dist", "package.json"),
      `${JSON.stringify(agentDistManifest)}\n`,
    );
    linkPackage(sourceRoot, "@elizaos/plugin-contaminated", contaminatedRoot);
    linkPackage(sourceRoot, "@elizaos/contaminated-dep", contaminatedDepRoot);
    const relockResult = Bun.spawnSync({
      cmd: [
        "bun",
        "install",
        "--lockfile-only",
        "--ignore-scripts",
        "--no-progress",
      ],
      cwd: sourceRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (relockResult.exitCode !== 0) {
      throw new Error(
        `Could not refresh fixture lock: ${relockResult.stderr.toString()}`,
      );
    }

    expect(() =>
      preparePackagedRuntime({
        sourceRoot,
        destinationRoot,
        entryPackages: ["@elizaos/agent"],
        stubPackages: ["@elizaos/agent"],
      }),
    ).toThrow("Entry package cannot be stubbed");
    expect(() =>
      preparePackagedRuntime({
        sourceRoot,
        destinationRoot,
        entryPackages: ["@elizaos/agent"],
        stubPackages: ["@elizaos/plugin-unrelated"],
      }),
    ).toThrow("not part of the runtime closure");

    const result = preparePackagedRuntime({
      sourceRoot,
      destinationRoot,
      entryPackages: ["@elizaos/agent"],
      stubPackages: ["@elizaos/plugin-contaminated"],
    });
    expect(result).toEqual({
      entryPackage: "@elizaos/agent",
      packageCount: 3,
      runtimeVersion: "2.0.0",
    });

    const stubRoot = join(
      destinationRoot,
      "node_modules",
      "@elizaos",
      "plugin-contaminated",
    );
    expect(lstatSync(stubRoot).isSymbolicLink()).toBe(true);
    expect(realpathSync(stubRoot).startsWith(destinationRoot)).toBe(true);
    const stubManifest = JSON.parse(
      readFileSync(join(stubRoot, "package.json"), "utf8"),
    );
    expect(stubManifest).toMatchObject({
      name: "@elizaos/plugin-contaminated",
      version: "0.2.0",
      license: "MIT",
      main: "./index.mjs",
    });
    expect(stubManifest.dependencies).toBeUndefined();
    expect(stubManifest.scripts).toBeUndefined();
    expect(readFileSync(join(stubRoot, "LICENSE"), "utf8")).toContain(
      "MIT fixture license",
    );
    expect(existsSync(join(stubRoot, "src"))).toBe(false);

    // The stub is importable and every optional consumer surface is a no-op.
    const importResult = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        [
          'const stub = await import("@elizaos/plugin-contaminated");',
          'if (stub.__elizaPackagedStub !== true) throw new Error("missing marker");',
          'if (stub.handleWhatsAppRoute() !== undefined) throw new Error("stub export is not a no-op");',
          'if (stub.default !== undefined) throw new Error("stub default must stay plugin-shapeless");',
        ].join("\n"),
      ],
      { cwd: destinationRoot, encoding: "utf8" },
    );
    expect(importResult.stderr).toBe("");
    expect(importResult.status).toBe(0);

    // The contaminated transitive tree never enters the runtime.
    expect(
      existsSync(
        join(destinationRoot, "node_modules", "@elizaos", "contaminated-dep"),
      ),
    ).toBe(false);
    const runtimeManifest = JSON.parse(
      readFileSync(join(destinationRoot, "package.json"), "utf8"),
    );
    expect(runtimeManifest.elizaosRuntime.stubbedPackages).toEqual([
      "@elizaos/plugin-contaminated",
    ]);
    expect(runtimeManifest.dependencies["@elizaos/plugin-contaminated"]).toBe(
      "0.2.0",
    );
    expect(
      runtimeManifest.dependencies["@elizaos/contaminated-dep"],
    ).toBeUndefined();
    const dependencyInventory = JSON.parse(
      readFileSync(
        join(destinationRoot, "elizaos-runtime-dependencies.json"),
        "utf8",
      ),
    );
    const inventoryNames = dependencyInventory.packages.map(
      (entry: { installName: string }) => entry.installName,
    );
    expect(inventoryNames).toContain("@elizaos/plugin-contaminated");
    expect(inventoryNames).not.toContain("@elizaos/contaminated-dep");
  });

  test("installs a self-contained normalized workspace closure and real bin", () => {
    const { destinationRoot, sourceRoot } = fixture();
    const result = preparePackagedRuntime({
      sourceRoot,
      destinationRoot,
      entryPackages: ["@elizaos/agent"],
      runtimeValidationPolicy: "lightweight-fixture",
    });

    expect(result).toEqual({
      entryPackage: "@elizaos/agent",
      packageCount: 2,
      runtimeVersion: "2.0.0",
    });
    for (const packageName of ["@elizaos/agent", "@elizaos/shared"]) {
      const installed = join(
        destinationRoot,
        "node_modules",
        ...packageName.split("/"),
      );
      expect(lstatSync(installed).isSymbolicLink()).toBe(true);
      expect(realpathSync(installed).startsWith(destinationRoot)).toBe(true);
      expect(
        JSON.parse(readFileSync(join(installed, "package.json"), "utf8")),
      ).toMatchObject({
        name: packageName,
        version: packageName === "@elizaos/agent" ? "2.0.0" : "0.1.0",
      });
    }
    expect(
      JSON.parse(
        readFileSync(
          join(
            destinationRoot,
            "node_modules",
            "@elizaos",
            "agent",
            "package.json",
          ),
          "utf8",
        ),
      ).dependencies,
    ).toEqual({ "@elizaos/shared": "0.1.0" });
    expect(
      JSON.parse(
        readFileSync(
          join(
            destinationRoot,
            "node_modules",
            "@elizaos",
            "agent",
            "package.json",
          ),
          "utf8",
        ),
      ).peerDependencies,
    ).toEqual({ "unpublished-optional-peer": "latest" });
    const runtimeManifest = JSON.parse(
      readFileSync(join(destinationRoot, "package.json"), "utf8"),
    );
    expect(runtimeManifest.dependencies).toEqual({
      "@elizaos/agent": "2.0.0",
      "@elizaos/shared": "0.1.0",
    });
    expect(runtimeManifest.elizaosRuntime.nativeArtifacts).toMatchObject({
      os: "linux",
      cpu: process.arch,
      libc: "glibc",
      removedCount: 0,
    });
    expect(runtimeManifest.elizaosRuntime.toolchain).toEqual({
      node: fixtureNodeVersion,
      bun: Bun.version,
      npm: expect.stringMatching(/^\d+\.\d+\.\d+/),
    });
    expect(runtimeManifest.elizaosRuntime.installerLocks).toMatchObject({
      removedCount: expect.any(Number),
      removedPathsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(
      runtimeManifest.elizaosRuntime.generatedPackageArtifacts,
    ).toMatchObject({
      removedCount: expect.any(Number),
      removedPathsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(
      runtimeManifest.elizaosRuntime.externalTools.ffmpeg.environment,
    ).toContain("FFMPEG_LOCATION");
    const dependencyInventory = JSON.parse(
      readFileSync(
        join(destinationRoot, "elizaos-runtime-dependencies.json"),
        "utf8",
      ),
    );
    expect(
      dependencyInventory.packages.map(
        (entry: { installName: string; name: string }) => ({
          installName: entry.installName,
          name: entry.name,
        }),
      ),
    ).toEqual([
      { installName: "@elizaos/agent", name: "@elizaos/agent" },
      { installName: "@elizaos/shared", name: "@elizaos/shared" },
    ]);
    expect(
      lstatSync(join(destinationRoot, "node_modules", ".package-lock.json"), {
        throwIfNoEntry: false,
      }),
    ).toBeUndefined();
    const launched = Bun.spawnSync({
      cmd: [
        "node",
        join(destinationRoot, "node_modules", "@elizaos", "agent", "bin.js"),
        "--version",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(launched.exitCode).toBe(0);
    expect(launched.stdout.toString().trim()).toBe("2.0.0");
    expect(
      existsSync(
        join(
          dirname(destinationRoot),
          `.${basename(destinationRoot)}.prepare.lock`,
        ),
      ),
    ).toBe(false);
  }, 30_000);

  test("accepts only exact npm aliases resolved by the committed Bun lock", () => {
    const lock = `{
      "workspaces": {
        "": { "dependencies": { "lru-cache": "npm:@wolfy1339/lru-cache@^11.0.2-patch.1" } }
      },
      "packages": {
        "@octokit/auth-app/lru-cache": ["@wolfy1339/lru-cache@11.0.2-patch.1", "", {}]
      }
    }`;
    const aliases = parseLockedNpmAliasIdentities(lock);
    expect(aliases).toEqual(
      new Set([
        ["lru-cache", "@wolfy1339/lru-cache", "11.0.2-patch.1"].join("\0"),
      ]),
    );
    expect(() =>
      preparationTesting.validateInstalledPackageIdentity(
        "lru-cache",
        { name: "@wolfy1339/lru-cache", version: "11.0.2-patch.1" },
        aliases,
        "/runtime/node_modules/@octokit/auth-app/node_modules/lru-cache/package.json",
      ),
    ).not.toThrow();
    expect(() =>
      preparationTesting.validateInstalledPackageIdentity(
        "lru-cache",
        { name: "@wolfy1339/lru-cache", version: "11.0.2-patch.2" },
        aliases,
        "/runtime/node_modules/lru-cache/package.json",
      ),
    ).toThrow(/not an exact locked npm alias/);
    expect(() =>
      preparationTesting.validateInstalledPackageIdentity(
        "different-alias",
        { name: "@wolfy1339/lru-cache", version: "11.0.2-patch.1" },
        aliases,
        "/runtime/node_modules/different-alias/package.json",
      ),
    ).toThrow(/not an exact locked npm alias/);
  });

  test("rejects prohibited runtime dependency families through names and aliases", () => {
    for (const identity of [
      "sharp",
      "libsignal",
      "whatsapp-rust-bridge",
      "@img/sharp-linux-x64",
      "@metamask/sdk",
      "@rainbow-me/rainbowkit",
      "@raydium-io/raydium-sdk-v2",
      "@signalapp/libsignal-client",
      "@steerprotocol/steer-sdk",
      "@trezor/connect",
      "@whiskeysockets/baileys",
    ]) {
      expect(() =>
        preparationTesting.assertAllowedRuntimePackageIdentity(
          identity,
          identity,
        ),
      ).toThrow(/prohibited dependency identity/);
    }

    expect(() =>
      preparationTesting.assertAllowedRuntimePackageIdentity(
        "image-codec-alias",
        "sharp",
      ),
    ).toThrow(/prohibited dependency identity: sharp/);
    expect(() =>
      preparationTesting.assertAllowedRuntimePackageIdentity(
        "@whiskeysockets/baileys",
        "renamed-safe-looking-package",
      ),
    ).toThrow(/prohibited dependency identity: @whiskeysockets\/baileys/);
    expect(() =>
      preparationTesting.assertAllowedRuntimePackageIdentity(
        "@elizaos/plugin-whatsapp",
        "@elizaos/plugin-whatsapp",
      ),
    ).not.toThrow();
  });

  test("honors a pre-existing preparation lock", () => {
    const { destinationRoot, sourceRoot } = fixture();
    const lockPath = join(
      dirname(destinationRoot),
      `.${basename(destinationRoot)}.prepare.lock`,
    );
    mkdirSync(lockPath);
    temporaryDirectories.push(lockPath);
    writeFileSync(
      join(lockPath, "owner.json"),
      '{"pid":123,"destination":"fixture"}\n',
    );

    expect(() =>
      preparePackagedRuntime({
        sourceRoot,
        destinationRoot,
        entryPackages: ["@elizaos/agent"],
      }),
    ).toThrow(/destination is already being prepared/);
    expect(readFileSync(join(lockPath, "owner.json"), "utf8")).toContain(
      '"pid":123',
    );
    expect(existsSync(destinationRoot)).toBe(false);
  });

  test("allows exactly one process to own a runtime destination", async () => {
    const root = realpathSync(temporaryDirectory("eliza-runtime-lock-race-"));
    const destination = join(root, "runtime");
    const ready = join(root, "owner-ready");
    const release = join(root, "release-owner");
    const moduleUrl = new URL(
      "../prepare-packaged-runtime.mjs",
      import.meta.url,
    ).href;
    const ownerCode = `
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { preparationTesting } from ${JSON.stringify(moduleUrl)};
const lock = preparationTesting.acquirePreparationLock(
  ${JSON.stringify(destination)},
  ${JSON.stringify(root)},
);
writeFileSync(${JSON.stringify(ready)}, "ready\\n");
while (!existsSync(${JSON.stringify(release)})) await sleep(10);
preparationTesting.releasePreparationLock(lock);
`;
    const owner = Bun.spawn(
      [process.execPath, "--input-type=module", "--eval", ownerCode],
      { stdout: "pipe", stderr: "pipe" },
    );
    let ownerExitCode = -1;
    let ownerStderr = "";
    try {
      const deadline = Date.now() + 20_000;
      while (!existsSync(ready) && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(existsSync(ready)).toBe(true);

      const loserCode = `
import { preparationTesting } from ${JSON.stringify(moduleUrl)};
try {
  const lock = preparationTesting.acquirePreparationLock(
    ${JSON.stringify(destination)},
    ${JSON.stringify(root)},
  );
  preparationTesting.releasePreparationLock(lock);
  process.exit(2);
} catch (error) {
  process.stderr.write(String(error instanceof Error ? error.message : error));
  process.exit(23);
}
`;
      const loser = Bun.spawnSync({
        cmd: [process.execPath, "--input-type=module", "--eval", loserCode],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(loser.exitCode).toBe(23);
      expect(loser.stderr.toString()).toContain("already being prepared");
      expect(existsSync(destination)).toBe(false);
      expect(
        existsSync(preparationTesting.preparationLockPath(destination)),
      ).toBe(true);
      expect(
        readdirSync(root).filter((name) =>
          name.startsWith(".runtime.prepare-"),
        ),
      ).toEqual([]);
    } finally {
      writeFileSync(release, "release\n");
      ownerExitCode = await owner.exited;
      ownerStderr = await new Response(owner.stderr).text();
    }
    expect(ownerExitCode, ownerStderr).toBe(0);
    expect(
      existsSync(preparationTesting.preparationLockPath(destination)),
    ).toBe(false);
  });

  test("preserves the prior runtime when the atomic replacement fails", () => {
    const root = temporaryDirectory("eliza-runtime-commit-");
    const destination = join(root, "runtime");
    const staging = join(root, ".runtime.prepare-fixture");
    writeGeneratedRuntimeManifest(destination);
    writeGeneratedRuntimeManifest(staging);
    writeFileSync(join(destination, "sentinel"), "prior runtime\n");
    writeFileSync(join(staging, "sentinel"), "new runtime\n");
    let renameCount = 0;

    let failure: unknown;
    try {
      preparationTesting.commitPreparedRuntime(
        staging,
        destination,
        "fixture-token",
        (source, target) => {
          renameCount += 1;
          if (renameCount === 2) throw new Error("fault-injected rename");
          renameSync(source, target);
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw failure;
    expect(failure.message).toContain("Could not commit packaged runtime");
    expect(failure.cause).toBeInstanceOf(Error);
    if (!(failure.cause instanceof Error)) throw failure.cause;
    expect(failure.cause.message).toBe("fault-injected rename");
    expect(renameCount).toBe(3);
    expect(readFileSync(join(destination, "sentinel"), "utf8")).toBe(
      "prior runtime\n",
    );
    expect(readFileSync(join(staging, "sentinel"), "utf8")).toBe(
      "new runtime\n",
    );
    expect(
      existsSync(join(root, ".runtime.prepare-backup-fixture-token")),
    ).toBe(false);
  });

  test("never removes a preparation lock whose ownership changed", () => {
    const root = realpathSync(temporaryDirectory("eliza-runtime-lock-owner-"));
    const destination = join(root, "runtime");
    const lock = preparationTesting.acquirePreparationLock(destination, root);
    writeFileSync(
      join(lock.path, "owner.json"),
      '{"token":"replacement-owner"}\n',
    );

    expect(() => preparationTesting.releasePreparationLock(lock)).toThrow(
      /ownership changed/,
    );
    expect(existsSync(lock.path)).toBe(true);
    rmSync(lock.path, { recursive: true });
  });

  test("fails when the installed entry package omits its executable", () => {
    const { agentRoot, destinationRoot, sourceRoot } = fixture();
    rmSync(join(agentRoot, "dist", "bin.js"));
    expect(() =>
      preparePackagedRuntime({
        sourceRoot,
        destinationRoot,
        entryPackages: ["@elizaos/agent"],
      }),
    ).toThrow(/no executable bin/);
    expect(
      existsSync(preparationTesting.preparationLockPath(destinationRoot)),
    ).toBe(false);
  });

  test("rejects a prepared-only external dependency before installation", () => {
    const { agentRoot, destinationRoot, sourceRoot } = fixture();
    const manifestPath = join(agentRoot, "dist", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.dependencies["external-package-not-installed-in-fixture"] =
      "1.0.0";
    writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(() =>
      preparePackagedRuntime({
        sourceRoot,
        destinationRoot,
        entryPackages: ["@elizaos/agent"],
      }),
    ).toThrow(
      /Prepared runtime dependency mismatch.*external-package-not-installed-in-fixture/,
    );
    expect(existsSync(destinationRoot)).toBe(false);
    expect(
      existsSync(preparationTesting.preparationLockPath(destinationRoot)),
    ).toBe(false);
  });

  test("rejects a prepared package version mismatch", () => {
    const { agentRoot, destinationRoot, sourceRoot } = fixture();
    const manifestPath = join(agentRoot, "dist", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.version = "2.0.1";
    writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(() =>
      preparePackagedRuntime({
        sourceRoot,
        destinationRoot,
        entryPackages: ["@elizaos/agent"],
      }),
    ).toThrow(/Prepared runtime version mismatch/);
    expect(existsSync(destinationRoot)).toBe(false);
  });

  test("rejects prepared peer dependency metadata drift", () => {
    const { agentRoot, destinationRoot, sourceRoot } = fixture();
    const manifestPath = join(agentRoot, "dist", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.peerDependenciesMeta["unpublished-optional-peer"].injected = true;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(() =>
      preparePackagedRuntime({
        sourceRoot,
        destinationRoot,
        entryPackages: ["@elizaos/agent"],
      }),
    ).toThrow(/Prepared runtime dependency metadata mismatch/);
    expect(existsSync(destinationRoot)).toBe(false);
  });

  test("excludes prepared dependencies and installer locks outside the frozen tree", () => {
    const { agentRoot, destinationRoot, sourceRoot } = fixture();
    const injectedPackage = join(agentRoot, "dist", "node_modules", "injected");
    mkdirSync(injectedPackage, { recursive: true });
    writeFileSync(
      join(injectedPackage, "package.json"),
      '{"name":"injected","version":"1.0.0"}\n',
    );
    writeFileSync(join(agentRoot, "dist", "package-lock.json"), "{}\n");

    preparePackagedRuntime({
      sourceRoot,
      destinationRoot,
      entryPackages: ["@elizaos/agent"],
    });
    const materializedAgent = join(destinationRoot, "packages", "agent");
    expect(existsSync(join(materializedAgent, "node_modules"))).toBe(false);
    expect(existsSync(join(materializedAgent, "package-lock.json"))).toBe(
      false,
    );
  });

  test("rejects an unavailable workspace protocol dependency", () => {
    const { agentRoot, sourceRoot } = fixture();
    const manifestPath = join(agentRoot, "dist", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.dependencies["@elizaos/missing-workspace"] = "workspace:*";
    writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(() =>
      resolveRuntimeWorkspaceClosure(sourceRoot, ["@elizaos/agent"]),
    ).toThrow(/references unavailable @elizaos\/missing-workspace/);
  });

  test("rejects a non-workspace local file dependency", () => {
    const { agentRoot, sourceRoot } = fixture();
    const manifestPath = join(agentRoot, "dist", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.dependencies["local-only-package"] = "file:../local-only-package";
    writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(() =>
      resolveRuntimeWorkspaceClosure(sourceRoot, ["@elizaos/agent"]),
    ).toThrow(/non-workspace local dependency/);
  });

  test("rejects a required peer with no runtime dependency backing it", () => {
    const { agentRoot, destinationRoot, sourceRoot } = fixture();
    const manifestPath = join(agentRoot, "dist", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.peerDependencies["unbacked-required-peer"] = "1.0.0";
    writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(() =>
      preparePackagedRuntime({
        sourceRoot,
        destinationRoot,
        entryPackages: ["@elizaos/agent"],
      }),
    ).toThrow(/unbacked required peer/);
  });

  test("rejects workspace links that resolve outside the source tree", () => {
    const { sourceRoot } = fixture();
    const external = realpathSync(
      temporaryDirectory("eliza-runtime-external-"),
    );
    mkdirSync(join(external, "dist"), { recursive: true });
    writeFileSync(
      join(external, "dist", "package.json"),
      JSON.stringify({ name: "@elizaos/external", version: "2.0.0" }),
    );
    linkPackage(sourceRoot, "@elizaos/external", external);
    expect(() =>
      resolveRuntimeWorkspaceClosure(sourceRoot, ["@elizaos/external"]),
    ).toThrow(/outside the source root/);
  });

  test("rejects workspace and prepared-package directory symlinks", () => {
    const { agentRoot, sharedRoot, sourceRoot } = fixture();
    const externalWorkspace = temporaryDirectory(
      "eliza-runtime-workspace-external-",
    );
    writeFileSync(
      join(externalWorkspace, "package.json"),
      JSON.stringify({ name: "@elizaos/shared", version: "0.1.0" }),
    );
    rmSync(sharedRoot, { recursive: true });
    symlinkSync(externalWorkspace, sharedRoot);

    expect(() =>
      resolveRuntimeWorkspaceClosure(sourceRoot, ["@elizaos/agent"]),
    ).toThrow(/symbolic link|outside the source root|not linked/);

    rmSync(sharedRoot);
    mkdirSync(sharedRoot, { recursive: true });
    writeFileSync(
      join(sharedRoot, "package.json"),
      JSON.stringify({ name: "@elizaos/shared", version: "0.1.0" }),
    );
    const externalDist = temporaryDirectory("eliza-runtime-dist-external-");
    writeFileSync(
      join(externalDist, "package.json"),
      JSON.stringify({ name: "@elizaos/agent", version: "2.0.0" }),
    );
    rmSync(join(agentRoot, "dist"), { recursive: true });
    symlinkSync(externalDist, join(agentRoot, "dist"));

    expect(() =>
      resolveRuntimeWorkspaceClosure(sourceRoot, ["@elizaos/agent"]),
    ).toThrow(/contains a symbolic link/);
  });

  test("refuses destructive destination aliases and source ancestors", () => {
    const { agentRoot, sourceRoot } = fixture();
    expect(() =>
      preparePackagedRuntime({
        sourceRoot,
        destinationRoot: sourceRoot,
        entryPackages: ["@elizaos/agent"],
      }),
    ).toThrow(/destination cannot contain the source root/);
    expect(readFileSync(join(sourceRoot, "package.json"), "utf8")).toContain(
      '"workspaces"',
    );

    const container = temporaryDirectory("eliza-runtime-ancestor-");
    const nestedSource = join(container, "checkout");
    mkdirSync(nestedSource);
    writeFileSync(join(container, "sentinel"), "preserved\n");
    expect(() =>
      preparePackagedRuntime({
        sourceRoot: nestedSource,
        destinationRoot: container,
        entryPackages: ["@elizaos/agent"],
      }),
    ).toThrow(/destination cannot contain the source root/);
    expect(readFileSync(join(container, "sentinel"), "utf8")).toBe(
      "preserved\n",
    );

    const linkContainer = temporaryDirectory("eliza-runtime-destination-link-");
    const linkTarget = temporaryDirectory("eliza-runtime-destination-target-");
    const destinationLink = join(linkContainer, "runtime");
    writeFileSync(join(linkTarget, "sentinel"), "preserved\n");
    symlinkSync(linkTarget, destinationLink);
    expect(() =>
      preparePackagedRuntime({
        sourceRoot,
        destinationRoot: destinationLink,
        entryPackages: ["@elizaos/agent"],
      }),
    ).toThrow(/destination cannot be a symlink/);
    expect(readFileSync(join(linkTarget, "sentinel"), "utf8")).toBe(
      "preserved\n",
    );

    writeFileSync(join(agentRoot, "sentinel"), "workspace preserved\n");
    expect(() =>
      preparePackagedRuntime({
        sourceRoot,
        destinationRoot: agentRoot,
        entryPackages: ["@elizaos/agent"],
      }),
    ).toThrow(/not an approved generated path|source workspace/);
    expect(readFileSync(join(agentRoot, "sentinel"), "utf8")).toBe(
      "workspace preserved\n",
    );
  });

  test("preserves arbitrary in-checkout destinations and only allows packaging runtime paths", () => {
    const { sourceRoot } = fixture();
    const directoryDestination = join(sourceRoot, "packages", "scripts");
    mkdirSync(directoryDestination, { recursive: true });
    writeFileSync(join(directoryDestination, "sentinel"), "directory kept\n");

    expect(() =>
      preparePackagedRuntime({
        sourceRoot,
        destinationRoot: directoryDestination,
        entryPackages: ["@elizaos/agent"],
      }),
    ).toThrow(/not an approved generated path/);
    expect(readFileSync(join(directoryDestination, "sentinel"), "utf8")).toBe(
      "directory kept\n",
    );

    const fileDestination = join(sourceRoot, "packages", "runtime-output");
    writeFileSync(fileDestination, "file kept\n");
    expect(() =>
      preparePackagedRuntime({
        sourceRoot,
        destinationRoot: fileDestination,
        entryPackages: ["@elizaos/agent"],
      }),
    ).toThrow(/not an approved generated path/);
    expect(readFileSync(fileDestination, "utf8")).toBe("file kept\n");

    for (const channel of ["debian", "flatpak", "snap"]) {
      expect(() =>
        preparationTesting.assertSafeRuntimeDestination(
          sourceRoot,
          join(
            sourceRoot,
            "packages",
            "app-core",
            "packaging",
            channel,
            "runtime",
          ),
        ),
      ).not.toThrow();
    }
    expect(() =>
      preparationTesting.assertSafeRuntimeDestination(
        sourceRoot,
        join(
          sourceRoot,
          "packages",
          "app-core",
          "packaging",
          "pypi",
          "runtime",
        ),
      ),
    ).toThrow(/not an approved generated path/);
  });

  test("preserves an existing destination without the exact generated runtime schema", () => {
    const { destinationRoot, sourceRoot } = fixture();
    mkdirSync(destinationRoot);
    writeFileSync(join(destinationRoot, "sentinel"), "not generated\n");
    writeFileSync(
      join(destinationRoot, "package.json"),
      JSON.stringify({ name: "elizaos-packaged-runtime", private: true }),
    );

    expect(() =>
      preparePackagedRuntime({
        sourceRoot,
        destinationRoot,
        entryPackages: ["@elizaos/agent"],
      }),
    ).toThrow(/not a schema-1 packaged runtime/);
    expect(readFileSync(join(destinationRoot, "sentinel"), "utf8")).toBe(
      "not generated\n",
    );
    expect(
      existsSync(preparationTesting.preparationLockPath(destinationRoot)),
    ).toBe(false);
  });

  test("commit refuses to replace an arbitrary directory or regular file", () => {
    const root = temporaryDirectory("eliza-runtime-unsafe-commit-");
    const directoryDestination = join(root, "directory");
    const directoryStaging = join(root, ".directory.prepare-fixture");
    mkdirSync(directoryDestination);
    writeGeneratedRuntimeManifest(directoryStaging);
    writeFileSync(join(directoryDestination, "sentinel"), "directory kept\n");

    expect(() =>
      preparationTesting.commitPreparedRuntime(
        directoryStaging,
        directoryDestination,
        "directory-token",
      ),
    ).toThrow(/without a regular packaged runtime manifest/);
    expect(readFileSync(join(directoryDestination, "sentinel"), "utf8")).toBe(
      "directory kept\n",
    );
    expect(existsSync(directoryStaging)).toBe(true);

    const fileDestination = join(root, "file");
    const fileStaging = join(root, ".file.prepare-fixture");
    writeFileSync(fileDestination, "file kept\n");
    writeGeneratedRuntimeManifest(fileStaging);
    expect(() =>
      preparationTesting.commitPreparedRuntime(
        fileStaging,
        fileDestination,
        "file-token",
      ),
    ).toThrow(/not a directory/);
    expect(readFileSync(fileDestination, "utf8")).toBe("file kept\n");
    expect(existsSync(fileStaging)).toBe(true);
  });

  test("requires the exact committed lock and toolchain", () => {
    const { destinationRoot, sourceRoot } = fixture();
    const lockPath = join(sourceRoot, "bun.lock");
    const lockBytes = readFileSync(lockPath);
    rmSync(lockPath);
    expect(() =>
      preparePackagedRuntime({
        sourceRoot,
        destinationRoot,
        entryPackages: ["@elizaos/agent"],
      }),
    ).toThrow(/requires the committed bun.lock/);
    writeFileSync(lockPath, lockBytes);

    const manifestPath = join(sourceRoot, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.packageManager = "bun@0.0.0";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() =>
      preparePackagedRuntime({
        sourceRoot,
        destinationRoot,
        entryPackages: ["@elizaos/agent"],
      }),
    ).toThrow(/requires Bun 0.0.0/);
  });

  test("rejects npm outside the executing Node distribution", () => {
    const { destinationRoot, sourceRoot } = fixture();
    const nodeVersion = spawnSync("node", ["--version"], {
      encoding: "utf8",
    });
    expect(nodeVersion.status, nodeVersion.stderr).toBe(0);
    const manifestPath = join(sourceRoot, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.engines = { node: nodeVersion.stdout.trim().replace(/^v/, "") };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(
      join(sourceRoot, ".nvmrc"),
      nodeVersion.stdout.trim().replace(/^v/u, ""),
    );

    const completed = spawnSync(
      "node",
      [
        assemblerScript,
        "--source-root",
        sourceRoot,
        "--destination-root",
        destinationRoot,
        "--entry",
        "@elizaos/agent",
        "--npm",
        process.execPath,
      ],
      { encoding: "utf8" },
    );

    expect(completed.status).not.toBe(0);
    expect(completed.stderr).toContain(
      "Packaged runtime must use npm bundled with Node",
    );
    expect(existsSync(destinationRoot)).toBe(false);
  });

  test("rejects manifest drift from the committed lock", () => {
    const { agentRoot, destinationRoot, sourceRoot } = fixture();
    for (const manifestPath of [
      join(agentRoot, "package.json"),
      join(agentRoot, "dist", "package.json"),
    ]) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.dependencies["lock-drift"] = "1.0.0";
      writeFileSync(manifestPath, JSON.stringify(manifest));
    }

    expect(() =>
      preparePackagedRuntime({
        sourceRoot,
        destinationRoot,
        entryPackages: ["@elizaos/agent"],
      }),
    ).toThrow(/exited 1|lockfile had changes/);
  });

  test("rejects symlinks in package payload inventories", () => {
    const { sharedRoot } = fixture();
    const externalRoot = temporaryDirectory("eliza-runtime-payload-external-");
    const external = join(externalRoot, "external.js");
    writeFileSync(external, "export const external = true;\n");
    symlinkSync(external, join(sharedRoot, "src", "linked.js"));

    expect(() => validatePackagePayload(sharedRoot, ["src/linked.js"])).toThrow(
      /symbolic link/,
    );
    expect(() => validatePackagePayload(sharedRoot)).toThrow(
      /non-regular entry/,
    );

    rmSync(join(sharedRoot, "src", "linked.js"));
    mkdirSync(join(externalRoot, "escaped"));
    writeFileSync(
      join(externalRoot, "escaped", "nested.js"),
      "export const escaped = true;\n",
    );
    symlinkSync(
      join(externalRoot, "escaped"),
      join(sharedRoot, "src", "linked-parent"),
    );
    expect(() =>
      validatePackagePayload(sharedRoot, ["src/linked-parent/nested.js"]),
    ).toThrow(/contains a symbolic link/);
  });

  test("accepts contained runtime links and rejects escaping links", () => {
    const root = realpathSync(temporaryDirectory("eliza-runtime-link-audit-"));
    const externalRoot = realpathSync(
      temporaryDirectory("eliza-runtime-link-external-"),
    );
    writeFileSync(join(root, "inside.js"), "inside\n");
    writeFileSync(join(externalRoot, "outside.js"), "outside\n");
    symlinkSync("inside.js", join(root, "contained-link"));

    expect(() => auditRuntimeSymlinkContainment(root)).not.toThrow();
    symlinkSync(join(externalRoot, "outside.js"), join(root, "escaping-link"));
    expect(() => auditRuntimeSymlinkContainment(root)).toThrow(
      /contains an absolute symlink/,
    );
  });

  test.each([
    { targetCpu: "x64", targetMachine: 62, foreignMachine: 183 },
    { targetCpu: "arm64", targetMachine: 183, foreignMachine: 62 },
  ])("prunes foreign, musl, and non-Linux artifacts for $targetCpu", ({
    targetCpu,
    targetMachine,
    foreignMachine,
  }) => {
    const root = realpathSync(temporaryDirectory("eliza-native-prune-"));
    const elf = (machine: number, marker = "") => {
      const header = Buffer.alloc(64);
      header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
      header.writeUInt16LE(machine, 18);
      return Buffer.concat([header, Buffer.from(marker)]);
    };
    const pe = Buffer.alloc(128);
    pe.set(Buffer.from("MZ"));
    pe.writeUInt32LE(64, 60);
    pe.set(Buffer.from("PE\0\0"), 64);
    writeFileSync(join(root, "target.node"), elf(targetMachine));
    writeFileSync(join(root, "foreign.node"), elf(foreignMachine));
    writeFileSync(
      join(root, "musl.node"),
      elf(targetMachine, "libc.musl-target.so.1"),
    );
    writeFileSync(
      join(root, "unversioned.node"),
      elf(targetMachine, "libc.so\0"),
    );
    writeFileSync(
      join(root, "android.node"),
      elf(targetMachine, "liblog.so\0"),
    );
    writeFileSync(join(root, "windows.bare"), pe);
    writeFileSync(
      join(root, "darwin.bare"),
      Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
    );
    writeFileSync(join(root, "portable.txt"), "MZ is ordinary text\n");

    expect(pruneIncompatibleNativeArtifacts(root, targetCpu)).toEqual([
      "android.node",
      "darwin.bare",
      "foreign.node",
      "musl.node",
      "unversioned.node",
      "windows.bare",
    ]);
    expect(existsSync(join(root, "target.node"))).toBe(true);
    expect(existsSync(join(root, "portable.txt"))).toBe(true);
  });

  test("rejects native artifact CPUs outside the packaging matrix", () => {
    const root = realpathSync(temporaryDirectory("eliza-native-prune-"));
    expect(() => pruneIncompatibleNativeArtifacts(root, "riscv64")).toThrow(
      /Unsupported native artifact target CPU/,
    );
  });

  test("discards node-gyp build metadata without masking other residue", () => {
    const root = realpathSync(temporaryDirectory("eliza-native-metadata-"));
    const buildRoot = join(root, "node_modules", "native-addon", "build");
    const forbiddenRoot = "/checkout/eliza";
    mkdirSync(join(buildRoot, "Release", ".deps"), { recursive: true });
    mkdirSync(join(buildRoot, "Release", "obj.target", "addon"), {
      recursive: true,
    });
    writeFileSync(join(buildRoot, "Makefile"), `${forbiddenRoot}\n`);
    writeFileSync(join(buildRoot, "binding.target.mk"), "compile graph\n");
    writeFileSync(join(buildRoot, "config.gypi"), `${forbiddenRoot}\n`);
    writeFileSync(join(buildRoot, "Release", ".deps", "addon.node.d"), "d\n");
    writeFileSync(
      join(buildRoot, "Release", "obj.target", "addon", "addon.o"),
      "object\n",
    );
    writeFileSync(join(buildRoot, "Release", "addon.node"), "runtime\n");
    writeFileSync(join(buildRoot, "runtime.json"), '{"needed":true}\n');

    expect(pruneGeneratedNativeBuildMetadata(root)).toEqual([
      "node_modules/native-addon/build/Makefile",
      "node_modules/native-addon/build/Release/.deps",
      "node_modules/native-addon/build/Release/obj.target",
      "node_modules/native-addon/build/binding.target.mk",
      "node_modules/native-addon/build/config.gypi",
    ]);
    expect(existsSync(join(buildRoot, "Release", "addon.node"))).toBe(true);
    expect(existsSync(join(buildRoot, "runtime.json"))).toBe(true);
    expect(() =>
      auditRuntimeSourceResidue(root, [forbiddenRoot]),
    ).not.toThrow();

    writeFileSync(join(buildRoot, "runtime.json"), `${forbiddenRoot}\n`);
    expect(() => auditRuntimeSourceResidue(root, [forbiddenRoot])).toThrow(
      /source checkout path/,
    );
  });

  test("removes every nested package-manager lock before inventory", () => {
    const root = realpathSync(temporaryDirectory("eliza-installer-locks-"));
    const nestedRoot = join(root, "node_modules", "third-party", "fixtures");
    mkdirSync(nestedRoot, { recursive: true });
    const lockNames = [
      ".package-lock.json",
      "bun.lock",
      "bun.lockb",
      "npm-shrinkwrap.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "pnpm-lock.yml",
      "yarn.lock",
    ];
    for (const lockName of lockNames) {
      writeFileSync(join(nestedRoot, lockName), "fixture lock\n");
    }
    writeFileSync(join(nestedRoot, "runtime.js"), "export {};\n");

    expect(removeInstallerLockArtifacts(root)).toEqual(
      lockNames
        .map((lockName) =>
          join("node_modules", "third-party", "fixtures", lockName),
        )
        .sort(),
    );
    expect(existsSync(join(nestedRoot, "runtime.js"))).toBe(true);
    expect(() => auditRuntimeSourceResidue(root, [])).not.toThrow();

    writeFileSync(join(nestedRoot, "yarn.lock"), "residual lock\n");
    expect(() => auditRuntimeSourceResidue(root, [])).toThrow(
      /installer lock artifact.*yarn\.lock/,
    );
  });

  test("removes generated package build state before inventory", () => {
    const root = realpathSync(temporaryDirectory("eliza-generated-package-"));
    const workspaceCache = join(root, "packages", "cloud", "shared", ".turbo");
    const dependencyCache = join(root, "node_modules", "third-party", ".turbo");
    mkdirSync(workspaceCache, { recursive: true });
    mkdirSync(dependencyCache, { recursive: true });
    writeFileSync(
      join(workspaceCache, "turbo-typecheck.log"),
      "/source/checkout/packages/cloud/shared\n",
    );
    writeFileSync(join(dependencyCache, "turbo-build.log"), "cache\n");
    const workspaceBuildInfo = join(
      root,
      "packages",
      "core",
      "dist",
      "packages",
      "core",
      "tsconfig.tsbuildinfo",
    );
    mkdirSync(dirname(workspaceBuildInfo), { recursive: true });
    writeFileSync(workspaceBuildInfo, "/source/checkout/packages/core\n");
    writeFileSync(join(root, "runtime.js"), "export {};\n");

    expect(pruneGeneratedPackageArtifacts(root)).toEqual([
      join("node_modules", "third-party", ".turbo"),
      join("packages", "cloud", "shared", ".turbo"),
      join(
        "packages",
        "core",
        "dist",
        "packages",
        "core",
        "tsconfig.tsbuildinfo",
      ),
    ]);
    expect(existsSync(join(root, "runtime.js"))).toBe(true);
    expect(() =>
      auditRuntimeSourceResidue(root, ["/source/checkout"]),
    ).not.toThrow();

    mkdirSync(workspaceCache, { recursive: true });
    expect(() => auditRuntimeSourceResidue(root, [])).toThrow(
      /generated package artifact.*\.turbo/u,
    );
    rmSync(workspaceCache, { recursive: true });
    writeFileSync(workspaceBuildInfo, "residual compiler state\n");
    expect(() => auditRuntimeSourceResidue(root, [])).toThrow(
      /generated package artifact.*\.tsbuildinfo/u,
    );
  });

  test("removes bundled FFmpeg executables while retaining wrapper modules", () => {
    const root = realpathSync(temporaryDirectory("eliza-media-tools-"));
    const ffmpegRoot = join(root, "node_modules", "ffmpeg-static");
    const ffprobeRoot = join(root, "node_modules", "ffprobe-static");
    mkdirSync(join(ffprobeRoot, "bin", "linux", "x64"), {
      recursive: true,
    });
    mkdirSync(ffmpegRoot, { recursive: true });
    writeFileSync(
      join(ffmpegRoot, "index.js"),
      "module.exports = 'wrapper';\n",
    );
    writeFileSync(join(ffmpegRoot, "ffmpeg"), "unverifiable static binary\n");
    writeFileSync(join(ffprobeRoot, "index.js"), "exports.path = 'wrapper';\n");
    writeFileSync(
      join(ffprobeRoot, "bin", "linux", "x64", "ffprobe"),
      "unverifiable static binary\n",
    );

    expect(removeBundledMediaToolBinaries(root)).toEqual([
      "node_modules/ffmpeg-static/ffmpeg",
      "node_modules/ffprobe-static/bin/linux/x64/ffprobe",
    ]);
    expect(existsSync(join(ffmpegRoot, "index.js"))).toBe(true);
    expect(existsSync(join(ffmpegRoot, "ffmpeg"))).toBe(false);
    expect(existsSync(join(ffprobeRoot, "index.js"))).toBe(true);
    expect(existsSync(join(ffprobeRoot, "bin"))).toBe(false);
  });

  test("bounds subprocess execution", () => {
    const startedAt = Date.now();
    expect(() =>
      runPackagerCommand(
        process.execPath,
        ["-e", "setTimeout(() => {}, 10_000)"],
        { timeoutMs: 50 },
      ),
    ).toThrow(/timed out after 50ms/);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe("parseArguments", () => {
  test.each([
    "x64",
    "arm64",
  ])("requires roots and accepts multiple entries for Linux %s", (targetCpu) => {
    expect(
      parseArguments([
        "--source-root",
        "/source",
        "--destination-root",
        "/destination",
        "--entry",
        "@elizaos/agent",
        "--entry",
        "@elizaos/app-core",
        "--stub",
        "@elizaos/plugin-whatsapp",
        "--bun",
        "bun-custom",
        "--node",
        "node-custom",
        "--npm",
        "npm-custom",
        "--target-os",
        "linux",
        "--target-cpu",
        targetCpu,
      ]),
    ).toEqual({
      sourceRoot: "/source",
      destinationRoot: "/destination",
      entryPackages: ["@elizaos/agent", "@elizaos/app-core"],
      stubPackages: ["@elizaos/plugin-whatsapp"],
      bunCommand: "bun-custom",
      nodeCommand: "node-custom",
      npmCommand: "npm-custom",
      targetOs: "linux",
      targetCpu,
    });
    expect(() => parseArguments(["--source-root", "/source"])).toThrow(
      /destination-root/,
    );
  });
});
