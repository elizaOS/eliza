#!/usr/bin/env node
/** Generate the Pixel 11 Pro vendor/device module from pinned stock inputs. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertGeneratedVendorTree,
  assertPinnedAospCheckout,
  loadAospLock,
  materializeExternalProjects,
  materializeLockedSourceOverlays,
  verifyLockedArtifact,
} from "./bootstrap-aosp.mjs";
import { isMainModule } from "./is-main.mjs";
import { lintInitRc } from "./lint-init-rc.mjs";
import { withSisoCompatibility } from "./siso-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../..");
const defaultLockPath = path.join(
  repositoryRoot,
  "android/pixel11pro.lock.json",
);

// The generated Pixel makefile carries the factory image's BUILD_ID guard.
// Android 17's product configuration owns BUILD_ID as a readonly value and
// uses a different source-tree release ID, so preserving the guard as a
// warning is required for a custom AOSP build. The original guard text stays
// in the file (and in the lock contract) for provenance and reviewability.
function normalizeGeneratedBuildIdGuard(aospRoot) {
  const makefilePath = path.join(
    aospRoot,
    "vendor/google_devices/grizzly/grizzly.mk",
  );
  if (!fs.existsSync(makefilePath)) return;
  const contents = fs.readFileSync(makefilePath, "utf8");
  const strictError =
    "  $(error BUILD_ID: expected CD1A.260714.001.A9, got $(BUILD_ID))";
  const warning =
    "  $(warning BUILD_ID: factory CD1A.260714.001.A9; using AOSP $(BUILD_ID))";
  if (!contents.includes(strictError) || contents.includes(warning)) return;
  fs.writeFileSync(makefilePath, contents.replace(strictError, warning));
}

// Android 17's root dexpreopt check resolves the Malibu provider by its local
// module name. adevtool emits the provider in a private Soong namespace, which
// makes it invisible to the root namespace. Add a narrow global shim rather
// than flattening every proprietary module (some names, such as `health`, also
// exist in Cuttlefish).
function normalizeGeneratedProprietaryNamespace(aospRoot) {
  const proprietaryBpPath = path.join(
    aospRoot,
    "vendor/google_devices/grizzly/proprietary/Android.bp",
  );
  if (!fs.existsSync(proprietaryBpPath)) return;
  const contents = fs.readFileSync(proprietaryBpPath, "utf8");
  const flattenedMarker =
    "// elizaOS: expose grizzly proprietary modules globally\n";
  if (contents.includes(flattenedMarker)) {
    fs.writeFileSync(
      proprietaryBpPath,
      contents.replace(flattenedMarker, "soong_namespace {}\n"),
    );
  }
  const normalizedProprietary = fs.readFileSync(proprietaryBpPath, "utf8");
  const malibuModule =
    /\ndex_import \{\n {4}name: "malibu-plugin-provider",[\s\S]*?\n\}\n/;
  if (malibuModule.test(normalizedProprietary)) {
    fs.writeFileSync(
      proprietaryBpPath,
      normalizedProprietary.replace(malibuModule, "\n"),
    );
  }

  const shimDir = path.join(aospRoot, "vendor/google_devices/grizzly");
  const staleShimDir = path.join(shimDir, "malibu-plugin-provider");
  fs.rmSync(staleShimDir, { recursive: true, force: true });
  fs.writeFileSync(
    path.join(shimDir, "Android.bp"),
    `dex_import {
    name: "malibu-plugin-provider",
    owner: "google_devices",
    jars: [ "proprietary/system_ext/framework/malibu-plugin-provider.jar" ],
    system_ext_specific: true,
}

`,
  );

  const makefilePath = path.join(
    aospRoot,
    "vendor/google_devices/grizzly/grizzly.mk",
  );
  if (fs.existsSync(makefilePath)) {
    const makefile = fs.readFileSync(makefilePath, "utf8");
    const namespaceLine = "    vendor/google_devices/grizzly \\\n";
    if (!makefile.includes(namespaceLine)) {
      fs.writeFileSync(
        makefilePath,
        makefile.replace(
          "PRODUCT_SOONG_NAMESPACES += \\\n",
          `PRODUCT_SOONG_NAMESPACES += \\\n${namespaceLine}`,
        ),
      );
    }
  }
}

// Android 17 already declares the preload-copy domain in
// system/sepolicy/private/preloads_copy.te. The generated Pixel policy
// carries the same two public declarations, which checkpolicy rejects as
// duplicate types when the grizzly system_ext policy is assembled. Remove
// only those generated duplicates; all generated allow rules and exec labels
// remain intact.
function normalizeGeneratedSePolicy(aospRoot) {
  const typesPath = path.join(
    aospRoot,
    "vendor/google_devices/grizzly/sepolicy/system_ext/public/types.te",
  );
  if (!fs.existsSync(typesPath)) return;
  const contents = fs.readFileSync(typesPath, "utf8");
  const normalized = contents
    .replace(/^type preloads_copy, domain, coredomain;\n/gm, "")
    .replace(
      /^type preloads_copy_exec, file_type, exec_type, system_file_type;\n/gm,
      "",
    )
    .replace(/^type system_server_startup, domain, coredomain;\n/gm, "")
    .replace(/^type system_server_startup_tmpfs, file_type;\n/gm, "");
  if (normalized !== contents) fs.writeFileSync(typesPath, normalized);
}

// The stock A9 vendor manifest advertises the previous sepolicy API level
// (202604), while Android 17's board contract builds against 202704. Keep the
// generated HAL declarations unchanged and update only the manifest's
// sepolicy version so assemble_vintf can validate the device tree.
function normalizeGeneratedVintf(aospRoot) {
  const manifestPath = path.join(
    aospRoot,
    "vendor/google_devices/grizzly/vintf/vendor/manifest.xml",
  );
  if (!fs.existsSync(manifestPath)) return;
  const contents = fs.readFileSync(manifestPath, "utf8");
  const normalized = contents.replace(
    /(<sepolicy>\s*<version>)202604(<\/version>\s*<\/sepolicy>)/,
    "$1202704$2",
  );
  if (normalized !== contents) fs.writeFileSync(manifestPath, normalized);
}

// DIAGNOSTIC-ONLY fstab rewrite, opt-in via ELIZAOS_GRIZZLY_CONSERVATIVE_F2FS=1.
//
// The default image keeps the stock Malibu userdata entry untouched. The build
// uses the stock factory kernel (USE_STOCK_KERNEL, factory Image.lz4), which
// by definition supports the stock factory fstab, and this rewrite strips the
// factory encryption contract (fileencryption=, metadata_encryption=,
// keydirectory=) from /data. Mounting a stock-formatted, metadata-encrypted
// userdata without that contract wedges init at post-fs-data — before the
// adbd APEX activates — which is exactly the "G logo, no ADB" symptom this
// rewrite was originally introduced to fix. The earlier "verified in recovery"
// evidence never exercised the normal-boot vold path.
//
// Changing the fstab stance in either direction changes the on-disk format
// contract: pair the first flash of a stance change with `fastboot -w` so
// first boot formats userdata fresh under the new contract.
export function normalizeGeneratedF2fsMountOptions(aospRoot) {
  const relativePaths = [
    "vendor/google_devices/grizzly/proprietary/vendor/etc/fstab.malibu",
    "vendor/google_devices/grizzly/proprietary/vendor_ramdisk/system/etc/fstab.malibu",
    "vendor/google_devices/grizzly/proprietary/recovery/system/etc/recovery.fstab",
  ];
  const userdataPattern =
    /^\/dev\/block\/platform\/3c2d0000\.ufs\/by-name\/userdata\s+\/data\s+f2fs\s+.*$/m;
  const normalizedUserdata =
    "/dev/block/platform/3c2d0000.ufs/by-name/userdata /data f2fs " +
    "noatime,nosuid,nodev,discard,reserve_root=32768,resgid=1065," +
    "fsync_mode=nobarrier,atgc,checkpoint_merge " +
    "latemount,wait,check,quota,formattable";
  for (const relativePath of relativePaths) {
    const filePath = path.join(aospRoot, relativePath);
    if (!fs.existsSync(filePath)) continue;
    const contents = fs.readFileSync(filePath, "utf8");
    const normalized = contents.replace(userdataPattern, normalizedUserdata);
    if (normalized !== contents) {
      fs.writeFileSync(
        filePath,
        `# elizaOS: use kernel-supported f2fs userdata options for grizzly\n${normalized}`,
      );
    }
  }
}

// The extracted Pixel 11 vendor defaults route SurfaceFlinger through ANGLE
// and select the Skia Graphite renderer (debug.renderengine.graphite=true).
//
// AOSP semantics (frameworks/native RenderEngine.cpp / FlagManager.cpp): when
// Graphite is enabled the factory is unconditionally GraphiteVkRenderEngine —
// the GL/VK axis of debug.renderengine.backend is IGNORED. A backend probe is
// therefore only a real experiment when Graphite is turned off alongside it.
//
// Controls (both opt-in; unset means stock):
//   ELIZAOS_GRIZZLY_RENDERENGINE_BACKEND  = skiagl|skiaglthreaded|skiavk|skiavkthreaded
//   ELIZAOS_GRIZZLY_RENDERENGINE_GRAPHITE = 0|1
// Setting a backend defaults Graphite to 0 so the requested backend actually
// runs; GRAPHITE=1 is rejected with a GL backend because that combination
// silently runs Vulkan anyway.
export function resolveRenderEngineOverrides(env = process.env) {
  const backend = env.ELIZAOS_GRIZZLY_RENDERENGINE_BACKEND?.trim() || null;
  const graphiteRaw = env.ELIZAOS_GRIZZLY_RENDERENGINE_GRAPHITE?.trim() || null;
  const allowedBackends = new Set([
    "skiagl",
    "skiaglthreaded",
    "skiavk",
    "skiavkthreaded",
  ]);
  if (backend && !allowedBackends.has(backend)) {
    fail(
      `ELIZAOS_GRIZZLY_RENDERENGINE_BACKEND must be one of ${[...allowedBackends].join(", ")}`,
    );
  }
  if (graphiteRaw !== null && graphiteRaw !== "0" && graphiteRaw !== "1") {
    fail("ELIZAOS_GRIZZLY_RENDERENGINE_GRAPHITE must be 0 or 1");
  }
  if (graphiteRaw === "1" && backend?.startsWith("skiagl")) {
    fail(
      "ELIZAOS_GRIZZLY_RENDERENGINE_GRAPHITE=1 with a GL backend is not a real experiment: Graphite is Vulkan-only and the GL axis would be ignored",
    );
  }
  // Stock keeps Graphite on; a backend override needs Graphite off to be
  // honored unless the probe explicitly asks for Graphite-on-Vulkan.
  const graphite = graphiteRaw !== null ? graphiteRaw === "1" : !backend;
  return { backend, graphite };
}

// EGL driver selection, opt-in via ELIZAOS_GRIZZLY_EGL (unset means stock).
//   angle  — keep the stock persist.graphics.egl=angle selection
//   native — drop the ANGLE selection so the loader uses the vendor's own
//            PowerVR GLES driver (ro.hardware.egl). This is the only
//            community-proven custom-ROM graphics stance on PowerVR Pixels:
//            LineageOS laguna (Pixel 10) ships ro.hardware.egl=powervr with
//            debug.renderengine.backend=skiaglthreaded and Graphite off.
export function resolveEglOverride(env = process.env) {
  const egl = env.ELIZAOS_GRIZZLY_EGL?.trim() || null;
  if (egl && egl !== "angle" && egl !== "native") {
    fail("ELIZAOS_GRIZZLY_EGL must be angle or native");
  }
  return egl;
}

export function normalizeGeneratedGraphicsProperties(aospRoot) {
  const filePath = path.join(
    aospRoot,
    "vendor/google_devices/grizzly/sysprop/vendor.prop",
  );
  if (!fs.existsSync(filePath)) return;
  const contents = fs.readFileSync(filePath, "utf8");
  const { backend, graphite } = resolveRenderEngineOverrides();
  const egl = resolveEglOverride();
  const withoutOverride = contents.replace(
    /^debug\.renderengine\.backend=(?:skiagl|skiaglthreaded|skiavk|skiavkthreaded)\n/m,
    "",
  );
  const graphiteAnchor = /^debug\.renderengine\.graphite=(?:true|false)$/m;
  if (!graphiteAnchor.test(withoutOverride)) {
    fail(`${filePath} is missing the stock debug.renderengine.graphite anchor`);
  }
  const graphiteLine = `debug.renderengine.graphite=${graphite ? "true" : "false"}`;
  let normalized = withoutOverride.replace(
    graphiteAnchor,
    backend
      ? `debug.renderengine.backend=${backend}\n${graphiteLine}`
      : graphiteLine,
  );
  if (egl === "native") {
    const nativeMarker = "# elizaOS: native PowerVR EGL override\n";
    const hasAngleLine = /^persist\.graphics\.egl=angle\n?/m.test(normalized);
    const alreadyApplied = /^ro\.hardware\.egl=/m.test(normalized);
    if (!hasAngleLine && !alreadyApplied) {
      fail(
        `${filePath} has no persist.graphics.egl=angle line to drop; the tree does not match the stock contract this override was written for`,
      );
    }
    normalized = normalized.replace(/^persist\.graphics\.egl=angle\n?/m, "");
    // Without the ANGLE selection the loader resolves the driver suffix from
    // ro.hardware.egl. Derive it from the vendor EGL payload rather than
    // assuming: exactly one non-ANGLE libEGL_<suffix>.so must exist.
    if (!alreadyApplied) {
      const eglDir = path.join(
        aospRoot,
        "vendor/google_devices/grizzly/proprietary/vendor/lib64/egl",
      );
      const suffixes = (fs.existsSync(eglDir) ? fs.readdirSync(eglDir) : [])
        .map((name) => name.match(/^libEGL_(.+)\.so$/)?.[1])
        .filter((suffix) => suffix && !suffix.includes("angle"));
      if (suffixes.length !== 1) {
        fail(
          `ELIZAOS_GRIZZLY_EGL=native needs exactly one non-ANGLE libEGL_<suffix>.so under vendor/lib64/egl to derive ro.hardware.egl; found: ${suffixes.join(", ") || "none"}`,
        );
      }
      normalized += `ro.hardware.egl=${suffixes[0]}\n`;
    }
    if (!normalized.includes(nativeMarker)) {
      normalized = nativeMarker + normalized;
    }
  }
  if (normalized !== contents) fs.writeFileSync(filePath, normalized);
}

const PROBE_INIT_FILES = [
  "vendor/google_devices/grizzly/proprietary/vendor/etc/init/hw/init.grizzly.rc",
  "vendor/google_devices/grizzly/proprietary/vendor/etc/init/hw/init.elizaos-debug.rc",
];

// Both the import and the generated diagnostic file carry the elizaOS marker.
// A partially applied probe pass must still count as contaminated.
const PROBE_SENTINELS = [/elizaos/i];

export function generatedTreeHasBringupProbes(aospRoot) {
  const files = [
    ...PROBE_INIT_FILES,
    "vendor/google_devices/grizzly/grizzly.mk",
  ];
  return files.some((relativePath) => {
    const filePath = path.join(aospRoot, relativePath);
    if (!fs.existsSync(filePath)) return false;
    const contents = fs.readFileSync(filePath, "utf8");
    if (relativePath.endsWith("grizzly.mk")) {
      // grizzly.mk legitimately contains no probe text by default; only the
      // probe copy-rule marks it.
      return (
        contents.includes("init.elizaos-debug.rc") ||
        contents.includes(
          "Match the stock Pixel 11 Pro Android 17 RenderEngine path",
        )
      );
    }
    return PROBE_SENTINELS.some((sentinel) => sentinel.test(contents));
  });
}

const F2FS_FALLBACK_FILES = [
  "vendor/google_devices/grizzly/proprietary/vendor/etc/fstab.malibu",
  "vendor/google_devices/grizzly/proprietary/vendor_ramdisk/system/etc/fstab.malibu",
  "vendor/google_devices/grizzly/proprietary/recovery/system/etc/recovery.fstab",
];

export function generatedTreeHasF2fsFallback(aospRoot) {
  return F2FS_FALLBACK_FILES.some((relativePath) => {
    const filePath = path.join(aospRoot, relativePath);
    return (
      fs.existsSync(filePath) &&
      /elizaos/i.test(fs.readFileSync(filePath, "utf8"))
    );
  });
}

// The native-EGL stance removes the stock persist.graphics.egl=angle line —
// not reversible in place, so a tree carrying it must be regenerated before a
// stock-EGL build can use it (mirrors the probe/f2fs contamination checks).
export function generatedTreeHasEglOverride(aospRoot) {
  const vendorProp = path.join(
    aospRoot,
    "vendor/google_devices/grizzly/sysprop/vendor.prop",
  );
  if (!fs.existsSync(vendorProp)) return false;
  return fs
    .readFileSync(vendorProp, "utf8")
    .includes("# elizaOS: native PowerVR EGL override");
}

export function normalizeGeneratedBringupProbes(aospRoot) {
  // Bring-up evidence must be observational. In particular, do not remove
  // stock module/storage waits or rewrite USB triggers: doing so changes the
  // boot path being diagnosed and can turn an evidence build into a new boot
  // failure. Keep the production flag on the same debuggable-only helper that
  // is covered by the init-ordering contract tests.
  stageGeneratedBringupDiagnostics(aospRoot);
}

// DIAGNOSTIC-ONLY init experiment, opt-in via
// ELIZAOS_GRIZZLY_KEYMASTER_NONBLOCKING=1. Keep this explicit and
// stamp-bound: it changes the stock post-fs-data keymaster notification from
// a synchronous wait into a background notification for boot diagnostics.
export function normalizeAospKeymasterInit(aospRoot, enabled = false) {
  const sourceInitPath = path.join(aospRoot, "system/core/rootdir/init.rc");
  const generatedRoot = path.join(aospRoot, "vendor/google_devices/grizzly");
  const overlayInitPath = path.join(
    generatedRoot,
    "diagnostics/system/etc/init/hw/init.rc",
  );
  const makefilePath = path.join(generatedRoot, "grizzly.mk");
  if (!fs.existsSync(sourceInitPath) || !fs.existsSync(makefilePath)) {
    fail(`keymaster diagnostic requires ${sourceInitPath} and ${makefilePath}`);
  }
  const contents = fs.readFileSync(sourceInitPath, "utf8");
  const blocking =
    "exec - system system -- /system/bin/vdc keymaster earlyBootEnded";
  const background =
    "exec_background - system system -- /system/bin/vdc keymaster earlyBootEnded";
  const marker = "elizaOS: diagnostic non-blocking keymaster notification";
  if (!enabled) {
    fs.rmSync(overlayInitPath, { force: true });
    const makefile = fs.readFileSync(makefilePath, "utf8");
    const withoutOverlay = makefile.replace(
      /\n?# elizaOS diagnostic keymaster init overlay\nPRODUCT_COPY_FILES \+= \\\n {4}vendor\/google_devices\/grizzly\/diagnostics\/system\/etc\/init\/hw\/init\.rc:\$\(TARGET_COPY_OUT_SYSTEM\)\/etc\/init\/hw\/init\.rc\n?/m,
      "\n",
    );
    if (withoutOverlay !== makefile)
      fs.writeFileSync(makefilePath, withoutOverlay);
    return;
  }
  const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockingPattern = new RegExp(
    `^([\\t ]*)${escapePattern(blocking)}$`,
    "m",
  );
  if (!blockingPattern.test(contents)) {
    if (
      new RegExp(`^([\\t ]*)${escapePattern(background)}$`, "m").test(contents)
    ) {
      fail(
        `${sourceInitPath} already uses exec_background without the elizaOS marker`,
      );
    }
    fail(
      `${sourceInitPath} is missing the expected vdc keymaster earlyBootEnded command`,
    );
  }
  const normalized = contents.replace(
    blockingPattern,
    `$1# ${marker}\n$1${background}`,
  );
  fs.mkdirSync(path.dirname(overlayInitPath), { recursive: true });
  if (
    !fs.existsSync(overlayInitPath) ||
    fs.readFileSync(overlayInitPath, "utf8") !== normalized
  )
    fs.writeFileSync(overlayInitPath, normalized);
  const makefile = fs.readFileSync(makefilePath, "utf8");
  const copyEntry =
    "    vendor/google_devices/grizzly/diagnostics/system/etc/init/hw/init.rc:$(TARGET_COPY_OUT_SYSTEM)/etc/init/hw/init.rc";
  if (!makefile.includes(copyEntry))
    fs.writeFileSync(
      makefilePath,
      `${makefile.trimEnd()}\n\n# elizaOS diagnostic keymaster init overlay\nPRODUCT_COPY_FILES += \\\n${copyEntry}\n`,
    );
}

export function generatedTreeHasKeymasterOverride(aospRoot) {
  const generatedRoot = path.join(aospRoot, "vendor/google_devices/grizzly");
  const overlayPath = path.join(
    generatedRoot,
    "diagnostics/system/etc/init/hw/init.rc",
  );
  const makefilePath = path.join(generatedRoot, "grizzly.mk");
  return (
    (fs.existsSync(overlayPath) &&
      /diagnostic non-blocking keymaster notification/.test(
        fs.readFileSync(overlayPath, "utf8"),
      )) ||
    (fs.existsSync(makefilePath) &&
      /diagnostic keymaster init overlay/.test(
        fs.readFileSync(makefilePath, "utf8"),
      ))
  );
}

// After the generated tree exists, prove the graphics stack adevtool extracted
// is complete enough to boot past SurfaceFlinger init. These are the pieces
// whose absence produces a silent hang or an EGL-loader abort at runtime; the
// lock's requiredFiles cannot pin them because their exact names come from the
// factory image.
export function assertGeneratedGraphicsStack(aospRoot) {
  const vendorRoot = path.join(
    aospRoot,
    "vendor/google_devices/grizzly/proprietary/vendor",
  );
  if (!fs.existsSync(vendorRoot)) {
    fail(`generated vendor payload missing: ${vendorRoot}`);
  }
  const listDir = (relative) => {
    const dir = path.join(vendorRoot, relative);
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };
  const eglLibs = listDir("lib64/egl");
  if (eglLibs.length === 0) {
    fail("generated vendor tree has no EGL drivers under vendor/lib64/egl");
  }
  const hwLibs = listDir("lib64/hw");
  if (!hwLibs.some((name) => name.startsWith("vulkan."))) {
    fail("generated vendor tree has no Vulkan ICD under vendor/lib64/hw");
  }
  const halBinaries = listDir("bin/hw");
  if (!halBinaries.some((name) => /composer/i.test(name))) {
    fail(
      "generated vendor tree has no composer HAL service under vendor/bin/hw",
    );
  }
  if (!halBinaries.some((name) => /allocator/i.test(name))) {
    fail(
      "generated vendor tree has no graphics allocator service under vendor/bin/hw",
    );
  }
  // The EGL loader has no fallback when ANGLE is selected: every EGL client
  // (SurfaceFlinger included) aborts if persist.graphics.egl=angle and the
  // ANGLE libraries are absent from the search path.
  const vendorProp = path.join(
    aospRoot,
    "vendor/google_devices/grizzly/sysprop/vendor.prop",
  );
  if (
    fs.existsSync(vendorProp) &&
    /^persist\.graphics\.egl=angle$/m.test(
      fs.readFileSync(vendorProp, "utf8"),
    ) &&
    !fs.existsSync(path.join(aospRoot, "external/angle"))
  ) {
    fail(
      "vendor.prop selects persist.graphics.egl=angle but the AOSP external/angle source is absent; the staged EGL loader would abort every client in this state",
    );
  }
  const firmwareDir = path.join(vendorRoot, "firmware");
  const firmwareEntries = fs.existsSync(firmwareDir)
    ? fs.readdirSync(firmwareDir, { recursive: true })
    : [];
  if (!firmwareEntries.some((name) => /pvr|rgx|powervr/i.test(String(name)))) {
    // Not fatal: the PowerVR firmware layout on malibu is not publicly
    // documented, and it may ship outside vendor/firmware. Surface it loudly
    // so a missing-GPU-firmware image is never built silently.
    console.warn(
      "[distro-android:grizzly] WARNING: no PowerVR/RGX firmware found under vendor/firmware; verify GPU firmware against the stock factory image before flashing",
    );
  }
}

const PREPARE_STAMP_RELATIVE_PATH =
  "vendor/google_devices/grizzly/.elizaos-prepare-stamp.json";

export function currentPrepareStamp(env = process.env) {
  const { backend, graphite } = resolveRenderEngineOverrides(env);
  return {
    renderengineBackend: backend,
    renderengineGraphite: graphite,
    eglSelection: resolveEglOverride(env),
    earlyBootProbes: env.ELIZAOS_GRIZZLY_EARLY_BOOT_PROBES === "1",
    conservativeF2fs: env.ELIZAOS_GRIZZLY_CONSERVATIVE_F2FS === "1",
    keymasterNonblocking: env.ELIZAOS_GRIZZLY_KEYMASTER_NONBLOCKING === "1",
  };
}

function writePrepareStamp(aospRoot) {
  fs.writeFileSync(
    path.join(aospRoot, PREPARE_STAMP_RELATIVE_PATH),
    `${JSON.stringify(currentPrepareStamp(), null, 2)}\n`,
  );
}

// Builds that consume the generated tree must fail closed when the tree was
// prepared under a different probe/renderer environment than the one the
// build is running with — otherwise "A/B images" silently become identical.
export function assertPreparedTreeMatchesEnv(aospRoot, env = process.env) {
  const stampPath = path.join(aospRoot, PREPARE_STAMP_RELATIVE_PATH);
  if (!fs.existsSync(stampPath)) {
    fail(
      `generated grizzly tree has no prepare stamp (${PREPARE_STAMP_RELATIVE_PATH}); rerun prepare-grizzly before building`,
    );
  }
  const stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
  const expected = currentPrepareStamp(env);
  const mismatches = Object.keys(expected).filter(
    (key) => stamp[key] !== expected[key],
  );
  if (mismatches.length > 0) {
    fail(
      `generated grizzly tree was prepared under a different environment (${mismatches
        .map(
          (key) =>
            `${key}: prepared=${JSON.stringify(stamp[key])} env=${JSON.stringify(expected[key])}`,
        )
        .join(
          "; ",
        )}); rerun prepare-grizzly with the intended ELIZAOS_GRIZZLY_* settings`,
    );
  }
}

// Compatibility front doors retained for existing build-contract callers. The
// production prepare path uses the stamped, opt-in helpers above; these
// wrappers preserve the older explicit test/tool API without enabling any
// diagnostics implicitly during a normal build.
export function normalizeGeneratedRenderEngine(aospRoot) {
  const makefilePath = path.join(
    aospRoot,
    "vendor/google_devices/grizzly/grizzly.mk",
  );
  if (!fs.existsSync(makefilePath)) return;
  const contents = fs.readFileSync(makefilePath, "utf8");
  if (contents.includes("debug.renderengine.graphite=true")) return;
  fs.writeFileSync(
    makefilePath,
    `${contents.trimEnd()}\n\n# Match the stock Pixel 11 Pro Android 17 RenderEngine path.\nPRODUCT_SYSTEM_PROPERTIES += \\\n    debug.renderengine.graphite=true\n`,
  );
}

export function stageGeneratedBringupDiagnostics(aospRoot) {
  const generatedRoot = path.join(aospRoot, "vendor/google_devices/grizzly");
  const stockInitPath = path.join(
    generatedRoot,
    "proprietary/vendor/etc/init/hw/init.grizzly.rc",
  );
  const makefilePath = path.join(generatedRoot, "grizzly.mk");
  for (const requiredPath of [stockInitPath, makefilePath]) {
    if (!fs.existsSync(requiredPath)) {
      fail(`generated bring-up diagnostics require ${requiredPath}`);
    }
  }
  const importLine = "import /vendor/etc/init/hw/init.elizaos-debug.rc";
  const stockInit = fs.readFileSync(stockInitPath, "utf8");
  if (!stockInit.includes(importLine)) {
    const normalized = stockInit.replace(
      /^# grizzly specific init\.rc$/m,
      `# grizzly specific init.rc\n${importLine}`,
    );
    if (normalized === stockInit) {
      fail("generated init.grizzly.rc is missing its expected header");
    }
    fs.chmodSync(stockInitPath, 0o644);
    fs.writeFileSync(stockInitPath, normalized);
  }
  const debugInitPath = path.join(
    generatedRoot,
    "proprietary/vendor/etc/init/hw/init.elizaos-debug.rc",
  );
  fs.mkdirSync(path.dirname(debugInitPath), { recursive: true });
  fs.writeFileSync(
    debugInitPath,
    `# elizaOS userdebug bring-up diagnostics; remove after hardware qualification.\n\non early-init && property:ro.debuggable=1\n    write /dev/kmsg "elizaos-init: early-init reached"\n    write /metadata/elizaos_vendor_early_init.marker 1\n\non post-fs && property:ro.debuggable=1\n    write /dev/kmsg "elizaos-init: post-fs reached"\n    write /metadata/elizaos_vendor_post_fs.marker 1\n\non late-fs && property:ro.debuggable=1\n    write /dev/kmsg "elizaos-init: late-fs reached"\n    write /metadata/elizaos_vendor_late_fs.marker 1\n\non post-fs-data && property:ro.debuggable=1\n    write /dev/kmsg "elizaos-init: post-fs-data reached"\n    write /metadata/elizaos_vendor_post_fs_data.marker 1\n\non boot && property:ro.debuggable=1\n    write /dev/kmsg "elizaos-init: boot reached"\n    write /metadata/elizaos_vendor_boot.marker 1\n`,
  );
  fs.chmodSync(debugInitPath, 0o644);
  for (const issue of lintInitRc(debugInitPath)) {
    if (!issue.soft) {
      fail(`init lint error: ${debugInitPath}:${issue.line}: ${issue.message}`);
    }
  }
  const copyDestination =
    "$(TARGET_COPY_OUT_VENDOR)/etc/init/hw/init.elizaos-debug.rc";
  const copyEntry = `    vendor/google_devices/grizzly/proprietary/vendor/etc/init/hw/init.elizaos-debug.rc:${copyDestination}`;
  const makefile = fs.readFileSync(makefilePath, "utf8");
  if (!makefile.includes(copyDestination)) {
    fs.writeFileSync(
      makefilePath,
      `${makefile.trimEnd()}\n\n# elizaOS userdebug bring-up diagnostics\nPRODUCT_COPY_FILES += \\\n${copyEntry}\n`,
    );
  }
}

function fail(message) {
  throw new Error(`[distro-android:grizzly] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited ${result.status}`);
  }
}

export function parseArgs(argv) {
  const options = {
    aospRoot: "",
    lockPath: defaultLockPath,
    skipInstall: false,
    skipRollbackDownload: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--aosp-root" && value) {
      options.aospRoot = path.resolve(value);
      index += 1;
    } else if (argument === "--lock" && value) {
      options.lockPath = path.resolve(value);
      index += 1;
    } else if (argument === "--skip-install") {
      options.skipInstall = true;
    } else if (argument === "--skip-rollback-download") {
      options.skipRollbackDownload = true;
    } else {
      fail(`unknown or incomplete argument: ${argument}`);
    }
  }
  if (!options.aospRoot) fail("--aosp-root is required");
  return options;
}

function downloadLockedArtifact(contract, destination) {
  if (fs.existsSync(destination)) return;
  const partial = `${destination}.partial`;
  console.log(
    `[distro-android:grizzly] downloading ${contract.filename}; this download is governed by Google's Pixel factory-image terms`,
  );
  run("curl", [
    "--location",
    "--fail",
    "--retry",
    "5",
    "--continue-at",
    "-",
    "--output",
    partial,
    contract.url,
  ]);
}

export async function prepareGrizzly({
  aospRoot,
  lockPath,
  skipInstall = false,
  skipRollbackDownload = false,
}) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    fail("Pixel 11 Pro vendor generation requires a Linux x86_64 builder");
  }
  if (!fs.existsSync(path.join(aospRoot, "build/envsetup.sh"))) {
    fail(`${aospRoot} is not a complete AOSP checkout`);
  }
  const lock = loadAospLock(lockPath);
  if (lock.device?.codename !== "grizzly" || !lock.generatedVendor) {
    fail(`${lockPath} is not a Pixel 11 Pro generated-vendor lock`);
  }
  materializeExternalProjects(aospRoot, lock);
  assertPinnedAospCheckout(aospRoot, lock);
  const overlayResult = await materializeLockedSourceOverlays(aospRoot, lock);
  const overlayStamp = JSON.stringify(
    overlayResult.overlays.map(({ path: overlayPath, sha256 }) => ({
      path: overlayPath,
      sha256,
    })),
  );
  const overlayStampPath = path.join(
    aospRoot,
    "out_adevtool_deps/.elizaos-source-overlay-stamp.json",
  );
  const existingOverlayStamp = fs.existsSync(overlayStampPath)
    ? fs.readFileSync(overlayStampPath, "utf8")
    : "";
  if (overlayResult.changed || existingOverlayStamp !== overlayStamp) {
    // adevtool's host tools are compiled from the AOSP tree. Invalidate only
    // its disposable dependency output when a source overlay changes.
    fs.rmSync(path.join(aospRoot, "out_adevtool_deps"), {
      recursive: true,
      force: true,
    });
  }

  const adevtoolRoot = path.join(aospRoot, "vendor/adevtool");
  if (!skipInstall) {
    run("corepack", ["yarn", "install", "--frozen-lockfile"], {
      cwd: adevtoolRoot,
    });
  }
  const generatedRoot = path.join(aospRoot, "vendor/google_devices/grizzly");
  const enableBringupProbes =
    process.env.ELIZAOS_GRIZZLY_EARLY_BOOT_PROBES === "1";
  const conservativeF2fs =
    process.env.ELIZAOS_GRIZZLY_CONSERVATIVE_F2FS === "1";
  const keymasterNonblocking =
    process.env.ELIZAOS_GRIZZLY_KEYMASTER_NONBLOCKING === "1";
  let generatedTreeComplete = false;
  if (
    fs.existsSync(generatedRoot) &&
    ((!enableBringupProbes && generatedTreeHasBringupProbes(aospRoot)) ||
      (!conservativeF2fs && generatedTreeHasF2fsFallback(aospRoot)) ||
      (!keymasterNonblocking && generatedTreeHasKeymasterOverride(aospRoot)) ||
      (resolveEglOverride() !== "native" &&
        generatedTreeHasEglOverride(aospRoot)))
  ) {
    // Probe, fstab-fallback, and native-EGL edits are intentionally
    // disposable (none are reversible in place — stock lines were replaced
    // or removed). Regenerate the vendor tree so a default build cannot
    // silently inherit an earlier diagnostic image.
    fs.rmSync(generatedRoot, { recursive: true, force: true });
  }
  if (fs.existsSync(generatedRoot)) {
    try {
      normalizeGeneratedBuildIdGuard(aospRoot);
      normalizeGeneratedProprietaryNamespace(aospRoot);
      normalizeGeneratedSePolicy(aospRoot);
      normalizeGeneratedVintf(aospRoot);
      normalizeAospKeymasterInit(aospRoot, keymasterNonblocking);
      if (conservativeF2fs) normalizeGeneratedF2fsMountOptions(aospRoot);
      normalizeGeneratedGraphicsProperties(aospRoot);
      if (enableBringupProbes) normalizeGeneratedBringupProbes(aospRoot);
      assertGeneratedVendorTree(aospRoot, lock);
      generatedTreeComplete = true;
    } catch {
      // A failed adevtool run can leave a partial tree that is unsafe to
      // merge into on retry. Remove only this generated device directory.
      fs.rmSync(generatedRoot, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(path.dirname(overlayStampPath), { recursive: true });
  fs.writeFileSync(overlayStampPath, overlayStamp);

  if (!generatedTreeComplete) {
    const [commandName, ...commandArguments] = lock.generatedVendor.command;
    const command =
      commandName === "adevtool"
        ? path.join(adevtoolRoot, "bin/run")
        : commandName;
    run(command, commandArguments, {
      cwd: aospRoot,
      env: withSisoCompatibility(),
    });
    normalizeGeneratedBuildIdGuard(aospRoot);
    normalizeGeneratedProprietaryNamespace(aospRoot);
    normalizeGeneratedSePolicy(aospRoot);
    normalizeGeneratedVintf(aospRoot);
    normalizeAospKeymasterInit(aospRoot, keymasterNonblocking);
    if (conservativeF2fs) normalizeGeneratedF2fsMountOptions(aospRoot);
    normalizeGeneratedGraphicsProperties(aospRoot);
    if (enableBringupProbes) normalizeGeneratedBringupProbes(aospRoot);
  }
  const files = assertGeneratedVendorTree(aospRoot, lock);
  assertGeneratedGraphicsStack(aospRoot);
  writePrepareStamp(aospRoot);

  const downloadRoot = path.join(adevtoolRoot, "dl");
  const referenceImage = path.join(
    downloadRoot,
    lock.referenceFactoryImage.filename,
  );
  await verifyLockedArtifact(lock.referenceFactoryImage, referenceImage, {
    label: "Pixel 11 Pro reference factory image",
  });
  if (!skipRollbackDownload) {
    fs.mkdirSync(downloadRoot, { recursive: true });
    const rollbackImage = path.join(
      downloadRoot,
      lock.rollbackFactoryImage.filename,
    );
    downloadLockedArtifact(lock.rollbackFactoryImage, rollbackImage);
    const partial = `${rollbackImage}.partial`;
    if (!fs.existsSync(rollbackImage) && fs.existsSync(partial)) {
      await verifyLockedArtifact(lock.rollbackFactoryImage, partial, {
        enforceFilename: false,
        label: "Pixel 11 Pro rollback factory image",
      });
      fs.renameSync(partial, rollbackImage);
    }
    await verifyLockedArtifact(lock.rollbackFactoryImage, rollbackImage, {
      label: "Pixel 11 Pro rollback factory image",
    });
  }
  console.log(
    `[distro-android:grizzly] generated and verified ${files.length} required Pixel 11 Pro vendor files`,
  );
  return { lock, files };
}

if (isMainModule(import.meta)) {
  await prepareGrizzly(parseArgs(process.argv.slice(2)));
}
