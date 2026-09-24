/** Verifies Android build-host and clean-checkout front-door contracts. */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir as systemTmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertApkProvenanceEntries,
  assertBuilderCapacity,
  assertBundleOutputLocation,
  assertClosedAospSourceRoot,
  assertSafeFlashMetadata,
  collectGrizzlyArtifacts,
  hashDirectoryTree,
  parseArgs as parseBundleArgs,
  parseFastbootInfoArtifacts,
  REQUIRED_APK_PROVENANCE,
  REQUIRED_GRIZZLY_ARTIFACTS,
  requireResolvedManifestContract,
  selectedManifestPath,
} from "../aosp/build-grizzly-bundle.mjs";
import {
  loadPhysicalTargetContract,
  parseArgs as parseDeployArgs,
  resolveBuiltPrivilegedApk,
} from "../aosp/deploy-pixel.mjs";
import {
  parseAgentServiceProcessState,
  parseSmokeArgs,
} from "../aosp/smoke-cuttlefish.mjs";
import {
  assertAndroidSetupState,
  parseAdbDevicesOutput,
  selectBrandDeviceSerial,
} from "../distro-android/boot-validate.mjs";
import {
  assertExtractedVendorTree,
  assertGeneratedVendorTree,
  assertPinnedAospCheckout,
  loadAospLock,
  parseBootstrapArgs,
  verifyProprietaryArchive,
} from "../distro-android/bootstrap-aosp.mjs";
import { loadBrandConfig } from "../distro-android/brand-config.mjs";
import {
  aospBuildEnvironment,
  assertBuildHost,
  closeAospBuildEnvironment,
  cuttlefishLaunchCommand,
  prepareAospBuildEnvironment,
  resolveCuttlefishGpuMode,
  revalidateAospBuildEnvironment,
} from "../distro-android/build-aosp.mjs";
import {
  GRAPHICS_PROBES,
  parseArgs as parseGraphicsEvidenceArgs,
  probeSucceeded,
} from "../distro-android/collect-grizzly-graphics.mjs";
import {
  normalizeGeneratedBringupProbes,
  normalizeGeneratedRenderEngine,
  parseArgs as parseGrizzlyArgs,
} from "../distro-android/prepare-grizzly.mjs";
import { loadCuttlefishE1Lock } from "../distro-android/provision-cuttlefish-e1.mjs";
import { withSisoCompatibility } from "../distro-android/siso-env.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

const validGrizzlyFastbootInfo = [
  "version 1",
  "flash boot",
  "flash init_boot",
  "flash dtbo",
  "flash vendor_kernel_boot",
  "flash pvmfw",
  "flash vendor_boot",
  "flash --apply-vbmeta vbmeta",
  "reboot fastboot",
  "update-super",
  "flash system",
  "flash system_dlkm",
  "flash system_ext",
  "flash product",
  "flash vendor",
  "flash vendor_dlkm",
  "flash --slot-other system system_other.img",
  "if-wipe erase userdata",
  "reboot",
  "",
].join("\n");

function activeProductCompositionLines(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(
      (line) =>
        /\binherit-product(?:-if-exists)?\b/.test(line) ||
        /^-?include(?:\s|$)/.test(line),
    );
}

async function createGitFixture(root: string, files: string[]) {
  await mkdir(root, { recursive: true });
  for (const file of files) {
    const destination = join(root, file);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, "fixture\n");
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=elizaOS test",
      "-c",
      "user.email=test@elizaos.ai",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: root },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

// Production intentionally rejects pathname aliases. macOS exposes its temp
// directory through /var -> /private/var; fixtures must use canonical roots.
function tmpdir() {
  return fs.realpathSync(systemTmpdir());
}

