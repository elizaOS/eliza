/** System secure camera: source admission, staging, launcher manifest policy and read-only image checks. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertNoLockScreenSurface,
  changedPaths,
  loadSecureCameraContract,
  secureCameraActions,
  secureCameraComponent,
  verifySecureCameraImage,
  verifySecureCameraSource,
  writeSecureCameraOverlay,
} from "../android/secure-camera.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const temporary = (t, prefix) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

test("the shared contract pins Camera2, the framework gesture and the manifest", () => {
  const contract = loadSecureCameraContract();
  assert.deepEqual(
    contract.modules.map((module) => module.path),
    [
      ".repo/manifests",
      "packages/apps/Camera2",
      "frameworks/base",
      "build/make",
    ],
  );
  assert.ok(
    contract.modules.find((module) => module.path === "packages/apps/Camera2")
      .files["src/com/android/camera/SecureCameraActivity.java"],
  );
  const lock = JSON.parse(
    fs.readFileSync(
      new URL("../../android/aosp.lock.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    contract.modules[0].commit,
    lock.profiles.pixel10a.manifest.commit,
    "reviewed against the Pixel 10a Android 17 manifest",
  );
});

test("source admission rejects missing path, unreviewed revisions, dirty sources and mismatched bytes", (t) => {
  const root = temporary(t, "secure-camera-");
  const dir = path.join(root, "Camera2");
  fs.mkdirSync(dir);
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  fs.writeFileSync(
    path.join(dir, "Android.bp"),
    'android_app { name: "Camera2" }\n',
  );
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-q",
    "-m",
    "fixture",
  );
  const contract = {
    schemaVersion: 1,
    modules: [
      {
        path: "Camera2",
        commit: git("rev-parse", "HEAD"),
        files: {
          "Android.bp": hash(fs.readFileSync(path.join(dir, "Android.bp"))),
        },
      },
    ],
  };
  assert.throws(() => verifySecureCameraSource(null), /explicit --aosp-source/);
  const evidence = verifySecureCameraSource(root, contract);
  assert.equal(evidence.sourceVerified, true);
  assert.equal(evidence.lockedCaptureVerified, false);
  const wrong = structuredClone(contract);
  wrong.modules[0].commit = "0".repeat(40);
  assert.throws(() => verifySecureCameraSource(root, wrong), /Unreviewed/);
  wrong.modules[0].commit = contract.modules[0].commit;
  wrong.modules[0].files["Android.bp"] = "0".repeat(64);
  assert.throws(() => verifySecureCameraSource(root, wrong), /bytes differ/);
  for (const flag of ["assume-unchanged", "skip-worktree"]) {
    git("update-index", `--${flag}`, "Android.bp");
    assert.throws(
      () => verifySecureCameraSource(root, contract),
      /index hides changes/,
    );
    git("update-index", `--no-${flag}`, "Android.bp");
  }
  fs.appendFileSync(path.join(dir, ".git/info/exclude"), "\nIgnored.java\n");
  fs.writeFileSync(path.join(dir, "Ignored.java"), "ignored input");
  assert.throws(
    () => verifySecureCameraSource(root, contract),
    /Ignored source inputs/,
  );
  fs.unlinkSync(path.join(dir, "Ignored.java"));
  fs.writeFileSync(path.join(dir, "Injected.java"), "untracked");
  assert.throws(() => verifySecureCameraSource(root, contract), /not clean/);
  fs.unlinkSync(path.join(dir, "Injected.java"));
  fs.writeFileSync(path.join(dir, "tool.txt"), "reviewed tooling");
  const override = {
    path: "Camera2/tool.txt",
    sizeBytes: Buffer.byteLength("reviewed tooling"),
    sha256: hash("reviewed tooling"),
  };
  assert.equal(
    verifySecureCameraSource(root, contract, [override]).sourceVerified,
    true,
  );
  fs.appendFileSync(path.join(dir, "tool.txt"), "changed");
  assert.throws(
    () => verifySecureCameraSource(root, contract, [override]),
    /override differs/,
  );
  fs.unlinkSync(path.join(dir, "tool.txt"));
  assert.throws(
    () => verifySecureCameraSource(root, contract, [override]),
    /not clean/,
  );
  fs.appendFileSync(path.join(dir, "Android.bp"), "dirty");
  assert.throws(
    () => verifySecureCameraSource(root, contract),
    /not clean: Camera2; unreviewed changes: Camera2\/Android.bp/,
  );
  git("checkout", "--", "Android.bp");
  // A staged rename is one porcelain row plus its origin; both paths must be reviewed.
  git("mv", "Android.bp", "Moved.bp");
  assert.throws(
    () => verifySecureCameraSource(root, contract),
    /unreviewed changes: Camera2\/Android.bp, Camera2\/Moved.bp$/,
  );
  git("mv", "Moved.bp", "Android.bp");
  assert.equal(verifySecureCameraSource(root, contract).sourceVerified, true);
});

test("git status parsing keeps rename origins and refuses malformed rows", () => {
  assert.deepEqual(changedPaths(""), []);
  assert.deepEqual(changedPaths(" M a.java\0R  b.java\0c.java\0?? d.java\0"), [
    "a.java",
    "b.java",
    "c.java",
    "d.java",
  ]);
  assert.deepEqual(changedPaths("C  e.java\0f.java\0"), ["e.java", "f.java"]);
  assert.throws(() => changedPaths("R  b.java\0"), /rename entry/);
  assert.throws(() => changedPaths("bad\0"), /Unexpected git status entry/);
});

const LAUNCHER = "ai.elizaos.app";
function device(overrides = {}) {
  const calls = [];
  const run = (...args) => {
    calls.push(args);
    const command = args.join(" ");
    if (command.includes("getprop"))
      return overrides.fingerprint ?? "fixture/image";
    if (command.includes("list packages"))
      return overrides.packages ?? "package:com.android.camera2\n";
    if (command.includes("query-activities"))
      return (
        (!args.includes("-p") ? overrides.globalHandler : undefined) ??
        overrides.handler ??
        secureCameraComponent
      );
    if (command.includes("bool/config")) return overrides.gesture ?? "true";
    if (command.includes("string/config"))
      return overrides.target ?? "com.android.camera2";
    if (command.includes("settings")) return overrides.disabled ?? "null";
    if (command.includes("list features"))
      return overrides.features ?? "feature:android.hardware.camera.any\n";
    throw new Error(`Unexpected command ${command}`);
  };
  return { run, calls };
}

test("image checks bind explicit user, fingerprint and launcher, and only read system routing", () => {
  const { run, calls } = device();
  const result = verifySecureCameraImage(run, "10", "fixture/image", {
    launcherPackage: LAUNCHER,
  });
  assert.equal(result.imageContractVerified, true);
  assert.equal(result.lockedCaptureVerified, false);
  assert.equal(result.unlockPrivacyVerified, false);
  assert.equal(
    calls.filter((call) => call.includes("query-activities")).length,
    4,
  );
  for (const call of calls)
    assert.ok(
      !call.some((value) =>
        ["start", "grant", "put", "delete", "install", "uninstall"].includes(
          value,
        ),
      ),
    );
  assert.throws(
    () =>
      verifySecureCameraImage(run, "", "fixture/image", {
        launcherPackage: LAUNCHER,
      }),
    /user required/,
  );
  assert.throws(
    () =>
      verifySecureCameraImage(run, "10", null, { launcherPackage: LAUNCHER }),
    /fingerprint required/,
  );
  assert.throws(
    () => verifySecureCameraImage(run, "10", "fixture/image"),
    /launcher package required/,
  );
});

for (const [name, override, error] of [
  ["wrong image", { fingerprint: "other" }, /fingerprint differs/],
  [
    "missing system camera",
    { packages: "package:com.other.camera" },
    /not enabled/,
  ],
  [
    "launcher secure handler",
    { globalHandler: `${LAUNCHER}/.Camera` },
    /Eliza must not handle/,
  ],
  [
    "wrong secure handler",
    { handler: "com.android.camera2/com.android.camera.CameraActivity" },
    /handler missing/,
  ],
  ["disabled power gesture", { gesture: "false" }, /not enabled/],
  ["wrong system target", { target: LAUNCHER }, /does not target/],
  ["user opt out", { disabled: "1" }, /user disabled/],
  ["no camera", { features: "" }, /no camera feature/],
])
  test(`image rejects ${name}`, () =>
    assert.throws(
      () =>
        verifySecureCameraImage(device(override).run, "10", "fixture/image", {
          launcherPackage: LAUNCHER,
          brand: "Eliza",
        }),
      error,
    ));

test("staged overlay selects AOSP Camera2 and the standard gesture while preserving unverified evidence", (t) => {
  const dir = temporary(t, "secure-camera-stage-");
  assert.throws(() => writeSecureCameraOverlay(dir, {}), /staged product.mk/);
  fs.writeFileSync(path.join(dir, "product.mk"), "# existing\n");
  writeSecureCameraOverlay(dir, {
    sourceVerified: false,
    imageVerified: false,
  });
  const product = fs.readFileSync(path.join(dir, "product.mk"), "utf8");
  assert.match(product, /PRODUCT_PACKAGES \+= Camera2/);
  assert.match(
    product,
    /PRODUCT_PACKAGE_OVERLAYS \+= \$\(secure_camera_dir\)\/overlay/,
  );
  assert.match(
    fs.readFileSync(
      path.join(
        dir,
        "secure-camera/overlay/frameworks/base/core/res/res/values/config.xml",
      ),
      "utf8",
    ),
    /config_cameraDoubleTapPowerGestureEnabled">true/,
  );
  assert.match(
    fs.readFileSync(
      path.join(
        dir,
        "secure-camera/overlay/frameworks/base/packages/SystemUI/res/values/config.xml",
      ),
      "utf8",
    ),
    /config_cameraGesturePackage" translatable="false">com.android.camera2/,
  );
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(dir, "secure-camera/source-evidence.json"),
        "utf8",
      ),
    ).sourceVerified,
    false,
  );
  assert.throws(() => writeSecureCameraOverlay(dir, {}), /EEXIST/);
});

const TRUE = "(type 0x12)0xffffffff";
const str = (value) => `"${value}" (Raw: "${value}")`;
const element = (indent, tag, attrs = {}) => [
  `${" ".repeat(indent)}E: ${tag} (line=1)`,
  ...Object.entries(attrs).map(
    ([key, value]) =>
      `${" ".repeat(indent + 2)}A: android:${key}(0x01010003)=${value.startsWith("(") ? value : str(value)}`,
  ),
];
const filter = (indent, action, categories = []) => [
  ...element(indent, "intent-filter"),
  ...element(indent + 2, "action", { name: action }),
  ...categories.flatMap((name) => element(indent + 2, "category", { name })),
];
function tree({ mainAttrs = {}, extra = [] } = {}) {
  return [
    "N: android=http://schemas.android.com/apk/res/android",
    "  E: manifest (line=2)",
    "    E: application (line=3)",
    ...element(6, "activity", {
      name: `${LAUNCHER}.MainActivity`,
      exported: TRUE,
      ...mainAttrs,
    }),
    ...filter(8, "android.intent.action.MAIN", [
      "android.intent.category.HOME",
      "android.intent.category.DEFAULT",
    ]),
    ...extra,
  ].join("\n");
}

test("a launcher APK with a lock-screen surface or secure-camera handler is refused", () => {
  assert.equal(assertNoLockScreenSurface(tree()), true);
  for (const attr of ["showWhenLocked", "showOnLockScreen", "turnScreenOn"])
    assert.throws(
      () =>
        assertNoLockScreenSurface(tree({ mainAttrs: { [attr]: TRUE } }), {
          brand: "Eliza",
        }),
      new RegExp(
        `Eliza does not implement[\\s\\S]*MainActivity sets android:${attr}`,
      ),
    );
  assert.equal(
    assertNoLockScreenSurface(
      tree({ mainAttrs: { showWhenLocked: "(type 0x12)0x0" } }),
    ),
    true,
  );
  for (const action of secureCameraActions.map(
    (name) => `android.media.action.${name}`,
  )) {
    const extra = [
      ...element(6, "activity", { name: `${LAUNCHER}.LockCamera` }),
      ...filter(8, action, ["android.intent.category.DEFAULT"]),
    ];
    assert.throws(
      () => assertNoLockScreenSurface(tree({ extra })),
      new RegExp(`LockCamera handles ${action.replaceAll(".", "\\.")}`),
    );
  }
});
