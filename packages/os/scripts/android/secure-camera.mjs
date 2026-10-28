/**
 * System secure camera for every brand's AOSP image.
 *
 * Capture over Keyguard belongs to the stock AOSP Camera2 SecureCameraActivity
 * and the standard SystemUI power-button gesture. A launcher never puts its own
 * surface over the lock screen and never handles the secure capture actions.
 * This module authenticates the reviewed source inputs, stages the product
 * overlay, refuses a launcher manifest with a lock-screen surface and runs
 * read-only checks on a booted image. None of it proves locked-capture
 * isolation, unlock return or device acceptance.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { manifestComponents } from "./launcher-provisioning.mjs";

export const SECURE_CAMERA_CONTRACT = new URL(
  "../../android/sources/secure-camera.json",
  import.meta.url,
);
export const secureCameraPackage = "com.android.camera2";
export const secureCameraComponent = `${secureCameraPackage}/com.android.camera.SecureCameraActivity`;
export const secureCameraActions = [
  "STILL_IMAGE_CAMERA_SECURE",
  "IMAGE_CAPTURE_SECURE",
];
const packageName = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function loadSecureCameraContract(file = SECURE_CAMERA_CONTRACT) {
  const contract = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    contract?.schemaVersion !== 1 ||
    !Array.isArray(contract.modules) ||
    !contract.modules.length ||
    contract.modules.some(
      (module) =>
        typeof module?.path !== "string" ||
        !/^[0-9a-f]{40}$/.test(module.commit ?? "") ||
        !module.files ||
        Object.values(module.files).some(
          (digest) => !/^[0-9a-f]{64}$/.test(digest),
        ),
    )
  )
    throw new Error("Invalid secure camera source contract");
  return contract;
}

/** Authenticate source inputs only. A clean pinned checkout is not a built-image receipt. */
export function verifySecureCameraSource(
  root,
  contract = loadSecureCameraContract(),
  reviewedOverrides = [],
) {
  if (!root)
    throw new Error("Production staging requires explicit --aosp-source PATH");
  const base = fs.realpathSync(root);
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  const modules = contract.modules.map((module) => {
    const directory = fs.realpathSync(path.join(base, module.path));
    // Repo shadow workspaces may link module roots; authenticate their actual Git tree and bytes.
    const git = (...args) =>
      execFileSync("git", ["-C", directory, ...args], {
        encoding: "utf8",
        env,
        timeout: 60_000,
        maxBuffer: 64 << 20,
      }).trim();
    if (git("rev-parse", "HEAD") !== module.commit)
      throw new Error(`Unreviewed source revision: ${module.path}`);
    // Index hints can hide tracked changes from status; ignored Java files also enter src/**/*.java.
    if (
      git("ls-files", "-v")
        .split("\n")
        .some((row) => row && !row.startsWith("H "))
    )
      throw new Error(`Source index hides changes: ${module.path}`);
    if (git("ls-files", "--others", "--ignored", "--exclude-standard"))
      throw new Error(`Ignored source inputs present: ${module.path}`);
    // Includes untracked sources because Camera2 compiles src/**/*.java.
    const changes = execFileSync(
      "git",
      [
        "-C",
        directory,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ],
      { encoding: "utf8", env, timeout: 60_000, maxBuffer: 64 << 20 },
    )
      .split("\0")
      .filter(Boolean);
    const allowed = reviewedOverrides.filter((entry) =>
      entry.path.startsWith(`${module.path}/`),
    );
    const actual = changes
      .map((row) => `${module.path}/${row.slice(3)}`)
      .sort();
    if (
      JSON.stringify(actual) !==
      JSON.stringify(allowed.map((entry) => entry.path).sort())
    )
      throw new Error(`Source module is not clean: ${module.path}`);
    for (const entry of allowed) {
      const file = fs.realpathSync(path.join(base, entry.path));
      if (
        !file.startsWith(directory + path.sep) ||
        fs.statSync(file).size !== entry.sizeBytes ||
        sha(fs.readFileSync(file)) !== entry.sha256
      )
        throw new Error(`Reviewed source override differs: ${entry.path}`);
    }
    for (const [relative, expected] of Object.entries(module.files)) {
      const file = fs.realpathSync(path.join(directory, relative));
      if (
        !file.startsWith(directory + path.sep) ||
        sha(fs.readFileSync(file)) !== expected
      )
        throw new Error(`Source bytes differ: ${module.path}/${relative}`);
    }
    return { path: module.path, commit: module.commit, files: module.files };
  });
  return {
    sourceVerified: true,
    contractSha256: sha(JSON.stringify(contract)),
    modules,
    reviewedOverrides,
    imageVerified: false,
    lockedCaptureVerified: false,
    deviceAcceptanceVerified: false,
  };
}

