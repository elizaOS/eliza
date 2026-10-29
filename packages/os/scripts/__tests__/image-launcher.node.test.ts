// Staging of Eliza's own image products under the nonprivileged-launcher
// profile, with fabricated SDK tools. Staging evidence only: no image is
// built, signed or booted here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadBrandConfig } from "../android/brand-config.ts";
import {
  ELIZA_IMAGES_POLICY,
  imageProduct,
  loadImagesPolicy,
  productGuard,
  reviewDescriptor,
  stageImageLauncher,
  validateImagesPolicy,
  verifyStagedLauncher,
} from "../android/image-launcher.ts";
import { brandFor, fakeTools, PKG, SIGNER } from "./image-launcher-fixture.ts";

const androidDir = fileURLToPath(new URL("../../android/", import.meta.url));
const scriptsDir = fileURLToPath(new URL("../android/", import.meta.url));
const shipped = () => JSON.parse(fs.readFileSync(ELIZA_IMAGES_POLICY, "utf8"));

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "image-launcher-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, ...fakeTools(path.join(root, "tools")) };
}

function stage(t, productName, extra = {}) {
  const w = workspace(t);
  const output = path.join(w.root, "vendor", "launcher");
  const evidence = stageImageLauncher({
    brand: brandFor(productName),
    apk: w.apk,
    development: true,
    output,
    aapt: w.aapt,
    apksigner: w.apksigner,
    ...extra,
  });
  return { ...w, output, evidence };
}

