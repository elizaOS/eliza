// Provisioning overlay rendering from a fabricated aapt xmltree; not image or boot evidence.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  provisioningComponents,
  renderProvisioningOverlay,
  writeProvisioningOverlay,
} from "../android/launcher-provisioning.mjs";

const PKG = "ai.elizaresearch.alphaphone";
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
function tree({
  homes = 1,
  homeExported = "(type 0x12)0xffffffff",
  assistantExported = "(type 0x12)0xffffffff",
  autofillExported = "(type 0x12)0xffffffff",
  autofillPermission = "android.permission.BIND_AUTOFILL_SERVICE",
} = {}) {
  return [
    "N: android=http://schemas.android.com/apk/res/android",
    "  E: manifest (line=2)",
    "    E: application (line=3)",
    ...Array.from({ length: homes }, (_, i) => [
      ...element(6, "activity", {
        name: `${PKG}.${i ? "Other" : "Main"}Activity`,
        exported: homeExported,
      }),
      ...filter(8, "android.intent.action.MAIN", [
        "android.intent.category.LAUNCHER",
      ]),
      ...filter(8, "android.intent.action.MAIN", [
        "android.intent.category.HOME",
        "android.intent.category.DEFAULT",
      ]),
    ]).flat(),
    ...element(6, "activity", {
      name: `${PKG}.AlphaAssistActivity`,
      exported: assistantExported,
    }),
    ...filter(8, "android.intent.action.ASSIST", [
      "android.intent.category.DEFAULT",
    ]),
    ...element(6, "service", {
      name: "ai.eliza.plugins.passwords.ElizaPasswordAutofillService",
      permission: autofillPermission,
      exported: autofillExported,
    }),
    ...filter(8, "android.service.autofill.AutofillService"),
    ...element(6, "service", { name: `${PKG}.ElizaAgentService` }),
  ].join("\n");
}

test("components come from the APK manifest and must be unique", () => {
  assert.deepEqual(provisioningComponents(tree(), PKG), {
    home: `${PKG}.MainActivity`,
    assistant: `${PKG}.AlphaAssistActivity`,
    autofill: "ai.eliza.plugins.passwords.ElizaPasswordAutofillService",
  });
  assert.throws(() => provisioningComponents(tree({ homes: 0 }), PKG), /HOME/);
  assert.throws(
    () => provisioningComponents(tree({ homes: 2 }), PKG),
    /exactly one/,
  );
  assert.throws(
    () => provisioningComponents(tree({ autofillPermission: "none" }), PKG),
    /AUTOFILL/,
  );
});

test("the overlay sets default HOME, assistant and Autofill offer additively", (t) => {
  const files = renderProvisioningOverlay(
    PKG,
    provisioningComponents(tree(), PKG),
  );
  assert.match(
    files[
      "provisioning/overlay/frameworks/base/core/res/res/values/config.xml"
    ],
    new RegExp(`config_defaultAssistant" translatable="false">${PKG}<`),
  );
  assert.match(
    files[
      "provisioning/overlay/frameworks/base/core/res/res/values/config.xml"
    ],
    /config_defaultAutofillService" translatable="false">ai\.elizaresearch\.alphaphone\/ai\.eliza\.plugins\.passwords\.ElizaPasswordAutofillService</,
  );
  assert.match(
    files["provisioning/preferred-apps/launcher-home.xml"],
    /<item name="ai\.elizaresearch\.alphaphone\/ai\.elizaresearch\.alphaphone\.MainActivity"/,
  );
  assert.match(
    files["provisioning/preferred-apps/launcher-home.xml"],
    /android\.intent\.category\.HOME/,
  );
  assert.doesNotMatch(
    files.productMakefile,
    /LOCAL_OVERRIDES_PACKAGES|Launcher3/,
    "the stock launcher stays as a recovery path",
  );
  assert.doesNotMatch(files.productMakefile, /\bALPHA_/);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-provision-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(out, "product.mk"),
    "PRODUCT_PACKAGES += AlphaPhone\n",
  );
  writeProvisioningOverlay(out, PKG, provisioningComponents(tree(), PKG));
  assert.match(
    fs.readFileSync(path.join(out, "product.mk"), "utf8"),
    /PRODUCT_PACKAGE_OVERLAYS \+= \$\(launcher_provisioning_dir\)\/overlay/,
  );
  assert.ok(
    fs.existsSync(
      path.join(out, "provisioning/preferred-apps/launcher-home.xml"),
    ),
  );
  assert.throws(
    () =>
      writeProvisioningOverlay(out, PKG, provisioningComponents(tree(), PKG)),
    /EEXIST/,
  );
});

test("provisioning requires each selected component to be explicitly exported", () => {
  for (const field of [
    "homeExported",
    "assistantExported",
    "autofillExported",
  ]) {
    assert.throws(
      () => provisioningComponents(tree({ [field]: "(type 0x12)0x0" }), PKG),
      /explicitly exported/,
    );
  }
  const implicit = tree().replace(/\s*A: android:exported[^\n]*/g, "");
  assert.throws(
    () => provisioningComponents(implicit, PKG),
    /explicitly exported/,
  );
});