/** Stage Camera2 and the standard SystemUI power gesture into a launcher product. */
export function writeSecureCameraOverlay(output, evidence) {
  const productMakefile = path.join(output, "product.mk");
  if (!fs.existsSync(productMakefile))
    throw new Error("Secure camera staging requires a staged product.mk");
  const files = {
    "secure-camera/overlay/frameworks/base/core/res/res/values/config.xml":
      '<?xml version="1.0" encoding="utf-8"?>\n<resources><bool name="config_cameraDoubleTapPowerGestureEnabled">true</bool></resources>\n',
    "secure-camera/overlay/frameworks/base/packages/SystemUI/res/values/config.xml": `<?xml version="1.0" encoding="utf-8"?>\n<resources><string name="config_cameraGesturePackage" translatable="false">${secureCameraPackage}</string></resources>\n`,
    "secure-camera/README.md":
      "# System secure camera\n\nCamera2 and the standard SystemUI power gesture are staged here. See source-evidence.json for the exact source verification result. Staging does not prove image consumption, locked capture isolation, unlock return or physical device acceptance.\n",
    "secure-camera/source-evidence.json": `${JSON.stringify(evidence, null, 2)}\n`,
  };
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(output, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, { flag: "wx" });
  }
  fs.appendFileSync(
    productMakefile,
    "\n# Standard AOSP secure camera and SystemUI power gesture; no launcher lock-screen activity.\nPRODUCT_PACKAGES += Camera2\nsecure_camera_dir := $(patsubst %/,%,$(dir $(lastword $(MAKEFILE_LIST))))/secure-camera\nPRODUCT_PACKAGE_OVERLAYS += $(secure_camera_dir)/overlay\n",
  );
  return Object.keys(files);
}

/**
 * Read-only image checks for one explicit user and image fingerprint. Never
 * launches capture, unlocks, grants permission or reads photos.
 */
export function verifySecureCameraImage(
  run,
  user,
  expectedFingerprint,
  { launcherPackage, brand = launcherPackage } = {},
) {
  if (!/^(0|[1-9]\d*)$/.test(user || ""))
    throw new Error("Explicit Android user required");
  if (!expectedFingerprint?.trim())
    throw new Error("Explicit expected image fingerprint required");
  if (!packageName.test(launcherPackage ?? ""))
    throw new Error("Explicit launcher package required");
  const fingerprint = run("shell", "getprop", "ro.build.fingerprint").trim();
  if (fingerprint !== expectedFingerprint)
    throw new Error("Image fingerprint differs from expected target");
  const packages = run(
    "shell",
    "pm",
    "list",
    "packages",
    "--user",
    user,
    "-s",
    "-e",
    secureCameraPackage,
  );
  if (!packages.split(/\r?\n/).includes(`package:${secureCameraPackage}`))
    throw new Error("Required system Camera2 is not enabled for selected user");
  const query = (action, ...scope) =>
    run(
      "shell",
      "cmd",
      "package",
      "query-activities",
      "--brief",
      "--components",
      "--user",
      user,
      "-a",
      `android.media.action.${action}`,
      "-c",
      "android.intent.category.DEFAULT",
      ...scope,
    )
      .trim()
      .split(/\r?\n/)
      .map((row) => row.trim());
  const handlers = {};
  for (const action of secureCameraActions) {
    if (
      !query(action, "-p", secureCameraPackage).includes(secureCameraComponent)
    )
      throw new Error(`Required secure camera handler missing: ${action}`);
    if (query(action).some((row) => row.startsWith(`${launcherPackage}/`)))
      throw new Error(
        `${brand} must not handle secure camera action: ${action}`,
      );
    handlers[action] = secureCameraComponent;
  }
  const lookup = (pkg, resource) =>
    run(
      "shell",
      "cmd",
      "overlay",
      "lookup",
      "--user",
      user,
      pkg,
      `${pkg}:${resource}`,
    ).trim();
  if (
    lookup("android", "bool/config_cameraDoubleTapPowerGestureEnabled") !==
    "true"
  )
    throw new Error("System power camera gesture is not enabled");
  if (
    lookup("com.android.systemui", "string/config_cameraGesturePackage") !==
    secureCameraPackage
  )
    throw new Error("SystemUI camera gesture does not target reviewed Camera2");
  const disabled = run(
    "shell",
    "settings",
    "--user",
    user,
    "get",
    "secure",
    "camera_double_tap_power_gesture_disabled",
  ).trim();
  if (!["null", "0"].includes(disabled))
    throw new Error("Selected user disabled the power camera gesture");
  const features = run("shell", "pm", "list", "features");
  if (!features.split(/\r?\n/).includes("feature:android.hardware.camera.any"))
    throw new Error("Image has no camera feature");
  return {
    user,
    fingerprint,
    packageName: secureCameraPackage,
    handlers,
    imageContractVerified: true,
    lockedCaptureVerified: false,
    unlockPrivacyVerified: false,
    deviceAcceptanceVerified: false,
  };
}

/** Refuse a launcher APK manifest (aapt xmltree) that shows over Keyguard or handles secure capture. */
export function assertNoLockScreenSurface(
  xmltree,
  { brand = "The launcher" } = {},
) {
  const problems = [];
  for (const row of manifestComponents(xmltree)) {
    if (row.tag === "service") continue;
    for (const attr of ["showWhenLocked", "showOnLockScreen", "turnScreenOn"])
      if (row.attrs[attr] !== undefined && row.attrs[attr] !== "0x0")
        problems.push(`${row.name} sets android:${attr}`);
    for (const filter of row.filters)
      for (const action of filter.actions)
        if (
          secureCameraActions.some(
            (name) => `android.media.action.${name}` === action,
          )
        )
          problems.push(`${row.name} handles ${action}`);
  }
  if (problems.length)
    throw new Error(
      `Refusing the APK: ${brand} does not implement a secure camera or lock-screen surface; the system Camera2 owns capture over Keyguard.\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
  return true;
}
