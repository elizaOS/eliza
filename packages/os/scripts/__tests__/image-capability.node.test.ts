/** The AOSP image feature every brand's image declares for its launcher host. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertProvisioningResourceDefault,
  IMAGE_FEATURE_VERSION,
  imageFeatureName,
  renderImageCapability,
  renderImageProvisioningOverlay,
  stagedImageFeature,
  writeImageCapability,
  writeImageProvisioningOverlay,
} from "../android/image-capability.mjs";

function staged(t) {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "image-capability-"));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(output, "product.mk"),
    "PRODUCT_PACKAGES += Eliza\n",
  );
  return output;
}

for (const appId of ["ai.elizaos.app", "ai.elizaresearch.alphaphone"]) {
  test(`${appId} gets one versioned product-partition feature`, (t) => {
    const feature = imageFeatureName(appId);
    assert.equal(feature, `${appId}.aosp_image`);
    const files = renderImageCapability(appId);
    assert.match(
      files[`image-capability/${feature}.xml`],
      new RegExp(
        `<feature name="${feature.replaceAll(".", "\\.")}" version="${IMAGE_FEATURE_VERSION}" />`,
      ),
    );
    assert.match(
      files.productMakefile,
      /\$\(TARGET_COPY_OUT_PRODUCT\)\/etc\/permissions\//,
    );
    assert.doesNotMatch(
      files.productMakefile,
      /TARGET_COPY_OUT_SYSTEM\b|privapp/,
    );
    const output = staged(t);
    assert.equal(stagedImageFeature(output, appId), null);
    writeImageCapability(output, appId);
    assert.deepEqual(stagedImageFeature(output, appId), {
      feature,
      version: IMAGE_FEATURE_VERSION,
    });
    assert.throws(() => writeImageCapability(output, appId), /EEXIST/);
  });
}

test("invalid hosts, unstaged products and altered declarations are refused", (t) => {
  assert.throws(() => imageFeatureName("Not a package"), /Invalid package/);
  assert.throws(() => imageFeatureName(undefined), /Invalid package/);
  const output = staged(t);
  fs.rmSync(path.join(output, "product.mk"));
  assert.throws(
    () => writeImageCapability(output, "ai.elizaos.app"),
    /requires a staged product.mk/,
  );
  fs.writeFileSync(path.join(output, "product.mk"), "");
  writeImageCapability(output, "ai.elizaos.app");
  const file = path.join(
    output,
    "image-capability/ai.elizaos.app.aosp_image.xml",
  );
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace('version="1"', 'version="2"'),
  );
  assert.throws(
    () => stagedImageFeature(output, "ai.elizaos.app"),
    /not admitted/,
  );
});

test("the provisioning overlay is a static product RRO naming only the host's overlayable", (t) => {
  const output = staged(t);
  const files = writeImageProvisioningOverlay(output, "ai.elizaos.app");
  assert.match(
    files["image-capabilities/Android.bp"],
    /runtime_resource_overlay \{\n {4}name: "ImageProvisioningOverlay",\n {4}product_specific: true,/,
  );
  assert.match(
    files["image-capabilities/AndroidManifest.xml"],
    /<overlay android:targetPackage="ai\.elizaos\.app" android:targetName="ImageProvisioning" android:isStatic="true"/,
  );
  assert.match(
    files["image-capabilities/res/values/capabilities.xml"],
    /<bool name="aosp_image_capability">true<\/bool>/,
  );
  assert.match(
    fs.readFileSync(path.join(output, "product.mk"), "utf8"),
    /PRODUCT_PACKAGES \+= ImageProvisioningOverlay\n$/,
  );
  assert.throws(
    () => writeImageProvisioningOverlay(output, "ai.elizaos.app"),
    /EEXIST/,
  );
});

test("a brand keeps its installed overlay identifiers", () => {
  const files = renderImageProvisioningOverlay("ai.elizaresearch.alphaphone", {
    module: "AlphaImageCapabilityOverlay",
    overlayable: "AlphaImageProvisioning",
    resource: "alpha_aosp_image_capability",
  });
  assert.match(
    files["image-capabilities/AndroidManifest.xml"],
    /targetName="AlphaImageProvisioning"/,
  );
  assert.match(
    files["image-capabilities/res/values/capabilities.xml"],
    /name="alpha_aosp_image_capability">true/,
  );
  assert.match(
    files.productMakefile,
    /PRODUCT_PACKAGES \+= AlphaImageCapabilityOverlay/,
  );
  for (const bad of [
    { module: 'Bad"Module' },
    { overlayable: "has space" },
    { resource: 'x"/><bool name="y' },
  ])
    assert.throws(
      () => renderImageProvisioningOverlay("ai.elizaos.app", bad),
      /Invalid/,
    );
  assert.throws(
    () => renderImageProvisioningOverlay('bad"target'),
    /Invalid package/,
  );
});

test("the host's provisioning default must be false and overlayable only by system or product", () => {
  const values = (value: string, policy: string) =>
    `<resources><bool name="aosp_image_capability">${value}</bool><overlayable name="ImageProvisioning"><policy type="${policy}"><item type="bool" name="aosp_image_capability" /></policy></overlayable></resources>`;
  assert.equal(
    assertProvisioningResourceDefault(values("false", "system|product")),
    true,
  );
  assert.throws(
    () => assertProvisioningResourceDefault(values("true", "system|product")),
    /default to false/,
  );
  assert.throws(
    () => assertProvisioningResourceDefault(values("false", "public")),
    /system\|product/,
  );
  assert.throws(
    () =>
      assertProvisioningResourceDefault(values("false", "system|product"), {
        overlayable: "Other",
      }),
    /not declared/,
  );
});