describe("AOSP build contracts", () => {
  test("AOSP builds keep temporary artifacts on the default output volume", () => {
    expect(
      aospBuildEnvironment("/srv/aosp", {
        SISO_EXPERIMENTS: "oom-score-adj",
        TMPDIR: "/tmp",
      }),
    ).toMatchObject({
      SISO_EXPERIMENTS: "oom-score-adj,ignore-missing-targets",
      TMPDIR: "/srv/aosp/out/.elizaos-tmp",
      TMP: "/srv/aosp/out/.elizaos-tmp",
      TEMP: "/srv/aosp/out/.elizaos-tmp",
    });
  });

  test("AOSP build temporary artifacts follow absolute and relative OUT_DIR", async () => {
    const root = await mkdtemp(join(tmpdir(), "elizaos-aosp-root-"));
    const external = await mkdtemp(join(tmpdir(), "elizaos-aosp-out-"));
    const prepared: ReturnType<typeof prepareAospBuildEnvironment>[] = [];
    try {
      const absolute = prepareAospBuildEnvironment(root, {
        OUT_DIR: external,
      });
      prepared.push(absolute);
      expect(absolute.env.TMPDIR).toBe(join(external, ".elizaos-tmp"));
      expect(absolute.env.OUT_DIR).toBe(external);

      const relative = prepareAospBuildEnvironment(root, {
        OUT_DIR: "build-output",
      });
      prepared.push(relative);
      expect(relative.env.TMPDIR).toBe(
        join(root, "build-output", ".elizaos-tmp"),
      );
      expect(relative.env.OUT_DIR).toBe(join(root, "build-output"));
      revalidateAospBuildEnvironment(absolute);
      revalidateAospBuildEnvironment(relative);
    } finally {
      for (const build of prepared) closeAospBuildEnvironment(build);
      await rm(root, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  test("AOSP build temporary artifacts accept a stable symlinked out directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "elizaos-aosp-root-"));
    const external = await mkdtemp(join(tmpdir(), "elizaos-aosp-out-"));
    let prepared: ReturnType<typeof prepareAospBuildEnvironment> | undefined;
    try {
      await symlink(external, join(root, "out"), "dir");
      prepared = prepareAospBuildEnvironment(root, {});
      expect(prepared.env.OUT_DIR).toBe(external);
      expect(prepared.env.TMPDIR).toBe(join(external, ".elizaos-tmp"));
      revalidateAospBuildEnvironment(prepared);
    } finally {
      if (prepared) closeAospBuildEnvironment(prepared);
      await rm(root, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  test("AOSP build wrapper mirrors OUT_DIR_COMMON_BASE semantics", () => {
    expect(
      aospBuildEnvironment("/srv/aosp", {
        OUT_DIR_COMMON_BASE: "/build/common",
      }),
    ).toMatchObject({
      OUT_DIR: "/build/common/aosp",
      OUT_DIR_COMMON_BASE: "/build/common",
      TMPDIR: "/build/common/aosp/.elizaos-tmp",
    });
    expect(
      aospBuildEnvironment("/srv/aosp", {
        OUT_DIR_COMMON_BASE: "build/common",
      }),
    ).toMatchObject({
      OUT_DIR: "/srv/aosp/build/common/aosp",
      OUT_DIR_COMMON_BASE: "build/common",
      TMPDIR: "/srv/aosp/build/common/aosp/.elizaos-tmp",
    });
  });

  test("AOSP build wrapper rejects empty output variables", () => {
    expect(() =>
      aospBuildEnvironment("/srv/aosp", {
        OUT_DIR: "   ",
      }),
    ).toThrow("OUT_DIR must be a non-empty path when set");
    expect(() =>
      aospBuildEnvironment("/srv/aosp", {
        OUT_DIR_COMMON_BASE: "",
      }),
    ).toThrow("OUT_DIR_COMMON_BASE must be a non-empty path when set");
  });

  test("AOSP build wrapper gives a present OUT_DIR precedence", () => {
    expect(
      aospBuildEnvironment("/srv/aosp", {
        OUT_DIR: "build-output",
        OUT_DIR_COMMON_BASE: "/build/common",
      }),
    ).toMatchObject({
      OUT_DIR: "/srv/aosp/build-output",
      OUT_DIR_COMMON_BASE: "/build/common",
      TMPDIR: "/srv/aosp/build-output/.elizaos-tmp",
    });
  });

  test("AOSP builds reject a temporary-directory symlink outside the checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "elizaos-aosp-root-"));
    const external = await mkdtemp(join(tmpdir(), "elizaos-aosp-external-"));
    try {
      await mkdir(join(root, "out"), { recursive: true });
      await symlink(external, join(root, "out", ".elizaos-tmp"), "dir");
      expect(() => prepareAospBuildEnvironment(root, {})).toThrow(
        "must be a real directory",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  test("AOSP builds prepare a private temporary directory inside the checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "elizaos-aosp-root-"));
    let prepared: ReturnType<typeof prepareAospBuildEnvironment> | undefined;
    try {
      await mkdir(join(root, "out", ".elizaos-tmp"), { recursive: true });
      await chmod(join(root, "out", ".elizaos-tmp"), 0o777);
      prepared = prepareAospBuildEnvironment(root, {});
      const state = await lstat(prepared.env.TMPDIR);
      expect(state.isDirectory()).toBe(true);
      expect(state.isSymbolicLink()).toBe(false);
      expect(state.mode & 0o777).toBe(0o700);
      revalidateAospBuildEnvironment(prepared);
    } finally {
      if (prepared) closeAospBuildEnvironment(prepared);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("AOSP builds reject permissive output roots and replaced temp paths", async () => {
    const permissiveRoot = await mkdtemp(join(tmpdir(), "elizaos-aosp-root-"));
    const raceRoot = await mkdtemp(join(tmpdir(), "elizaos-aosp-root-"));
    let prepared: ReturnType<typeof prepareAospBuildEnvironment> | undefined;
    try {
      await mkdir(join(permissiveRoot, "out"));
      await chmod(join(permissiveRoot, "out"), 0o777);
      expect(() => prepareAospBuildEnvironment(permissiveRoot, {})).toThrow(
        "must not be group- or other-writable",
      );

      prepared = prepareAospBuildEnvironment(raceRoot, {});
      const displaced = join(raceRoot, "out", ".elizaos-tmp-displaced");
      await rename(prepared.canonicalTemp, displaced);
      await mkdir(prepared.canonicalTemp, { mode: 0o700 });
      expect(() => revalidateAospBuildEnvironment(prepared)).toThrow(
        "temporary path identity changed",
      );
    } finally {
      if (prepared) closeAospBuildEnvironment(prepared);
      await rm(permissiveRoot, { recursive: true, force: true });
      await rm(raceRoot, { recursive: true, force: true });
    }
  });

  test("AOSP builds hold and revalidate every trusted output ancestor", async () => {
    const unsafeParent = await mkdtemp(
      join(tmpdir(), "elizaos-aosp-unsafe-parent-"),
    );
    const nestedRoot = join(unsafeParent, "checkout");
    const raceRoot = await mkdtemp(join(tmpdir(), "elizaos-aosp-root-"));
    let prepared: ReturnType<typeof prepareAospBuildEnvironment> | undefined;
    try {
      await mkdir(nestedRoot);
      await chmod(unsafeParent, 0o777);
      expect(() => prepareAospBuildEnvironment(nestedRoot, {})).toThrow(
        "must not be group- or other-writable",
      );

      prepared = prepareAospBuildEnvironment(raceRoot, {});
      expect(prepared.outputPathHandles.length).toBeGreaterThan(2);
      await chmod(raceRoot, 0o777);
      expect(() => revalidateAospBuildEnvironment(prepared)).toThrow(
        "must not be group- or other-writable",
      );
    } finally {
      if (prepared) closeAospBuildEnvironment(prepared);
      await chmod(unsafeParent, 0o700);
      await chmod(raceRoot, 0o700);
      await rm(unsafeParent, { recursive: true, force: true });
      await rm(raceRoot, { recursive: true, force: true });
    }
  });

  test("AOSP build preparation closes held descriptors after an fstat failure", () => {
    const root = fs.mkdtempSync(join(tmpdir(), "elizaos-aosp-fd-"));
    const originalFstat = fs.fstatSync;
    const observedDescriptors = new Set<number>();
    let calls = 0;
    fs.fstatSync = (fd) => {
      observedDescriptors.add(fd);
      calls += 1;
      if (calls === 4) throw new Error("injected fstat failure");
      return originalFstat(fd);
    };
    try {
      expect(() => prepareAospBuildEnvironment(root, {})).toThrow(
        "injected fstat failure",
      );
    } finally {
      fs.fstatSync = originalFstat;
    }
    try {
      expect(calls).toBe(4);
      expect(observedDescriptors.size).toBeGreaterThan(0);
      // Check the actual descriptors, including held ancestors, without
      // relying on Linux /proc or pathname aliases in readlink output.
      for (const descriptor of observedDescriptors) {
        expect(() => originalFstat(descriptor)).toThrow(
          /bad file descriptor|EBADF/i,
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("agent smoke distinguishes a running service from a pending record", () => {
    expect(
      parseAgentServiceProcessState(
        `ACTIVITY MANAGER SERVICES\n  * ServiceRecord{abc u0 ai.elizaos.app/.ElizaAgentService c:com.android.shell}\n    packageName=ai.elizaos.app\n    app=null\n  * ServiceRecord{def u0 ai.elizaos.app/.ElizaVoiceInteractionService c:android}\n    app=ProcessRecord{123 ai.elizaos.app/u0a1}`,
        "ai.elizaos.app",
      ),
    ).toBe("pending");
    expect(
      parseAgentServiceProcessState(
        `ACTIVITY MANAGER SERVICES\n  * ServiceRecord{abc u0 ai.elizaos.app/.ElizaAgentService c:android}\n    packageName=ai.elizaos.app\n    app=ProcessRecord{123 ai.elizaos.app/u0a1}`,
        "ai.elizaos.app",
      ),
    ).toBe("running");
    expect(
      parseAgentServiceProcessState(
        "ACTIVITY MANAGER SERVICES (dumpsys activity services)",
        "ai.elizaos.app",
      ),
    ).toBe("missing");
  });

  test("boot validation selects the branded Cuttlefish device, not an attached stock phone", () => {
    expect(
      parseAdbDevicesOutput(
        "List of devices attached\n66010DLKX00E5X\tdevice product:grizzly\n0.0.0.0:6520\tdevice product:vsoc_x86_64\noffline-cvd\toffline\n",
      ),
    ).toEqual([
      { serial: "66010DLKX00E5X", state: "device" },
      { serial: "0.0.0.0:6520", state: "device" },
      { serial: "offline-cvd", state: "offline" },
    ]);

    expect(
      selectBrandDeviceSerial(
        [
          {
            serial: "66010DLKX00E5X",
            state: "device",
            product: null,
          },
          {
            serial: "0.0.0.0:6520",
            state: "device",
            product: "eliza_cf_x86_64_phone",
          },
        ],
        "eliza_cf_x86_64_phone",
      ),
    ).toBe("0.0.0.0:6520");
    expect(() =>
      selectBrandDeviceSerial(
        [
          {
            serial: "0.0.0.0:6520",
            state: "device",
            product: "eliza_cf_x86_64_phone",
          },
          {
            serial: "0.0.0.0:6521",
            state: "device",
            product: "eliza_cf_x86_64_phone",
          },
        ],
        "eliza_cf_x86_64_phone",
      ),
    ).toThrow("Multiple booted devices");
  });

  test("Android 17 Siso builds tolerate generated missing targets", () => {
    expect(withSisoCompatibility({})).toMatchObject({
      SISO_EXPERIMENTS: "ignore-missing-targets",
    });
    expect(
      withSisoCompatibility({ SISO_EXPERIMENTS: "oom-score-adj" }),
    ).toMatchObject({
      SISO_EXPERIMENTS: "oom-score-adj,ignore-missing-targets",
    });
    expect(
      withSisoCompatibility({
        SISO_EXPERIMENTS: "ignore-missing-targets,oom-score-adj",
      }),
    ).toMatchObject({
      SISO_EXPERIMENTS: "ignore-missing-targets,oom-score-adj",
    });
  });

  test("the Make front door rebuilds the privileged APK", () => {
    const makefile = readFileSync(
      join(repositoryRoot, "android/Makefile"),
      "utf8",
    );

    expect(makefile).toContain("--rebuild-privileged-apk");
    expect(makefile).toContain("ELIZA_BUN_RISCV64_OPTIONAL=1");
    expect(makefile).toContain("filter riscv64,$(ARCH)");
    expect(makefile).toContain("native-inference");
    expect(makefile).toContain("$(HERE)/..");
    expect(makefile).not.toContain("$(HERE)/../../../..");
    expect(makefile).toContain("android-arm64-cpu-fused");
    expect(makefile).not.toContain("android-arm64-vulkan-fused");
    expect(makefile).toContain("android-x86_64-cpu-fused");
    expect(makefile).toContain("android-riscv64-cpu-fused");
    expect(makefile).toContain("--assets-dir");
    expect(makefile).toContain("bootstrap-aosp.mjs");
    expect(makefile).toContain("provision-repo.sh");
    expect(makefile).toContain('--repo-bin "$(REPO_LAUNCHER)"');
    expect(makefile).toContain("stage-elizavoice-lib.mjs");
    expect(makefile).toContain("bundle-grizzly:");
    expect(makefile).toContain("build-grizzly-bundle.mjs");
    expect(makefile).toContain('test -n "$$SOURCE_DATE_EPOCH"');
    expect(makefile).toContain('test -n "$(BUNDLE_DIR)"');
    expect(makefile).not.toContain("ELIZA_MTP_ANDROID_LIBDIR");
  });

  test("canonical Cuttlefish products use only pinned product inputs", () => {
    const productsRoot = join(repositoryRoot, "android/vendor/eliza/products");
    const commonProduct = readFileSync(
      join(repositoryRoot, "android/vendor/eliza/eliza_common.mk"),
      "utf8",
    );
    expect(activeProductCompositionLines(commonProduct)).toEqual([]);
    expect(commonProduct).not.toMatch(/device\/eliza\/|cuttlefish_e1/);
    const deviceProducts = {
      x86_64: "vsoc_x86_64_only",
      arm64: "vsoc_arm64",
      riscv64: "vsoc_riscv64",
    } as const;
    for (const [architecture, deviceProduct] of Object.entries(
      deviceProducts,
    )) {
      const product = readFileSync(
        join(productsRoot, `eliza_cf_${architecture}_phone.mk`),
        "utf8",
      );
      expect(product).not.toMatch(/device\/eliza\/|cuttlefish_e1/);
      const expectedComposition = [
        `$(call inherit-product, device/google/cuttlefish/${deviceProduct}/phone/aosp_cf.mk)`,
        "$(call inherit-product, vendor/eliza/eliza_common.mk)",
      ];
      expect(activeProductCompositionLines(product)).toEqual(
        expectedComposition,
      );
      for (const forbiddenDirective of [
        "$(call inherit-product-if-exists, device/eliza/cuttlefish_e1/eliza_e1_cuttlefish.mk)",
        "include device/eliza/cuttlefish_e1/eliza_e1_cuttlefish.mk",
        "-include device/eliza/cuttlefish_e1/eliza_e1_cuttlefish.mk",
      ]) {
        expect(
          activeProductCompositionLines(`${product}\n${forbiddenDirective}`),
        ).toEqual([...expectedComposition, forbiddenDirective]);
      }
    }
  });

  test("the Cuttlefish source lock fails closed on project or path drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "elizaos-cuttlefish-lock-"));
    try {
      const manifestCommit = await createGitFixture(
        join(root, ".repo/manifests"),
        ["default.xml"],
      );
      const projectPath = "device/google/cuttlefish";
      const requiredSourceFiles = [
        `${projectPath}/vsoc_arm64/phone/aosp_cf.mk`,
        `${projectPath}/vsoc_x86_64_only/phone/aosp_cf.mk`,
        `${projectPath}/vsoc_riscv64/phone/aosp_cf.mk`,
      ];
      const projectCommit = await createGitFixture(
        join(root, projectPath),
        requiredSourceFiles.map((file) => file.slice(projectPath.length + 1)),
      );
      const lock = {
        manifestCommit,
        manifestRevision: "fixture",
        projects: [{ path: projectPath, commit: projectCommit }],
        requiredSourceFiles,
      };

      expect(assertPinnedAospCheckout(root, lock)).toBe(manifestCommit);
      expect(() =>
        assertPinnedAospCheckout(root, {
          ...lock,
          projects: [{ path: projectPath, commit: "0".repeat(40) }],
        }),
      ).toThrow("AOSP project mismatch");
      expect(() =>
        assertPinnedAospCheckout(root, {
          ...lock,
          requiredSourceFiles: [
            ...requiredSourceFiles,
            `${projectPath}/missing/aosp_cf.mk`,
          ],
        }),
      ).toThrow("missing required AOSP source path");
      await writeFile(join(root, requiredSourceFiles[0]), "locally modified\n");
      expect(() => assertPinnedAospCheckout(root, lock)).toThrow(
        "locked AOSP project is dirty",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the full AOSP checkout has an immutable bootstrap lock", () => {
    expect(loadAospLock()).toEqual({
      schemaVersion: 1,
      manifestUrl: "https://android.googlesource.com/platform/manifest",
      manifestRevision: "android-17.0.0_r1",
      manifestTagObject: "7a9e46ba6ed424f922a3457f4964e67e0b966201",
      manifestCommit: "5bc9a7ce1cd78dd53613bbfd0ebf506e1e4adb0f",
      projects: [
        {
          path: "device/google/cuttlefish",
          name: "device/google/cuttlefish",
          tagObject: "fc81d4d790cf71b00c17dbcb476c9cf05279f3ff",
          commit: "283645aacf6cdb56cc31a9362f54d412dbc132a1",
        },
      ],
      requiredSourceFiles: [
        "device/google/cuttlefish/vsoc_arm64/phone/aosp_cf.mk",
        "device/google/cuttlefish/vsoc_x86_64_only/phone/aosp_cf.mk",
        "device/google/cuttlefish/vsoc_riscv64/phone/aosp_cf.mk",
      ],
    });
    expect(
      parseBootstrapArgs([
        "--aosp-root",
        "/tmp/aosp",
        "--jobs",
        "3",
        "--repo-bin",
        "repo",
        "--init-only",
      ]),
    ).toMatchObject({
      aospRoot: "/tmp/aosp",
      jobs: 3,
      initOnly: true,
      repoBin: "repo",
    });
    expect(() =>
      parseBootstrapArgs(["--aosp-root", "/tmp/aosp", "--jobs", "0"]),
    ).toThrow("--jobs must be an integer from 1 through 256");
    expect(() =>
      parseBootstrapArgs(["--aosp-root", "/tmp/aosp", "--jobs", "2x"]),
    ).toThrow("--jobs must be a positive integer");

    const repoProvisioner = readFileSync(
      join(repositoryRoot, "scripts/distro-android/provision-repo.sh"),
      "utf8",
    );
    expect(repoProvisioner).toContain(
      'repo_url="https://storage.googleapis.com/git-repo-downloads/repo"',
    );
    expect(repoProvisioner).toContain(
      'repo_sha256="1211b57b57e4122a9c546295a59b37d24068f1164d0e87bef096d5323c413e4f"',
    );
    const bootstrapSource = readFileSync(
      join(repositoryRoot, "scripts/distro-android/bootstrap-aosp.mjs"),
      "utf8",
    );
    expect(bootstrapSource).toContain('"--retry-fetches=5"');
  });

  test("licensed Pixel vendor inputs are verified by bytes, digest, and extraction", async () => {
    const root = await mkdtemp(join(tmpdir(), "elizaos-pixel-contract-"));
    try {
      const bytes = Buffer.from("licensed vendor fixture");
      const filename = "vendor-fixture.tgz";
      const archivePath = join(root, filename);
      await writeFile(archivePath, bytes);
      const requiredPath = "vendor/google_devices/tegu/Android.bp";
      const lock = {
        proprietaryArchive: {
          filename,
          sizeBytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          requiredExtractedFiles: [requiredPath],
        },
      };

      await expect(
        verifyProprietaryArchive(lock, archivePath),
      ).resolves.toMatchObject({
        sizeBytes: bytes.byteLength,
        sha256: lock.proprietaryArchive.sha256,
      });
      expect(() => assertExtractedVendorTree(root, lock)).toThrow(
        "licensed vendor extraction is incomplete",
      );
      await mkdir(join(root, "vendor/google_devices/tegu"), {
        recursive: true,
      });
      await writeFile(join(root, requiredPath), "// fixture");
      expect(assertExtractedVendorTree(root, lock)).toEqual([requiredPath]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the AOSP product does not ship the unwired SystemUI bridge scaffold", () => {
    const common = readFileSync(
      join(repositoryRoot, "android/vendor/eliza/eliza_common.mk"),
      "utf8",
    );
    expect(common).not.toContain("ElizaSystemBridge");
    expect(common).not.toContain("ai.elizaos.system.bridge");
    expect(
      existsSync(join(repositoryRoot, "android/system-ui/package.json")),
    ).toBe(false);
  });

  test("Cuttlefish extends the Soong system image with elizaOS modules", () => {
    const vendorRoot = join(repositoryRoot, "android/vendor/eliza");
    const systemImage = readFileSync(join(vendorRoot, "Android.bp"), "utf8");

    expect(systemImage).toContain('name: "eliza_aosp_shared_system_image"');
    expect(systemImage).toContain('defaults: ["system_image_defaults"]');
    expect(systemImage).toContain('"Eliza"');
    expect(systemImage).toContain('"default-permissions-ai.elizaos.app.xml"');
    expect(systemImage).toContain('"privapp-permissions-ai.elizaos.app.xml"');

    for (const product of [
      "eliza_cf_arm64_phone",
      "eliza_cf_riscv64_e1_phone",
      "eliza_cf_riscv64_phone",
      "eliza_cf_x86_64_phone",
    ]) {
      const productMakefile = readFileSync(
        join(vendorRoot, `products/${product}.mk`),
        "utf8",
      );
      expect(productMakefile).toContain(
        "PRODUCT_SOONG_DEFINED_SYSTEM_IMAGE := eliza_aosp_shared_system_image",
      );
    }
  });

  test("the E1 Cuttlefish simulator is a separately locked product", () => {
    const lockPath = join(repositoryRoot, "android/cuttlefish-e1.lock.json");
    const lock = loadCuttlefishE1Lock(lockPath);
    expect(lock.source).toMatchObject({
      url: "https://github.com/elizaOS/research.git",
      ref: "refs/heads/main",
      commit: "2296b67262e629286a2df7ff5087bf141a66c83f",
      root: "chip/sw/aosp-device",
    });
    expect(lock.trees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "device/eliza/eliza_ai_soc",
          destination: "device/eliza/eliza_ai_soc",
        }),
        expect.objectContaining({
          source: "device/eliza/cuttlefish_e1",
          destination: "device/eliza/cuttlefish_e1",
          requiredFiles: expect.arrayContaining(["eliza_e1_cuttlefish.mk"]),
        }),
      ]),
    );
    expect(lock.license.requiredFiles).toContain(
      "device/eliza/eliza_ai_soc/hal/e1_npu_sim/Android.bp",
    );

    const e1Brand = loadBrandConfig(
      join(
        repositoryRoot,
        "scripts/distro-android/brand.eliza-riscv64-e1.json",
      ),
    );
    expect(e1Brand).toMatchObject({
      productName: "eliza_cf_riscv64_e1_phone",
      aospDeviceOverlay: "android/cuttlefish-e1.lock.json",
    });
    const products = readFileSync(
      join(repositoryRoot, "android/vendor/eliza/AndroidProducts.mk"),
      "utf8",
    );
    expect(products).toContain("eliza_cf_riscv64_e1_phone.mk");
    for (const architecture of ["arm64", "x86_64", "riscv64"]) {
      const canonical = readFileSync(
        join(
          repositoryRoot,
          `android/vendor/eliza/products/eliza_cf_${architecture}_phone.mk`,
        ),
        "utf8",
      );
      expect(canonical).not.toContain("cuttlefish_e1");
      expect(canonical).not.toContain("ELIZA_ENABLE_E1_NPU_SIM");
    }
  });

  test("the AOSP product does not ship placeholder confidential-compute claims", () => {
    const vendorRoot = join(repositoryRoot, "android/vendor/eliza");
    const common = readFileSync(join(vendorRoot, "eliza_common.mk"), "utf8");
    const init = readFileSync(join(vendorRoot, "init/init.eliza.rc"), "utf8");

    for (const deadClaim of [
      "eliza_pvm_mgr",
      "tee-measurements.json",
      "tee-policy.json",
    ]) {
      expect(common).not.toContain(deadClaim);
      expect(init).not.toContain(deadClaim);
    }
    expect(existsSync(join(vendorRoot, "pvm_mgr"))).toBe(false);
    expect(existsSync(join(vendorRoot, "tee"))).toBe(false);
    expect(existsSync(join(vendorRoot, "sepolicy/eliza_pvm_mgr.te"))).toBe(
      false,
    );
  });

  test("the product menu exposes only source-pinned physical targets", () => {
    const products = readFileSync(
      join(repositoryRoot, "android/vendor/eliza/AndroidProducts.mk"),
      "utf8",
    );
    for (const absentTarget of [
      "openagent",
      "oriole",
      "panther",
      "shiba",
      "caiman",
    ]) {
      expect(products).not.toContain(absentTarget);
    }
    expect(products).toContain("eliza_tegu_phone");
    expect(products).toContain("eliza_grizzly_phone");
    expect(existsSync(join(repositoryRoot, "android/pixel9a.lock.json"))).toBe(
      true,
    );
    const grizzlyLockPath = join(
      repositoryRoot,
      "android/pixel11pro.lock.json",
    );
    expect(existsSync(grizzlyLockPath)).toBe(true);
    const inventory = JSON.parse(
      readFileSync(
        join(repositoryRoot, "android/hardware-targets.json"),
        "utf8",
      ),
    ) as {
      targets: Array<{
        targetId: string;
        sourceStatus: string;
        installerEligible: boolean;
      }>;
    };
    expect(inventory.targets).toContainEqual(
      expect.objectContaining({
        targetId: "pixel9a-tegu",
        sourceStatus: "pinned",
        installerEligible: false,
      }),
    );
    expect(inventory.targets).toContainEqual(
      expect.objectContaining({
        targetId: "pixel11pro-grizzly",
        sourceStatus: "pinned-generated",
        installerEligible: false,
      }),
    );
    const pixelLock = JSON.parse(
      readFileSync(join(repositoryRoot, "android/pixel9a.lock.json"), "utf8"),
    ) as {
      device: {
        productBrand: string;
        productName: string;
        codename: string;
        expectedFingerprintPrefix: string;
      };
    };
    const pixelProduct = readFileSync(
      join(repositoryRoot, "android/vendor/eliza/products/eliza_tegu_phone.mk"),
      "utf8",
    );
    const commonProduct = readFileSync(
      join(repositoryRoot, "android/vendor/eliza/eliza_common.mk"),
      "utf8",
    );
    expect(pixelProduct).toContain(
      `PRODUCT_NAME := ${pixelLock.device.productName}`,
    );
    expect(pixelProduct).toContain(
      `PRODUCT_DEVICE := ${pixelLock.device.codename}`,
    );
    expect(commonProduct).toContain(
      `PRODUCT_BRAND := ${pixelLock.device.productBrand}`,
    );
    expect(commonProduct).toContain("PRODUCT_MANUFACTURER := elizaOS");
    expect(pixelProduct).not.toContain("PRODUCT_BRAND :=");
    expect(pixelProduct).not.toContain("PRODUCT_MANUFACTURER :=");
    expect(pixelLock.device.expectedFingerprintPrefix).toBe(
      `${pixelLock.device.productBrand}/${pixelLock.device.productName}/${pixelLock.device.codename}:`,
    );
    const grizzlyLock = loadAospLock(grizzlyLockPath);
    expect(grizzlyLock.device).toMatchObject({
      targetId: "pixel11pro-grizzly",
      codename: "grizzly",
      buildId: "CD1A.260714.001.A9",
      productName: "eliza_grizzly_phone",
    });
    expect(grizzlyLock.externalProjects).toHaveLength(3);
    expect(grizzlyLock.externalProjects).toContainEqual(
      expect.objectContaining({
        path: "tools/arsclib",
        commit: "a67388430c8319f4c7066626e340b5c4d7f27882",
      }),
    );
    expect(grizzlyLock.sourceOverlays).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "frameworks/base/tools/aapt2/BriefPackageInfo.proto",
          sourceCommit: "b2be3bb5f88bc5833dd4f9a11b3c295259ae733f",
          baseSha256: null,
        }),
        expect.objectContaining({
          path: "frameworks/base/tools/aapt2/Configuration.proto",
          sha256:
            "9161de5a4711e574e8e38457938ab3b10ba5445874106a0bf1b22dcd739f51ed",
        }),
        expect.objectContaining({
          path: "frameworks/base/tools/aapt2/cmd/Convert.cpp",
          sha256:
            "df70b3a1420e5d0e4e8407714cee5cbee14f91c7f6dc6f41f5b08910a88858ad",
        }),
        expect.objectContaining({
          path: "frameworks/base/tools/aapt2/format/proto/ProtoSerialize.cpp",
          sha256:
            "b348a29437cbe7974c7fd10dc22227c903d3866c9f4184ce5c6a87f5692cdf46",
        }),
        expect.objectContaining({
          path: "frameworks/base/tools/aapt2/cmd/Dump.cpp",
          sha256:
            "1a0414d6af278aaf138d98c53d7fee10a185a480241d037e5748eb0465055518",
        }),
        expect.objectContaining({
          path: "tools/apksig/src/apksigner/java/com/android/apksigner/ApkSignerTool.java",
          sourceCommit: "ba4d984e1a360d427307d669d2f789212130e9e8",
          sha256:
            "8604499845681d82c69e25ed516127c8bb03ce2a7525e1cb5b1293bdf5aea7c7",
        }),
      ]),
    );
    expect(grizzlyLock.referenceFactoryImage).toMatchObject({
      sizeBytes: 15363261784,
      sha256:
        "86fb81516d54a21c28487745e748aee8e36847dc400a6ab40ef2458146b0becb",
    });
    expect(grizzlyLock.rollbackFactoryImage).toMatchObject({
      buildId: "CD1A.260714.001.A9",
      sha256:
        "86fb81516d54a21c28487745e748aee8e36847dc400a6ab40ef2458146b0becb",
    });
    expect(grizzlyLock.generatedVendor?.requiredFiles).toEqual(
      expect.arrayContaining([
        "vendor/google_devices/grizzly/proprietary/Android.bp",
        "vendor/google_devices/grizzly/stock-kernel/Image.lz4",
        "vendor/google_devices/grizzly/stock-kernel/modules.load",
        "vendor/google_devices/grizzly/stock-kernel/system_dlkm.modules.load",
        "vendor/google_devices/grizzly/stock-kernel/vendor_dlkm.modules.load",
        "vendor/google_devices/grizzly/stock-kernel/vendor_kernel_boot.modules.load",
      ]),
    );
    expect(grizzlyLock.generatedVendor?.requiredArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "vendor/google_devices/grizzly/stock-kernel/Image.lz4",
          sizeBytes: 20230712,
          sha256:
            "b456e2b874e4cc2a2fd208d4c7e4bd2fd52dc29c6727fb81052d16bc8da86ae3",
        }),
        expect.objectContaining({
          path: "vendor/google_devices/grizzly/stock-kernel/dtbo.img",
          sizeBytes: 11415225,
          sha256:
            "684473615efc85ffd63e377fe5428a88ce9a3e96ae6e33b26da93bd8ecb516c4",
        }),
      ]),
    );
    const grizzlyProduct = readFileSync(
      join(
        repositoryRoot,
        "android/vendor/eliza/products/eliza_grizzly_phone.mk",
      ),
      "utf8",
    );
    expect(grizzlyProduct).toContain("USE_STOCK_KERNEL := true");
    expect(grizzlyProduct).toContain(
      "vendor/google_devices/grizzly/grizzly.mk",
    );
    expect(grizzlyProduct).toContain("PRODUCT_NAME := eliza_grizzly_phone");
    expect(
      parseGrizzlyArgs(["--aosp-root", "/tmp/aosp-grizzly"]),
    ).toMatchObject({
      aospRoot: "/tmp/aosp-grizzly",
      lockPath: grizzlyLockPath,
      skipInstall: false,
      skipRollbackDownload: false,
    });
    expect(
      existsSync(
        join(repositoryRoot, "scripts/distro-android/brand.openagent.json"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(
          repositoryRoot,
          "android/vendor/eliza/products/eliza_openagent_ai_soc_phone.mk",
        ),
      ),
    ).toBe(false);
  });

  test("generated Pixel support verifies pinned firmware text invariants", async () => {
    const root = await mkdtemp(join(tmpdir(), "elizaos-grizzly-contract-"));
    try {
      const lock = loadAospLock(
        join(repositoryRoot, "android/pixel11pro.lock.json"),
      );
      const fixtureLock = structuredClone(lock);
      const generatedFixture = "generated fixture\n";
      fixtureLock.generatedVendor.requiredArtifacts = [
        {
          path: "vendor/google_devices/grizzly/stock-kernel/Image.lz4",
          sizeBytes: Buffer.byteLength(generatedFixture),
          sha256: createHash("sha256").update(generatedFixture).digest("hex"),
        },
      ];
      for (const requiredPath of lock.generatedVendor.requiredFiles) {
        const destination = join(root, requiredPath);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, "generated fixture\n");
      }
      for (const entry of lock.generatedVendor.requiredTextFiles) {
        await writeFile(
          join(root, entry.path),
          `${entry.includes.join("\n")}\n`,
        );
      }
      expect(assertGeneratedVendorTree(root, fixtureLock)).toHaveLength(
        lock.generatedVendor.requiredFiles.length,
      );
      const firmwareContract = lock.generatedVendor.requiredTextFiles.find(
        (entry) => entry.path.endsWith("/firmware/android-info.txt"),
      );
      await writeFile(join(root, firmwareContract.path), "wrong firmware\n");
      expect(() => assertGeneratedVendorTree(root, fixtureLock)).toThrow(
        /generated vendor contract mismatch/,
      );
      await writeFile(
        join(root, firmwareContract.path),
        `${firmwareContract.includes.join("\n")}\n`,
      );
      await writeFile(
        join(root, fixtureLock.generatedVendor.requiredArtifacts[0].path),
        "wrong artifact\n",
      );
      expect(() => assertGeneratedVendorTree(root, fixtureLock)).toThrow(
        /generated vendor artifact mismatch/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Pixel bring-up diagnostics preserve init ordering and module readiness", async () => {
    const root = await mkdtemp(join(tmpdir(), "elizaos-grizzly-debug-init-"));
    const generatedRoot = join(root, "vendor/google_devices/grizzly");
    const initPath = join(
      generatedRoot,
      "proprietary/vendor/etc/init/hw/init.grizzly.rc",
    );
    const malibuInitPath = join(
      generatedRoot,
      "proprietary/vendor/etc/init/hw/init.malibu.rc",
    );
    const usbInitPath = join(
      generatedRoot,
      "proprietary/vendor/etc/init/hw/init.malibu.usb.rc",
    );
    const makefilePath = join(generatedRoot, "grizzly.mk");
    try {
      await mkdir(dirname(initPath), { recursive: true });
      await writeFile(
        initPath,
        "# grizzly specific init.rc\n\non early-boot\n    wait_for_prop vendor.common.modules.ready 1\n",
      );
      await writeFile(
        malibuInitPath,
        "on post-fs\n    wait /dev/sg1\n    start storageproxyd\n",
      );
      await writeFile(
        usbInitPath,
        "on boot\n    # Use USB Gadget HAL\n    setprop sys.usb.configfs 2\n",
      );
      await writeFile(makefilePath, "PRODUCT_NAME := grizzly\n");

      normalizeGeneratedRenderEngine(root);
      normalizeGeneratedRenderEngine(root);
      // Exercise the production ELIZAOS_GRIZZLY_EARLY_BOOT_PROBES path, not a
      // lower-level helper that production might accidentally bypass.
      normalizeGeneratedBringupProbes(root);
      normalizeGeneratedBringupProbes(root);

      const init = readFileSync(initPath, "utf8");
      const debugInit = readFileSync(
        join(
          generatedRoot,
          "proprietary/vendor/etc/init/hw/init.elizaos-debug.rc",
        ),
        "utf8",
      );
      const makefile = readFileSync(makefilePath, "utf8");
      expect(
        init.match(/import \/vendor\/etc\/init\/hw\/init\.elizaos-debug\.rc/g),
      ).toHaveLength(1);
      expect(init).toContain("wait_for_prop vendor.common.modules.ready 1");
      expect(readFileSync(malibuInitPath, "utf8")).toBe(
        "on post-fs\n    wait /dev/sg1\n    start storageproxyd\n",
      );
      expect(readFileSync(usbInitPath, "utf8")).toBe(
        "on boot\n    # Use USB Gadget HAL\n    setprop sys.usb.configfs 2\n",
      );
      expect(debugInit).toContain("on early-init && property:ro.debuggable=1");
      expect(debugInit).not.toMatch(/^on early-init$/m);
      expect(debugInit).not.toContain("trigger post-fs-data");
      expect(makefile.match(/init\.elizaos-debug\.rc/g)).toHaveLength(2);
      expect(makefile).toContain(
        "    vendor/google_devices/grizzly/proprietary/vendor/etc/init/hw/init.elizaos-debug.rc:$(TARGET_COPY_OUT_VENDOR)/etc/init/hw/init.elizaos-debug.rc",
      );
      expect(makefile).not.toContain("\n+    vendor/google_devices/grizzly/");
      expect(
        makefile.match(/debug\.renderengine\.graphite=true/g),
      ).toHaveLength(1);
      expect(makefile).not.toContain("debug.renderengine.backend");
      expect(makefile).not.toContain("debug.renderengine.vulkan");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Pixel graphics evidence collection is comprehensive and read-only", () => {
    const parsed = parseGraphicsEvidenceArgs([
      "--serial",
      "pixel-under-test",
      "--output-dir",
      "/tmp/grizzly-evidence",
    ]);
    expect(parsed.serial).toBe("pixel-under-test");
    expect(parsed.outputDir).toBe("/tmp/grizzly-evidence");

    const probeNames = GRAPHICS_PROBES.map(({ name }) => name);
    expect(new Set(probeNames).size).toBe(GRAPHICS_PROBES.length);
    expect(probeNames).toEqual(
      expect.arrayContaining([
        "graphics-properties",
        "graphics-libraries",
        "graphics-library-contexts",
        "surfaceflinger-dump",
        "gpu-dump",
        "vulkan-json",
        "vendor-vintf",
        "hal-services",
        "kernel-graphics",
        "logcat-all",
      ]),
    );
    const commands = GRAPHICS_PROBES.flatMap(({ args }) => args).join("\n");
    expect(commands).not.toMatch(/(^|[;&|]\s*)(setprop|stop|start|reboot)\b/);
    expect(probeSucceeded({ status: 0, signal: null, error: null })).toBeTrue();
    expect(
      probeSucceeded({ status: 0, signal: null, error: "spawn warning" }),
    ).toBeFalse();
    expect(
      probeSucceeded({ status: 1, signal: null, error: null }),
    ).toBeFalse();
  });

  test("Pixel deployment uses the OS brand contract accepted by build-aosp", () => {
    const deploySource = readFileSync(
      join(repositoryRoot, "scripts/aosp/deploy-pixel.mjs"),
      "utf8",
    );
    const parsed = parseDeployArgs([
      "--brand-config",
      "/tmp/device-owner-supplied-brand.json",
      "--dry-run",
    ]);

    expect(parsed.brandConfig).toBe("/tmp/device-owner-supplied-brand.json");
    expect(deploySource).not.toContain('"--skip-libllama", // step 1');
    expect(deploySource).not.toContain('aospArgs.push("--app-config"');
    expect(deploySource).toContain('"--brand-config"');
    expect(deploySource).toContain('"android-arm64-cpu-fused"');
    expect(deploySource).not.toContain('"android-arm64-vulkan-fused"');
    expect(deploySource).toContain("ELIZA_BUN_RISCV64_OPTIONAL");
    expect(deploySource).toContain("stage-elizavoice-lib.mjs");
    expect(deploySource).not.toContain("ELIZA_MTP_ANDROID_LIBDIR");
    expect(deploySource).toContain("/api/asr/local-inference");
    expect(deploySource).toContain("/api/tts/local-inference");
    expect(deploySource).toContain('a === "--voice-only"');
    expect(deploySource).toContain('["forward", "tcp:0", "tcp:31337"]');
    expect(deploySource).not.toContain("/api/local-inference/voice-smoke");

    expect(
      loadPhysicalTargetContract(
        { aospLockPath: "android/pixel9a.lock.json" },
        repositoryRoot,
      ),
    ).toMatchObject({
      targetId: "pixel9a-tegu",
      codename: "tegu",
      expectedFingerprintPrefix: "elizaOS/eliza_tegu_phone/tegu:",
    });
    expect(() =>
      loadPhysicalTargetContract(
        { aospLockPath: "../outside.json" },
        repositoryRoot,
      ),
    ).toThrow("physical target lock escapes");
  });

  test("device smoke accepts an OS-owned package identity", () => {
    expect(
      parseSmokeArgs([
        "--package-name",
        "ai.elizaos.app",
        "--app-name",
        "Eliza",
        "--expected-abi",
        "arm64-v8a",
      ]),
    ).toMatchObject({
      packageName: "ai.elizaos.app",
      appName: "Eliza",
      expectedAbi: "arm64-v8a",
    });
  });

  test("Pixel deployment selects only the product platform-signed APK", () => {
    expect(
      resolveBuiltPrivilegedApk({
        aospRoot: "/aosp",
        productName: "eliza_cf_arm64_phone",
        env: {},
      }),
    ).toBe(
      "/aosp/out/target/product/eliza_cf_arm64_phone/system/priv-app/Eliza/Eliza.apk",
    );
    expect(
      resolveBuiltPrivilegedApk({
        aospRoot: "/aosp",
        productName: "eliza_cf_arm64_phone",
        env: { OUT_DIR: "/build/aosp-out" },
      }),
    ).toBe(
      "/build/aosp-out/target/product/eliza_cf_arm64_phone/system/priv-app/Eliza/Eliza.apk",
    );

    const deploySource = readFileSync(
      join(repositoryRoot, "scripts/aosp/deploy-pixel.mjs"),
      "utf8",
    );
    expect(deploySource).not.toContain('"find",');
    expect(deploySource).toContain(
      "unsigned vendor input cannot be sideloaded",
    );
  });

  test("Cuttlefish pins application and native-runtime build inputs", () => {
    const workflow = readFileSync(
      join(repositoryRoot, ".github/workflows/elizaos-cuttlefish.yml"),
      "utf8",
    );
    const sourceLock = JSON.parse(
      readFileSync(
        join(repositoryRoot, "release/eliza-source.lock.json"),
        "utf8",
      ),
    ) as { commit: string };

    expect(sourceLock.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(workflow).toContain("read-eliza-source-lock.mjs --github-output");
    expect(workflow).toContain("Provision pinned Zig 0.13");
    expect(workflow).toContain('ANDROID_NDK_VERSION: "29.0.13113456"');
    expect(workflow).toContain("provision-zig-linux-x64.sh");
    expect(workflow).toContain("android-assistant-verify.mjs");
    expect(workflow).toContain(
      "Prove full WAV to ASR to agent to TTS round trip",
    );
    expect(workflow).toContain("--require-device --require-engine --json");
    expect(workflow).toContain("cuttlefish-android-validation");
    expect(workflow).toContain("Build fused Android inference libraries");
    expect(workflow).toContain("Verify fused Android inference artifacts");
    expect(workflow).toContain("verify-native-runtime.mjs");
    expect(workflow).toContain("Verify immutable Cuttlefish AOSP source lock");
    expect(workflow).toContain("verify-source-lock.mjs");
    expect(workflow).toContain("bun-riscv64-sha256");
    expect(workflow).toContain("ELIZA_BUN_RISCV64_OPTIONAL");
    expect(workflow).toContain("ELIZA_MTP_ANDROID_LIBDIR");
  });

  test("riscv64 QJL uses Zig-supported variable-length vector flags", () => {
    const driver = readFileSync(
      join(repositoryRoot, "scripts/build-riscv64-artifacts.sh"),
      "utf8",
    );

    expect(driver).toContain(
      'QJL_RVV="-DQJL_RVV_COMPILE_OPTIONS=-mcpu=generic_rv64+v+m+a+f+d+c"',
    );
    expect(driver).not.toContain("QJL_RVV_COMPILE_OPTIONS=-mcpu=sifive_x280");

    const checker = readFileSync(
      join(repositoryRoot, "scripts/check-riscv64-artifacts.sh"),
      "utf8",
    );
    expect(checker).toContain('verify_artifact "$artifact" "$fork_ggml"');
    expect(checker).toContain(
      `LD_LIBRARY_PATH="$(dirname "$fork_ggml")\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"`,
    );
    expect(checker).toContain('"$(basename "$exe")" = "qjl_fork_parity"');
    expect(checker).toContain("Dynamic loading not supported");
    expect(checker).toContain(
      "qemu fork parity unavailable (static musl has no dlopen)",
    );

    const workflow = readFileSync(
      join(repositoryRoot, ".github/workflows/riscv64-smoke.yml"),
      "utf8",
    );
    expect(workflow).toContain(
      "bun run check:riscv64-artifacts --require-complete",
    );

    const architecture = readFileSync(
      join(repositoryRoot, "docs/two-fork-architecture.md"),
      "utf8",
    );
    expect(architecture).toContain(
      "no physical riscv64 board is qualified yet",
    );
    expect(architecture).not.toContain("any UEFI x86_64 / riscv64 SBC");
  });

  test("riscv64 strict smoke fails when required artifacts are absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "eliza-riscv64-missing-"));
    try {
      const elizaRoot = join(root, "eliza");
      const fakeBin = join(root, "bin");
      const report = join(root, "report.json");
      await Promise.all([
        mkdir(join(elizaRoot, "packages/native"), { recursive: true }),
        mkdir(fakeBin, { recursive: true }),
      ]);
      const fakeQemu = join(fakeBin, "qemu-riscv64-static");
      await writeFile(fakeQemu, "#!/bin/sh\nexit 0\n");
      await chmod(fakeQemu, 0o755);

      const process = Bun.spawn(
        [
          "bash",
          join(repositoryRoot, "scripts/check-riscv64-artifacts.sh"),
          "--require-complete",
          "--out",
          report,
        ],
        {
          cwd: repositoryRoot,
          env: {
            ...Bun.env,
            ELIZAOS_ELIZA_ROOT: elizaRoot,
            ELIZA_RISCV64_SMOKE: "1",
            HOME: root,
            PATH: `${fakeBin}:${Bun.env.PATH ?? ""}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const exitCode = await process.exited;
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(await Bun.file(report).text());
      expect(parsed.require_complete).toBe(true);
      expect(parsed.summary.fail).toBeGreaterThan(0);
      expect(parsed.final_status).toBe("FAIL");
      expect(
        parsed.artifacts.some(
          (artifact: { status: string }) => artifact.status === "FAIL",
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("riscv64 strict smoke records a missing QEMU failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "eliza-riscv64-no-qemu-"));
    try {
      const elizaRoot = join(root, "eliza");
      const fakeBin = join(root, "bin");
      const report = join(root, "report.json");
      await Promise.all([
        mkdir(join(elizaRoot, "packages/native"), { recursive: true }),
        mkdir(fakeBin, { recursive: true }),
      ]);
      const resolveExecutable = (name: string): string => {
        for (const directory of (Bun.env.PATH ?? "").split(delimiter)) {
          const candidate = join(directory, name);
          try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
          } catch {}
        }
        throw new Error(`required test tool is missing: ${name}`);
      };
      for (const tool of [
        "awk",
        "cat",
        "date",
        "dirname",
        "mkdir",
        "mktemp",
        "python3",
        "rm",
      ]) {
        await symlink(resolveExecutable(tool), join(fakeBin, tool));
      }

      const process = Bun.spawn(
        [
          resolveExecutable("bash"),
          join(repositoryRoot, "scripts/check-riscv64-artifacts.sh"),
          "--require-complete",
          "--out",
          report,
        ],
        {
          cwd: repositoryRoot,
          env: {
            ...Bun.env,
            ELIZAOS_ELIZA_ROOT: elizaRoot,
            ELIZA_RISCV64_SMOKE: "1",
            HOME: root,
            PATH: fakeBin,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const exitCode = await process.exited;
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(await Bun.file(report).text());
      expect(parsed.require_complete).toBe(true);
      expect(parsed.qemu_bin).toBe("");
      expect(parsed.summary).toEqual({ pass: 0, fail: 1, skip: 0 });
      expect(parsed.final_status).toBe("FAIL");
      expect(parsed.pre_skip_reason).toBe("qemu-riscv64-static missing");
      expect(parsed.artifacts).toEqual([
        {
          path: "qemu-riscv64-static",
          kind: "tool",
          status: "FAIL",
          detail: "required QEMU executable is not installed or not on PATH",
          duration_ms: 0,
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("riscv64 strict smoke rejects disabled QEMU with a failure report", async () => {
    const root = await mkdtemp(join(tmpdir(), "eliza-riscv64-no-exec-"));
    try {
      const elizaRoot = join(root, "eliza");
      const report = join(root, "report.json");
      await mkdir(join(elizaRoot, "packages/native"), { recursive: true });
      const process = Bun.spawn(
        [
          "bash",
          join(repositoryRoot, "scripts/check-riscv64-artifacts.sh"),
          "--require-complete",
          "--no-qemu",
          "--out",
          report,
        ],
        {
          cwd: repositoryRoot,
          env: {
            ...Bun.env,
            ELIZAOS_ELIZA_ROOT: elizaRoot,
            ELIZA_RISCV64_SMOKE: "1",
            HOME: root,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await process.exited).toBe(1);
      const parsed = JSON.parse(await Bun.file(report).text());
      expect(parsed.require_complete).toBe(true);
      expect(parsed.qemu_run).toBe(false);
      expect(parsed.summary).toEqual({ pass: 0, fail: 1, skip: 0 });
      expect(parsed.final_status).toBe("FAIL");
      expect(parsed.pre_skip_reason).toBe(
        "strict smoke requires QEMU execution",
      );
      expect(parsed.artifacts).toEqual([
        {
          path: "qemu-riscv64-static",
          kind: "tool",
          status: "FAIL",
          detail: "--require-complete cannot be combined with --no-qemu",
          duration_ms: 0,
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("riscv64 strict smoke rejects a disabled smoke gate with a failure report", async () => {
    const root = await mkdtemp(join(tmpdir(), "eliza-riscv64-no-gate-"));
    try {
      const elizaRoot = join(root, "eliza");
      const report = join(root, "report.json");
      await mkdir(join(elizaRoot, "packages/native"), { recursive: true });
      const process = Bun.spawn(
        [
          "bash",
          join(repositoryRoot, "scripts/check-riscv64-artifacts.sh"),
          "--require-complete",
          "--out",
          report,
        ],
        {
          cwd: repositoryRoot,
          env: {
            ...Bun.env,
            ELIZAOS_ELIZA_ROOT: elizaRoot,
            ELIZA_RISCV64_SMOKE: "",
            HOME: root,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await process.exited).toBe(1);
      const parsed = JSON.parse(await Bun.file(report).text());
      expect(parsed.require_complete).toBe(true);
      expect(parsed.qemu_run).toBe(true);
      expect(parsed.summary).toEqual({ pass: 0, fail: 1, skip: 0 });
      expect(parsed.final_status).toBe("FAIL");
      expect(parsed.pre_skip_reason).toBe("strict smoke gate is disabled");
      expect(parsed.artifacts).toEqual([
        {
          path: "ELIZA_RISCV64_SMOKE",
          kind: "configuration",
          status: "FAIL",
          detail: "--require-complete requires ELIZA_RISCV64_SMOKE=1",
          duration_ms: 0,
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("riscv64 QJL reports the static-musl dlopen boundary as unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "eliza-riscv64-qjl-"));
    try {
      const elizaRoot = join(root, "eliza");
      const qjlBuild = join(
        elizaRoot,
        "packages/native/plugins/qjl-cpu/build/riscv64",
      );
      const llamaBuild = join(elizaRoot, "build/riscv64-stage/riscv64");
      const fakeBin = join(root, "bin");
      const report = join(root, "report.json");
      await Promise.all([
        mkdir(qjlBuild, { recursive: true }),
        mkdir(llamaBuild, { recursive: true }),
        mkdir(fakeBin, { recursive: true }),
      ]);

      const parity = join(qjlBuild, "qjl_fork_parity");
      const forkLibrary = join(llamaBuild, "libggml-cpu.so");
      const fakeFile = join(fakeBin, "file");
      const fakeQemu = join(fakeBin, "qemu-riscv64-static");
      const fakeTimeout = join(fakeBin, "timeout");
      const fakeDate = join(fakeBin, "date");
      await Promise.all([
        writeFile(parity, "fake riscv64 executable\n"),
        writeFile(forkLibrary, "fake riscv64 shared library\n"),
        writeFile(
          fakeFile,
          '#!/bin/sh\necho "ELF 64-bit LSB executable, UCB RISC-V, double-float ABI"\n',
        ),
        writeFile(
          fakeQemu,
          '#!/bin/sh\necho "dlopen $2: Dynamic loading not supported" >&2\nexit 1\n',
        ),
        writeFile(fakeTimeout, '#!/bin/sh\nshift\nexec "$@"\n'),
        writeFile(
          fakeDate,
          '#!/bin/sh\nif [ "$1" = "+%s%3N" ]; then echo 1000; else exec /bin/date "$@"; fi\n',
        ),
      ]);
      await Promise.all(
        [parity, fakeFile, fakeQemu, fakeTimeout, fakeDate].map((path) =>
          chmod(path, 0o755),
        ),
      );

      const process = Bun.spawn(
        [
          "bash",
          join(repositoryRoot, "scripts/check-riscv64-artifacts.sh"),
          "--out",
          report,
        ],
        {
          cwd: repositoryRoot,
          env: {
            ...Bun.env,
            ELIZAOS_ELIZA_ROOT: elizaRoot,
            ELIZA_RISCV64_SMOKE: "1",
            HOME: root,
            PATH: `${fakeBin}:${Bun.env.PATH ?? ""}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      expect(`${stdout}\n${stderr}`).toContain("static musl has no dlopen");
      expect(exitCode).toBe(0);

      const parsed = JSON.parse(await Bun.file(report).text());
      const parityResult = parsed.artifacts.find(
        (artifact: { path: string }) => artifact.path === parity,
      );
      expect(parityResult?.status).toBe("SKIP");
      expect(parityResult?.detail).toContain("Dynamic loading not supported");
      expect(parsed.summary.fail).toBe(0);
      expect(parsed.final_status).toBe("PASS");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("source-only AOSP builds do not require KVM", () => {
    if (process.platform !== "linux" || process.arch !== "x64") return;
    expect(() =>
      assertBuildHost({
        brand: { distroName: "elizaOS", productName: "eliza_cf_x86_64_phone" },
        launch: false,
        kvmPath: "/definitely/missing/kvm",
      }),
    ).not.toThrow();
  });

  test("riscv64 Cuttlefish uses TCG and does not require KVM", () => {
    if (process.platform !== "linux" || process.arch !== "x64") return;
    expect(() =>
      assertBuildHost({
        brand: { distroName: "elizaOS", productName: "eliza_cf_riscv64_phone" },
        launch: true,
        kvmPath: "/definitely/missing/kvm",
      }),
    ).not.toThrow();
  });

  test("accelerated Cuttlefish launch fails closed without KVM", () => {
    if (process.platform !== "linux" || process.arch !== "x64") return;
    expect(() =>
      assertBuildHost({
        brand: { distroName: "elizaOS", productName: "eliza_cf_x86_64_phone" },
        launch: true,
        kvmPath: "/definitely/missing/kvm",
      }),
    ).toThrow("Cuttlefish launch requires /dev/kvm");
  });

  test("Cuttlefish launch pins accelerated graphics instead of auto mode", () => {
    const brand = {
      lunchTarget: "eliza_cf_x86_64_phone-trunk_staging-userdebug",
      productName: "eliza_cf_x86_64_phone",
    };
    expect(resolveCuttlefishGpuMode(brand, {})).toBe("gfxstream");
    const command = cuttlefishLaunchCommand(brand, {});
    expect(command).toContain("cvd start --daemon --gpu_mode=gfxstream");
    expect(command).toContain("launch_cvd --daemon --gpu_mode=gfxstream");
    expect(command).toContain("if command -v cvd");
    expect(command).not.toContain("gpu_mode=auto");
    expect(command).not.toContain("2>/dev/null ||");
    expect(
      cuttlefishLaunchCommand(brand, {
        ELIZA_CUTTLEFISH_GPU_RENDERER_FEATURES:
          "VulkanAllocateHostMemory:enabled;VulkanDisableCoherentMemoryAndEmulate:enabled",
      }),
    ).toContain(
      "--gpu_renderer_features='VulkanAllocateHostMemory:enabled;VulkanDisableCoherentMemoryAndEmulate:enabled'",
    );
    expect(() =>
      cuttlefishLaunchCommand(brand, {
        ELIZA_CUTTLEFISH_GPU_RENDERER_FEATURES:
          "VulkanAllocateHostMemory:enabled;VulkanDisableCoherentMemoryAndEmulate:enabled'; touch /tmp/unsafe",
      }),
    ).toThrow("ELIZA_CUTTLEFISH_GPU_RENDERER_FEATURES must contain");
  });

  test("Cuttlefish GPU selection is explicit and rejects shell input", () => {
    const riscvBrand = {
      lunchTarget: "eliza_cf_riscv64_phone-trunk_staging-userdebug",
      productName: "eliza_cf_riscv64_phone",
    };
    expect(resolveCuttlefishGpuMode(riscvBrand, {})).toBe("guest_swiftshader");
    expect(
      resolveCuttlefishGpuMode(riscvBrand, {
        ELIZA_CUTTLEFISH_GPU_MODE: "none",
      }),
    ).toBe("none");
    expect(() =>
      resolveCuttlefishGpuMode(riscvBrand, {
        ELIZA_CUTTLEFISH_GPU_MODE: "gfxstream; touch /tmp/unsafe",
      }),
    ).toThrow("ELIZA_CUTTLEFISH_GPU_MODE must be one of");
  });

  test("the grizzly handoff requires and digest-binds every flash input", async () => {
    const root = await mkdtemp(join(tmpdir(), "eliza-grizzly-bundle-"));
    const productOut = join(root, "product");
    const bundleDir = join(root, "bundle");
    try {
      await mkdir(productOut, { recursive: true });
      for (const artifact of REQUIRED_GRIZZLY_ARTIFACTS) {
        await writeFile(
          join(productOut, artifact),
          artifact === "fastboot-info.txt"
            ? validGrizzlyFastbootInfo.replace(
                "reboot fastboot",
                "flash vbmeta_system\nreboot fastboot",
              )
            : `${artifact}\n`,
        );
      }
      await writeFile(join(productOut, "vbmeta_system.img"), "vbmeta-system\n");
      const collected = collectGrizzlyArtifacts({ productOut, bundleDir });
      expect(collected.map(({ filename }) => filename)).toEqual([
        ...REQUIRED_GRIZZLY_ARTIFACTS,
        "vbmeta_system.img",
      ]);
      expect(
        collected.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256)),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the grizzly handoff rejects incomplete output and invalid concurrency", async () => {
    const root = await mkdtemp(join(tmpdir(), "eliza-grizzly-bundle-"));
    try {
      await mkdir(join(root, "product"), { recursive: true });
      expect(() =>
        collectGrizzlyArtifacts({
          productOut: join(root, "product"),
          bundleDir: join(root, "bundle"),
        }),
      ).toThrow("required build artifact boot.img");
      expect(() =>
        parseBundleArgs([
          "--aosp-root",
          root,
          "--output-dir",
          join(root, "out"),
          "--jobs",
          "0",
        ]),
      ).toThrow("--jobs must be an integer from 1 through 256");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the grizzly handoff enforces the documented dedicated builder floor", () => {
    const threshold = {
      platform: "linux",
      architecture: "x64",
      physicalCores: 32,
      memoryBytes: 128 * 1024 ** 3,
      totalBytes: 1_500_000_000_000,
      freeBytes: 600 * 1024 ** 3,
    };
    expect(assertBuilderCapacity(threshold)).toMatchObject({
      physicalCores: 32,
      memoryBytes: threshold.memoryBytes,
    });
    expect(() =>
      assertBuilderCapacity({ ...threshold, physicalCores: 31 }),
    ).toThrow("require 32/128");
    expect(() =>
      assertBuilderCapacity({ ...threshold, freeBytes: 599 * 1024 ** 3 }),
    ).toThrow("require 1500 GB/600 GiB");
    expect(() =>
      assertBuilderCapacity({ ...threshold, totalBytes: 1_499_999_999_999 }),
    ).toThrow("require 1500 GB/600 GiB");
    expect(() =>
      assertBuilderCapacity({ ...threshold, architecture: "arm64" }),
    ).toThrow("Linux x86_64");
  });

  test("the grizzly handoff cannot infer build gates from existing output", () => {
    expect(() =>
      parseBundleArgs([
        "--aosp-root",
        "/build/aosp-grizzly",
        "--output-dir",
        "/build/bundle",
        "--skip-build",
      ]),
    ).toThrow("unknown argument: --skip-build");
  });

  test("the grizzly handoff fails closed without an authoritative resolved graph", () => {
    const lock = loadAospLock(
      join(repositoryRoot, "android/pixel11pro.lock.json"),
    );
    // The repository lock now contains the required contract; exercise the
    // fail-closed branch with an explicitly incomplete copy.
    delete lock.resolvedManifest;
    expect(() => requireResolvedManifestContract(lock)).toThrow(
      "no authoritative resolved AOSP manifest contract",
    );
    expect(lock.avbVerification).toEqual([
      {
        image: "vbmeta.img",
        keyPath: "external/avb/test/data/testkey_rsa4096.pem",
        keySha256:
          "6a224754880a57ab9cbd308267cd157d94cf05a1c8cb851aec4090e045d24121",
        authorization: "public-aosp-userdebug-test-key",
      },
    ]);
    const collector = readFileSync(
      join(repositoryRoot, "scripts/aosp/build-grizzly-bundle.mjs"),
      "utf8",
    );
    expect(collector).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: match literal build-script source
      'm -j${jobs} "$product_out/host_init_verifier_output.txt"',
    );
    expect(collector).not.toContain(
      'host_init_verifier_check "$product_out/host_init_verifier_output.txt"',
    );
    expect(collector).not.toContain(".repo/repo/repo");
  });

  test("the grizzly handoff rejects loose files outside the resolved source graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "eliza-grizzly-source-root-"));
    try {
      const makeProject = join(root, "build/make");
      const soongProject = join(root, "build/soong");
      await mkdir(join(makeProject, "core"), { recursive: true });
      await mkdir(soongProject, { recursive: true });
      await mkdir(join(root, ".repo"));
      await mkdir(join(root, "out"));
      await mkdir(join(root, "vendor/google_devices/grizzly"), {
        recursive: true,
      });
      await mkdir(join(root, "vendor/eliza"), { recursive: true });
      await writeFile(join(makeProject, "core/root.mk"), "root-make\n");
      await writeFile(join(soongProject, "root.bp"), "root-blueprint\n");
      await writeFile(join(root, "Makefile"), "root-make\n");
      await symlink("build/soong/root.bp", join(root, "Android.bp"));
      const sha256 = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      const contract = {
        aospRoot: root,
        outRoot: join(root, "out"),
        projectPaths: ["build/make", "build/soong"],
        boundTreePaths: ["vendor/google_devices/grizzly", "vendor/eliza"],
        rootEntries: [
          {
            path: "Makefile",
            projectPath: "build/make",
            sourcePath: "core/root.mk",
            sourceType: "file",
            mode: "copy",
            sha256: sha256("root-make\n"),
          },
          {
            path: "Android.bp",
            projectPath: "build/soong",
            sourcePath: "root.bp",
            sourceType: "file",
            mode: "link",
            sha256: sha256("root-blueprint\n"),
          },
        ],
      };
      expect(assertClosedAospSourceRoot(contract)).toMatchObject({
        projectCount: 2,
      });

      await writeFile(join(root, "buildspec.mk"), "ROGUE := true\n");
      expect(() => assertClosedAospSourceRoot(contract)).toThrow(
        "unlocked entry: buildspec.mk",
      );
      await rm(join(root, "buildspec.mk"));

      await mkdir(join(root, "vendor/foo"));
      await writeFile(join(root, "vendor/foo/Android.bp"), "rogue_module {}\n");
      expect(() => assertClosedAospSourceRoot(contract)).toThrow(
        "unlocked entry: vendor/foo",
      );
      await rm(join(root, "vendor/foo"), { recursive: true });

      expect(() =>
        assertClosedAospSourceRoot({
          ...contract,
          outRoot: join(root, ".repo/out"),
        }),
      ).toThrow("OUT_DIR overlaps source or repo metadata");
      expect(() =>
        assertClosedAospSourceRoot({ ...contract, outRoot: root }),
      ).toThrow("OUT_DIR overlaps source or repo metadata");

      expect(() =>
        assertClosedAospSourceRoot({
          ...contract,
          projectPaths: [...contract.projectPaths, "build/make"],
        }),
      ).toThrow("duplicate paths");
      expect(() =>
        assertClosedAospSourceRoot({
          ...contract,
          projectPaths: [...contract.projectPaths, ".repo/projects/rogue"],
        }),
      ).toThrow("unsafe path: .repo/projects/rogue");
      expect(() =>
        assertClosedAospSourceRoot({
          ...contract,
          rootEntries: [
            {
              ...contract.rootEntries[0],
              path: ".repo/manifest.xml",
            },
          ],
        }),
      ).toThrow("invalid root entry");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the grizzly handoff rejects vendor symlinks into repo metadata or output", async () => {
    const root = await mkdtemp(join(tmpdir(), "eliza-grizzly-source-links-"));
    try {
      const vendor = join(root, "vendor/eliza");
      const repoMetadata = join(root, ".repo/project-objects");
      const out = join(root, "out/target/product/grizzly");
      await mkdir(vendor, { recursive: true });
      await mkdir(repoMetadata, { recursive: true });
      await mkdir(out, { recursive: true });
      await writeFile(join(repoMetadata, "metadata.bp"), "metadata\n");
      await writeFile(join(out, "generated.bp"), "generated\n");

      await symlink(
        join(repoMetadata, "metadata.bp"),
        join(vendor, "metadata.bp"),
      );
      expect(() =>
        hashDirectoryTree(vendor, root, [
          join(root, ".repo"),
          join(root, "out"),
        ]),
      ).toThrow("targets excluded AOSP metadata or output");

      await rm(join(vendor, "metadata.bp"));
      await symlink(join(out, "generated.bp"), join(vendor, "generated.bp"));
      expect(() =>
        hashDirectoryTree(vendor, root, [
          join(root, ".repo"),
          join(root, "out"),
        ]),
      ).toThrow("targets excluded AOSP metadata or output");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the grizzly handoff accepts repo's standard generated manifest selector", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "eliza-grizzly-manifest-selector-"),
    );
    try {
      const manifests = join(root, ".repo/manifests");
      await mkdir(manifests, { recursive: true });
      await writeFile(join(manifests, "default.xml"), "<manifest />\n");
      await writeFile(
        join(root, ".repo/manifest.xml"),
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          "<!-- DO NOT EDIT: generated by repo -->",
          "<manifest>",
          '  <include name="default.xml" />',
          "</manifest>",
          "",
        ].join("\n"),
      );
      expect(selectedManifestPath(root, manifests)).toEqual({
        selectedManifest: join(manifests, "default.xml"),
        manifestRelative: "default.xml",
      });

      await writeFile(
        join(root, ".repo/manifest.xml"),
        '<manifest><include name="default.xml"/><include name="other.xml"/></manifest>\n',
      );
      expect(() => selectedManifestPath(root, manifests)).toThrow(
        "must contain one exact include",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the grizzly handoff rejects symlinked flash inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "eliza-grizzly-bundle-"));
    const productOut = join(root, "product");
    try {
      await mkdir(productOut, { recursive: true });
      for (const artifact of REQUIRED_GRIZZLY_ARTIFACTS) {
        await writeFile(
          join(productOut, artifact),
          artifact === "fastboot-info.txt"
            ? validGrizzlyFastbootInfo
            : `${artifact}\n`,
        );
      }
      await rm(join(productOut, "boot.img"));
      await symlink(
        join(productOut, "vbmeta.img"),
        join(productOut, "boot.img"),
      );
      expect(() =>
        collectGrizzlyArtifacts({
          productOut,
          bundleDir: join(root, "bundle"),
        }),
      ).toThrow("private non-empty regular file");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the grizzly handoff rejects source aliases and unsafe publication parents", async () => {
    const root = await mkdtemp(join(tmpdir(), "eliza-grizzly-output-"));
    try {
      const source = join(root, "source");
      const outputParent = join(root, "bundles");
      await mkdir(join(source, "nested"), { recursive: true, mode: 0o700 });
      await mkdir(outputParent, { mode: 0o700 });
      expect(() =>
        assertBundleOutputLocation({
          outputDir: join(source, "nested", "bundle"),
          sourceRoots: [[source, "source"]],
        }),
      ).toThrow("outside the source checkout");

      const aliasedParent = join(root, "bundle-alias");
      await symlink(outputParent, aliasedParent);
      expect(() =>
        assertBundleOutputLocation({
          outputDir: join(aliasedParent, "bundle"),
          sourceRoots: [[source, "source"]],
        }),
      ).toThrow("canonical");

      const existingOutput = join(outputParent, "existing");
      await mkdir(existingOutput);
      expect(() =>
        assertBundleOutputLocation({
          outputDir: existingOutput,
          sourceRoots: [[source, "source"]],
        }),
      ).toThrow("must not already exist");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the grizzly handoff requires both APK provenance records", () => {
    expect(assertApkProvenanceEntries([...REQUIRED_APK_PROVENANCE])).toEqual([
      ...REQUIRED_APK_PROVENANCE,
    ]);
    expect(() =>
      assertApkProvenanceEntries(["META-INF/eliza/aosp-build-provenance.json"]),
    ).toThrow("assets/agent/android-agent-runtime-provenance.json");
    expect(() =>
      assertApkProvenanceEntries([
        ...REQUIRED_APK_PROVENANCE,
        REQUIRED_APK_PROVENANCE[0],
      ]),
    ).toThrow("exactly once");
  });

  test("the grizzly handoff requires a safe dynamic-super flash plan", () => {
    expect(
      assertSafeFlashMetadata({
        androidInfo: "require board=grizzly\n",
        fastbootInfo: validGrizzlyFastbootInfo,
      }),
    ).toMatchObject({
      rebootFastbootIndex: 8,
      updateSuperIndex: 9,
      terminalRebootAuthority: "fastboot-info",
    });
    expect(() =>
      assertSafeFlashMetadata({
        androidInfo: "require board=grizzly\n",
        fastbootInfo: validGrizzlyFastbootInfo.replace(
          "reboot fastboot\nupdate-super\nflash system",
          "flash system\nreboot fastboot\nupdate-super",
        ),
      }),
    ).toThrow("flash system before update-super");
    expect(() =>
      assertSafeFlashMetadata({
        androidInfo: "require board=grizzly\n",
        fastbootInfo: validGrizzlyFastbootInfo.replace(
          "if-wipe erase userdata",
          "erase userdata",
        ),
      }),
    ).toThrow("must not erase any partition");
    expect(() =>
      assertSafeFlashMetadata({
        androidInfo: "require board=grizzly\n",
        fastbootInfo: validGrizzlyFastbootInfo.replace(
          "flash --slot-other system system_other.img\n",
          "",
        ),
      }),
    ).toThrow("does not reference required flash artifact system_other.img");
    expect(() =>
      assertSafeFlashMetadata({
        androidInfo: "require board=grizzly\n",
        fastbootInfo: validGrizzlyFastbootInfo.replace("flash pvmfw\n", ""),
      }),
    ).toThrow("does not reference required flash artifact pvmfw.img");
    expect(() =>
      assertSafeFlashMetadata({
        androidInfo: "require board=grizzly\n",
        fastbootInfo: validGrizzlyFastbootInfo.replace(
          "flash --slot-other system system_other.img",
          "flash --slot-other vendor system_other.img",
        ),
      }),
    ).toThrow("unsupported --slot-other flash");
    expect(() =>
      assertSafeFlashMetadata({
        androidInfo: "require board=grizzly\n",
        fastbootInfo: validGrizzlyFastbootInfo.replace(
          "flash boot",
          "flash boot ../../host.img",
        ),
      }),
    ).toThrow("unsafe image filename");
    expect(() =>
      assertSafeFlashMetadata({
        androidInfo: "require board=grizzly\n",
        fastbootInfo: validGrizzlyFastbootInfo.replace(
          "version 1\n",
          "version 1\nreboot\n",
        ),
      }),
    ).toThrow("at most one terminal reboot, at the end");
    expect(() =>
      assertSafeFlashMetadata({
        androidInfo: "require board=grizzly\n",
        fastbootInfo: validGrizzlyFastbootInfo.replace(
          "flash --apply-vbmeta vbmeta",
          "flash vbmeta",
        ),
      }),
    ).toThrow("unsafe flash mapping");
  });

  test("the grizzly handoff rejects an unsafe or unknown flash authority", () => {
    expect(() =>
      parseFastbootInfoArtifacts(
        "version 1\nflash --slot-other system ../system_other.img\n",
      ),
    ).toThrow("unsafe image filename");
    expect(() => parseFastbootInfoArtifacts("version 1\noem unlock\n")).toThrow(
      "unsupported fastboot-info command",
    );
    expect(() => parseFastbootInfoArtifacts("flash boot\n")).toThrow(
      "missing its version",
    );
  });
});

test("boot validation requires completed Android setup when stock provisioning is removed", () => {
  const ready = { device_provisioned: "1", user_setup_complete: "1" };
  expect(assertAndroidSetupState(ready)).toEqual(ready);
  for (const name of ["device_provisioned", "user_setup_complete"]) {
    for (const value of ["0", "null", "", "true"]) {
      expect(() =>
        assertAndroidSetupState({ ...ready, [name]: value }),
      ).toThrow(name);
    }
  }
});