test("the reviewed policy covers every Eliza lunch product with least privilege", () => {
  const policy = loadImagesPolicy();
  const lunch = fs.readFileSync(
    path.join(androidDir, "vendor/eliza/AndroidProducts.mk"),
    "utf8",
  );
  const products = [
    ...lunch.matchAll(/\$\(LOCAL_DIR\)\/products\/([a-z0-9_]+)\.mk/g),
  ].map((match) => match[1]);
  assert.deepEqual(Object.keys(policy.products).sort(), products.sort());
  for (const name of products)
    assert.equal(
      policy.products[name].partition,
      name.startsWith("eliza_gsi_") ? "system" : "product",
      name,
    );
  assert.equal(
    policy.products.eliza_cf_x86_64_phone.nativeTarget,
    "cuttlefish",
  );
  assert.deepEqual(policy.defaultPermissions, [
    "android.permission.RECORD_AUDIO",
    "android.permission.POST_NOTIFICATIONS",
  ]);
  for (const file of fs.readdirSync(scriptsDir)) {
    if (!/^brand\.eliza.*\.json$/.test(file)) continue;
    const brand = loadBrandConfig(path.join(scriptsDir, file));
    assert.equal(
      imageProduct(policy, brand).installPath,
      `/${policy.products[brand.productName].partition}/app/Eliza/Eliza.apk`,
      file,
    );
  }
  const capability = JSON.parse(
    fs.readFileSync(
      path.join(
        androidDir,
        "vendor/eliza/manifests/aosp-assistant-full-control.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    capability.defaultGrantedRuntimePermissions,
    policy.defaultPermissions,
  );
  assert.deepEqual(capability.privilegedPermissions, []);
  assert.equal(capability.systemImageRequirements.soong.privileged, false);
  assert.equal(
    capability.systemImageRequirements.installPath,
    "/product/app/Eliza/Eliza.apk",
  );
  assert.deepEqual(capability.roleDefaultsNotPreassigned, [
    "android.app.role.DIALER",
    "android.app.role.SMS",
  ]);
});

test("the policy refuses privileged grants and impossible native placement", () => {
  for (const permission of [
    "android.permission.MANAGE_APP_OPS_MODES",
    "android.permission.INJECT_EVENTS",
    "android.permission.SYSTEM_ALERT_WINDOW",
  ])
    assert.throws(
      () =>
        validateImagesPolicy({
          ...shipped(),
          defaultPermissions: [permission],
        }),
      /privileged or invalid/,
    );
  const policy = shipped();
  assert.throws(
    () =>
      validateImagesPolicy({
        ...policy,
        products: {
          eliza_gsi_x86_64: { partition: "system", nativeTarget: "cuttlefish" },
        },
      }),
    /Invalid image policy product/,
  );
  assert.throws(
    () =>
      validateImagesPolicy({
        ...policy,
        products: { eliza_x: { partition: "priv-app", nativeTarget: null } },
      }),
    /Invalid image policy product/,
  );
  assert.throws(
    () => imageProduct(policy, { ...brandFor("eliza_unknown_phone") }),
    /not an image product/,
  );
  assert.throws(
    () =>
      imageProduct(policy, {
        ...brandFor("eliza_cf_arm64_phone"),
        packageName: "com.example.other",
      }),
    /reviewed launcher identity/,
  );
});

test("development staging produces an additive nonprivileged launcher", (t) => {
  const { output, evidence, apk } = stage(t, "eliza_cf_arm64_phone");
  assert.equal(evidence.privileged, false);
  assert.equal(evidence.installPath, "/product/app/Eliza/Eliza.apk");
  assert.equal(evidence.certificateSha256, SIGNER);
  assert.equal(
    evidence.apkSha256,
    createHash("sha256").update(fs.readFileSync(apk)).digest("hex"),
  );
  assert.equal(evidence.residentAgentIncluded, false);
  assert.deepEqual(evidence.provisioning, {
    home: `${PKG}.MainActivity`,
    assistant: `${PKG}.ElizaAssistActivity`,
    autofill: null,
  });
  const blueprint = fs.readFileSync(path.join(output, "Android.bp"), "utf8");
  assert.match(blueprint, /presigned: true/);
  assert.match(blueprint, /product_specific: true/);
  assert.doesNotMatch(
    blueprint,
    /privileged|certificate|overrides|Launcher3|Dialer/,
  );
  const product = fs.readFileSync(path.join(output, "product.mk"), "utf8");
  assert.ok(product.startsWith(productGuard("eliza_cf_arm64_phone")));
  assert.match(
    product,
    /^PRODUCT_PACKAGES \+= Eliza ElizaDefaultPermissions$/m,
  );
  assert.match(product, /^PRODUCT_PACKAGES \+= DeskClock$/m);
  assert.match(product, /launcher-home\.xml/);
  assert.match(product, /ai\.elizaos\.app\.aosp_image\.xml/);
  const grants = fs.readFileSync(
    path.join(output, "default-permissions.xml"),
    "utf8",
  );
  assert.match(grants, /RECORD_AUDIO" fixed="false"/);
  assert.doesNotMatch(grants, /SMS|CALL|CONTACTS|fixed="true"/);
  const roles = fs.readFileSync(
    path.join(
      output,
      "provisioning/overlay/frameworks/base/core/res/res/values/config.xml",
    ),
    "utf8",
  );
  assert.doesNotMatch(roles, /config_defaultDialer|config_defaultSms/);
  const files = fs.readdirSync(output, { recursive: true }).map(String);
  assert.equal(
    files.some((name) => /privapp/.test(name)),
    false,
  );
  assert.deepEqual(
    verifyStagedLauncher(output, brandFor("eliza_cf_arm64_phone")),
    evidence,
  );
});

test("system-only GSI products stage the launcher in the system partition", (t) => {
  const { output, evidence } = stage(t, "eliza_gsi_x86_64");
  assert.equal(evidence.partition, "system");
  assert.equal(evidence.installPath, "/system/app/Eliza/Eliza.apk");
  const blueprint = fs.readFileSync(path.join(output, "Android.bp"), "utf8");
  assert.doesNotMatch(blueprint, /product_specific|privileged/);
  const launcher = JSON.parse(
    fs.readFileSync(path.join(output, "launcher.json"), "utf8"),
  );
  assert.equal(launcher.partition, "system");
});

test("staging fails closed before writing an output", (t) => {
  const w = workspace(t);
  const base = {
    apk: w.apk,
    aapt: w.aapt,
    apksigner: w.apksigner,
    output: path.join(w.root, "out", "launcher"),
  };
  assert.throws(
    () =>
      stageImageLauncher({
        ...base,
        brand: brandFor("eliza_cf_arm64_phone"),
        development: false,
      }),
    /reviewed --descriptor/,
  );
  const descriptor = path.join(w.root, "descriptor.json");
  const reviewed = {
    schemaVersion: 1,
    brand: "eliza",
    moduleName: "Eliza",
    packageName: PKG,
    apkSha256: createHash("sha256")
      .update(fs.readFileSync(w.apk))
      .digest("hex"),
    certificateSha256: SIGNER,
    defaultPermissions: [
      "android.permission.RECORD_AUDIO",
      "android.permission.POST_NOTIFICATIONS",
    ],
  };
  fs.writeFileSync(descriptor, JSON.stringify(reviewed));
  assert.throws(
    () =>
      stageImageLauncher({
        ...base,
        brand: brandFor("eliza_cf_arm64_phone"),
        descriptor,
        development: false,
      }),
    /no native installation target/,
  );
  assert.throws(
    () =>
      stageImageLauncher({
        ...base,
        brand: brandFor("eliza_cf_x86_64_phone"),
        descriptor,
        development: false,
      }),
    /--source-commit is required/,
  );
  const policy = loadImagesPolicy();
  const brand = brandFor("eliza_cf_arm64_phone");
  assert.equal(reviewDescriptor(policy, brand, reviewed).moduleName, "Eliza");
  for (const [change, message] of [
    [
      { defaultPermissions: ["android.permission.READ_SMS"] },
      /default permissions/,
    ],
    [{ partition: "system" }, /partition must be product/],
    [{ packageName: "com.example.other" }, /reviewed launcher identity/],
    [
      {
        companions: [
          {
            moduleName: "Other",
            packageName: "com.example.x",
            apkSha256: "d".repeat(64),
          },
        ],
      },
      /no companions/,
    ],
  ] as const)
    assert.throws(
      () => reviewDescriptor(policy, brand, { ...reviewed, ...change }),
      message,
    );
  assert.equal(fs.existsSync(base.output), false);
});

test("verification refuses tampered or reprivileged staging", (t) => {
  const brand = brandFor("eliza_cf_arm64_phone");
  const tamper = (mutate, message) => {
    const { output } = stage(t, "eliza_cf_arm64_phone");
    mutate(output);
    assert.throws(() => verifyStagedLauncher(output, brand), message);
  };
  tamper(
    (dir) => fs.appendFileSync(path.join(dir, "Launcher.apk"), "x"),
    /pinned launcher hash/,
  );
  tamper(
    (dir) =>
      fs.writeFileSync(
        path.join(dir, "Android.bp"),
        fs
          .readFileSync(path.join(dir, "Android.bp"), "utf8")
          .replace("presigned: true,", "privileged: true,"),
      ),
    /presigned nonprivileged/,
  );
  tamper(
    (dir) =>
      fs.writeFileSync(
        path.join(dir, "privapp-permissions-ai.elizaos.app.xml"),
        "<permissions/>",
      ),
    /privapp allowlist/,
  );
  tamper(
    (dir) =>
      fs.writeFileSync(
        path.join(dir, "default-permissions.xml"),
        fs
          .readFileSync(path.join(dir, "default-permissions.xml"), "utf8")
          .replace(
            "</exception>",
            '    <permission name="android.permission.READ_SMS" fixed="false"/>\n    </exception>',
          ),
      ),
    /reviewed policy/,
  );
  tamper(
    (dir) =>
      fs.appendFileSync(
        path.join(
          dir,
          "provisioning/overlay/frameworks/base/core/res/res/values/config.xml",
        ),
        '<!-- <string name="config_defaultSms">x</string> -->',
      ),
    /only the assistant/,
  );
  const { output } = stage(t, "eliza_cf_arm64_phone");
  assert.throws(
    () => verifyStagedLauncher(output, brandFor("eliza_cf_riscv64_phone")),
    /does not belong/,
  );
});

test("the staged product makefile refuses a product it was not staged for", (t) => {
  const { output } = stage(t, "eliza_cf_arm64_phone");
  const run = (tag) =>
    spawnSync(
      "make",
      [
        "-s",
        "-f",
        path.join(output, "product.mk"),
        `ELIZA_PRODUCT_TAG=${tag}`,
        "--eval",
        "print: ; @echo '$(PRODUCT_PACKAGES)'",
        "print",
      ],
      { encoding: "utf8" },
    );
  const ok = run("eliza_cf_arm64_phone");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Eliza ElizaDefaultPermissions/);
  assert.match(ok.stdout, /DeskClock/);
  const refused = run("eliza_cf_x86_64_phone");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /was staged for eliza_cf_arm64_phone/);
});

test("the Cuttlefish image instrumentation asserts the nonprivileged contract", () => {
  const repo = fileURLToPath(new URL("../../../../", import.meta.url));
  const java = fs.readFileSync(
    path.join(
      repo,
      "packages/app/platforms/android/app/src/androidTest/java/ai/elizaos/app/ElizaOsInstrumentedTest.java",
    ),
    "utf8",
  );
  const declared =
    /DEFAULT_GRANTED_PERMISSIONS = new TreeSet<>\(Arrays\.asList\(([^)]*)\)\)/.exec(
      java,
    );
  assert.ok(declared, "DEFAULT_GRANTED_PERMISSIONS is declared");
  assert.deepEqual(
    [...declared[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort(),
    [...loadImagesPolicy().defaultPermissions].sort(),
  );
  const installs = new Set(
    Object.values(loadImagesPolicy().products).map(
      (product) => `"/${product.partition}/app/Eliza/"`,
    ),
  );
  for (const install of installs) assert.ok(java.includes(install), install);
  assert.doesNotMatch(
    java,
    /priv-app\/Eliza|ROLE_DIALER|ROLE_SMS|NameNotFoundException\.class/,
  );
  assert.match(java, /privateFlags=.*PRIVILEGED/);

  const workflow = fs.readFileSync(
    path.join(repo, ".github/workflows/elizaos-cuttlefish.yml"),
    "utf8",
  );
  assert.doesNotMatch(workflow, /privileged\.txt/);
  const step = workflow.slice(
    workflow.indexOf("- name: Exercise image-contract instrumentation"),
    workflow.indexOf("- name: Verify assistant role"),
  );
  assert.match(step, /-e class ai\.elizaos\.app\.ElizaOsInstrumentedTest,/);
  assert.match(step, /INSTRUMENTATION_STATUS_CODE: -3/);
  assert.ok(step.indexOf("adb root") < step.indexOf("am instrument"));
});
