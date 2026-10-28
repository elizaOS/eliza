/** The AOSP image feature every brand's image declares for its launcher host. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  IMAGE_FEATURE_VERSION,
  imageFeatureName,
  renderImageCapability,
  stagedImageFeature,
  writeImageCapability,
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
