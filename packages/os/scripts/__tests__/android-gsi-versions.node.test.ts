import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadProfile } from "../android/verify-source-lock.ts";

const androidDir = fileURLToPath(new URL("../../android/", import.meta.url));
const vendorDir = path.join(androidDir, "vendor/eliza");
const lockPath = path.join(androidDir, "aosp.lock.json");
const read = (relative: string) =>
  fs.readFileSync(path.join(vendorDir, relative), "utf8");
const GSI_PROFILES = {
  "gsi-android17": { tag: /^android-17\.0\.0_r\d+$/, release: "cp2a" },
};

function selectPolicy(sdk: string, gsi: boolean, staged = true) {
  // eliza_common.mk resolves the staged launcher relative to the AOSP root.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-sepolicy-"));
  if (staged) {
    fs.mkdirSync(path.join(root, "vendor/eliza/launcher"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "vendor/eliza/launcher/product.mk"),
      "# fixture\n",
    );
  }
  const printer = path.join(root, "print.mk");
  fs.writeFileSync(
    printer,
    "print:\n\t@echo '$(BOARD_VENDOR_SEPOLICY_DIRS)|$(SYSTEM_EXT_PRIVATE_SEPOLICY_DIRS)|$(PRODUCT_PACKAGES)'\n",
  );
  const result = spawnSync(
    "make",
    [
      "-s",
      "-f",
      path.join(vendorDir, "eliza_common.mk"),
      "-f",
      printer,
      ...(sdk ? [`PLATFORM_SDK_VERSION=${sdk}`] : []),
      `ELIZA_GSI=${gsi ? "true" : ""}`,
      "print",
    ],
    { encoding: "utf8", cwd: root },
  );
  fs.rmSync(root, { recursive: true, force: true });
  assert.ifError(result.error);
  if (sdk === "37" && staged) {
    assert.equal(result.status, 0, result.stderr);
  }
  const [vendor = "", systemExt = "", packages = ""] = result.stdout
    .trim()
    .split("|");
  return {
    status: result.status,
    stderr: result.stderr,
    vendor: vendor.split(/\s+/).filter(Boolean),
    systemExt: systemExt.split(/\s+/).filter(Boolean),
    packages: packages.split(/\s+/).filter(Boolean),
  };
}

test("GSI source profiles pin Android 17 with matching products", () => {
  for (const [name, expected] of Object.entries(GSI_PROFILES)) {
    const profile = loadProfile(name, lockPath);
    assert.equal(profile.kind, "virtual", name);
    assert.match(profile.manifest.tag, expected.tag, name);
    assert.deepEqual(
      profile.supportedProducts,
      ["eliza_gsi_arm64", "eliza_gsi_x86_64"],
      name,
    );
    for (const file of ["aosp_arm64.mk", "aosp_x86_64.mk", "gsi_release.mk"])
      assert.ok(
        profile.requiredSourceFiles.includes(
          `build/make/target/product/${file}`,
        ),
        `${name} requires ${file}`,
      );
    const build = profile.projects.find(
      (project: { path: string }) => project.path === "build/make",
    );
    assert.match(build?.commit ?? "", /^[0-9a-f]{40}$/, name);
  }
  const lunch = read("AndroidProducts.mk");
  for (const { release } of Object.values(GSI_PROFILES))
    for (const arch of ["arm64", "x86_64"])
      assert.match(lunch, new RegExp(`eliza_gsi_${arch}-${release}-userdebug`));
});

test("GSI products inherit the AOSP GSI layers before the shared Eliza layer", () => {
  for (const arch of ["arm64", "x86_64"]) {
    const product = read(`products/eliza_gsi_${arch}.mk`);
    const order = [
      `product/aosp_${arch}.mk`,
      "product/gsi_release.mk",
      "ELIZA_GSI := true",
      "vendor/eliza/eliza_common.mk",
    ].map((needle) => product.indexOf(needle));
    assert.ok(
      order.every(
        (index, i) => index >= 0 && (i === 0 || index > order[i - 1]),
      ),
      `eliza_gsi_${arch}.mk inherit order`,
    );
  }
});

test("Android 17 images add no app SELinux policy for the nonprivileged launcher", () => {
  for (const gsi of [false, true]) {
    const selected = selectPolicy("37", gsi);
    assert.deepEqual(selected.vendor, []);
    assert.deepEqual(selected.systemExt, []);
    // The launcher module comes only from the staged launcher product.
    assert.equal(selected.packages.includes("Eliza"), false);
  }
  for (const sdk of ["", "35", "36", "38"]) {
    const rejected = selectPolicy(sdk, false);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Android 17 SDK 37 is required/);
  }
});

test("the shared product layer refuses an unstaged launcher", () => {
  const unstaged = selectPolicy("37", false, false);
  assert.notEqual(unstaged.status, 0);
  assert.match(unstaged.stderr, /vendor\/eliza\/launcher is not staged/);
});

test("no vendor policy lets an app execute app data", () => {
  const policies = fs
    .readdirSync(path.join(vendorDir, "sepolicy"), { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".te"));
  assert.deepEqual(policies, []);
  assert.match(read("sepolicy/README.md"), /untrusted_app/);
});

test("the generic MediaTek GSI target stays blocked", () => {
  const inventory = JSON.parse(
    fs.readFileSync(path.join(androidDir, "hardware-targets.json"), "utf8"),
  );
  const target = inventory.targets.find(
    (entry: { targetId: string }) => entry.targetId === "generic-mediatek-gsi",
  );
  assert.equal(target?.sourceStatus, "blocked");
  assert.equal(target?.installerEligible, false);
  assert.equal(target?.labExperimentsEligible, false);
  assert.ok(target?.blockedReasons.length >= 3);
});
