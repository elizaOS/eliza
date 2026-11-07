import assert from "node:assert/strict";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadBrandConfig } from "../android/brand-config.ts";
import { validateProductLayer, validateSepolicy } from "../android/validate.ts";

const vendor = fileURLToPath(
  new URL("../../android/vendor/eliza", import.meta.url),
);
const brand = loadBrandConfig(
  fileURLToPath(new URL("../android/brand.eliza.json", import.meta.url)),
);

function copyVendor(t, prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(vendor, root, {
    recursive: true,
    filter: (source) => !/\.(apk|zip|png|webp|so|woff2?)$/.test(source),
  });
  return root;
}

test("product validation refuses Telecom classes for a dialer the image does not preassign", (t) => {
  const root = copyVendor(t, "telecom-overlay-");
  const directory = path.join(
    root,
    "overlays/packages/services/Telecomm/res/values",
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "config.xml"),
    '<resources><string name="incall_default_class">ai.elizaos.app.ElizaInCallService</string></resources>',
  );
  assert.throws(
    () => validateProductLayer(root, brand),
    /Telecom overlay must not exist/,
  );
});

test("product validation refuses preassigned dialer, SMS and HOME defaults", (t) => {
  for (const resource of [
    "config_defaultDialer",
    "config_defaultSms",
    "config_defaultHome",
    "config_defaultAssistant",
  ]) {
    const root = copyVendor(t, "role-overlay-");
    const file = path.join(
      root,
      "overlays/frameworks/base/core/res/res/values/config.xml",
    );
    writeFileSync(
      file,
      `<resources><string name="${resource}" translatable="false">ai.elizaos.app</string></resources>`,
    );
    assert.throws(
      () => validateProductLayer(root, brand),
      new RegExp(`must not set ${resource}`),
    );
  }
});

test("product validation refuses the privileged launcher profile", (t) => {
  const cases = [
    [
      "apps/Eliza/Android.bp",
      'android_app_import { name: "Eliza", apk: "Eliza.apk", certificate: "platform", privileged: true, }',
    ],
    [
      "apps/Other/Android.bp",
      'android_app_import { name: "ElizaOther", apk: "x.apk", presigned: true, overrides: ["Launcher3"], }',
    ],
    ["permissions/privapp-permissions-ai.elizaos.app.xml", "<permissions/>"],
    ["permissions/default-permissions-ai.elizaos.app.xml", "<exceptions/>"],
  ];
  for (const [relative, content] of cases) {
    const root = copyVendor(t, "privileged-profile-");
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content);
    assert.throws(
      () => validateProductLayer(root, brand),
      /must not define the launcher|Privapp allowlist|Default grants come only/,
      relative,
    );
  }
  const root = copyVendor(t, "privileged-common-");
  appendFileSync(
    path.join(root, brand.commonMakefile),
    "\nPRODUCT_PACKAGES += privapp-permissions-ai.elizaos.app.xml\n",
  );
  assert.throws(
    () => validateProductLayer(root, brand),
    /must not add a privapp allowlist/,
  );
  const policy = copyVendor(t, "app-data-policy-");
  writeFileSync(
    path.join(policy, "sepolicy/eliza_agent.te"),
    "allow untrusted_app app_data_file:file { execute execute_no_trans };\n",
  );
  assert.throws(
    () => validateSepolicy(policy, brand),
    /allows executing app data/,
  );
  validateSepolicy(vendor, brand);
});

test("the shipped vendor product is the nonprivileged-launcher layer", () => {
  validateProductLayer(vendor, brand);
});

test("product validation rejects unsupported package subtraction", (t) => {
  const root = copyVendor(t, "product-subtraction-");
  appendFileSync(
    path.join(root, brand.commonMakefile),
    "\nPRODUCT_PACKAGES -= Provision\n",
  );
  assert.throws(
    () => validateProductLayer(root, brand),
    /unsupported PRODUCT_PACKAGES subtraction/,
  );
});
