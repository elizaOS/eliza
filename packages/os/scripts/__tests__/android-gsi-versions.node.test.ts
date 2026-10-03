import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadProfile } from "../aosp/verify-source-lock.ts";

const androidDir = fileURLToPath(new URL("../../android/", import.meta.url));
const vendorDir = path.join(androidDir, "vendor/eliza");
const lockPath = path.join(androidDir, "aosp.lock.json");
const read = (relative: string) =>
  fs.readFileSync(path.join(vendorDir, relative), "utf8");
const GSI_PROFILES = {
  "gsi-android15": { tag: /^android-15\.0\.0_r\d+$/, release: "bp1a" },
  "gsi-android16": { tag: /^android-16\.0\.0_r\d+$/, release: "bp4a" },
  "gsi-android17": { tag: /^android-17\.0\.0_r\d+$/, release: "cp2a" },
};

function selectPolicy(sdk: string, gsi: boolean) {
  const printer = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "eliza-sepolicy-")),
    "print.mk",
  );
  fs.writeFileSync(
    printer,
    "print:\n\t@echo '$(BOARD_VENDOR_SEPOLICY_DIRS)|$(SYSTEM_EXT_PRIVATE_SEPOLICY_DIRS)'\n",
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
    { encoding: "utf8" },
  );
  fs.rmSync(path.dirname(printer), { recursive: true, force: true });
  if (sdk) {
    assert.equal(
      result.status,
      0,
      `Policy probe failed: ${result.error?.message ?? result.stderr}`,
    );
  }
  const [vendor = "", systemExt = ""] = result.stdout.trim().split("|");
  return {
    status: result.status,
    stderr: result.stderr,
    vendor: vendor.split(/\s+/).filter(Boolean),
    systemExt: systemExt.split(/\s+/).filter(Boolean),
  };
}

test("GSI source profiles pin Android 15, 16 and 17 with matching products", () => {
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

test("SELinux policy directories follow PLATFORM_SDK_VERSION", () => {
  for (const sdk of ["35", "36"]) {
    assert.deepEqual(selectPolicy(sdk, false).vendor, [
      "vendor/eliza/sepolicy",
    ]);
    assert.deepEqual(selectPolicy(sdk, true).systemExt, [
      "vendor/eliza/sepolicy/system_ext",
    ]);
    assert.deepEqual(selectPolicy(sdk, true).vendor, []);
  }
  assert.deepEqual(selectPolicy("37", false).vendor, [
    "vendor/eliza/sepolicy",
    "vendor/eliza/sepolicy/api37",
  ]);
  assert.deepEqual(selectPolicy("37", true).systemExt, [
    "vendor/eliza/sepolicy/system_ext",
    "vendor/eliza/sepolicy/system_ext_api37",
  ]);
  const unset = selectPolicy("", false);
  assert.notEqual(unset.status, 0);
  assert.match(unset.stderr, /PLATFORM_SDK_VERSION is unset/);
});

test("Android 17-only platform_app_36 rules stay out of shared policy", () => {
  const strip = (text: string) => text.replace(/^\s*#.*$/gm, "");
  for (const shared of [
    "sepolicy/eliza_agent.te",
    "sepolicy/system_ext/eliza_agent.te",
  ])
    assert.doesNotMatch(strip(read(shared)), /platform_app_36/, shared);
  for (const api37 of [
    "sepolicy/api37/eliza_agent_app36.te",
    "sepolicy/system_ext_api37/eliza_agent_app36.te",
  ]) {
    const policy = strip(read(api37));
    assert.match(
      policy,
      /allow platform_app_36 app_data_file:file \{ execute execute_no_trans \};/,
      api37,
    );
    assert.match(policy, /userdebug_or_eng\(/, api37);
  }
  assert.match(
    strip(read("sepolicy/system_ext/eliza_agent.te")),
    /userdebug_or_eng\([\s\S]*allow platform_app app_data_file:file \{ execute execute_no_trans \};/,
  );
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
