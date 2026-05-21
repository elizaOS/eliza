// OS-1 confidential-image-manifest-check tests.
// Runner: node --test (bun test segfaults on the OS lane in this environment).
//   node --test packages/os/scripts/__tests__/check-confidential-image-manifest.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { checkConfidentialImageManifest } from "../check-confidential-image-manifest.mjs";
import { readJson, repoRoot } from "../os-release-lib.mjs";

const manifestPath = path.join(
  repoRoot,
  "packages/os/linux/confidential/image-manifest.example.json",
);
const schemaPath = path.join(
  repoRoot,
  "packages/os/release/schema/confidential-image-manifest.schema.json",
);

async function load() {
  return {
    manifest: await readJson(manifestPath),
    schema: await readJson(schemaPath),
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

test("shipped example image manifest passes schema + digest-shape", async () => {
  const { manifest, schema } = await load();
  const result = checkConfidentialImageManifest(manifest, schema);
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("a non-sha256 component digest is rejected", async () => {
  const { manifest, schema } = await load();
  const broken = clone(manifest);
  broken.components.kernel.digest = "md5:deadbeef";
  const result = checkConfidentialImageManifest(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("kernel")),
    result.errors.join("\n"),
  );
});

test("an all-zero placeholder component digest is rejected", async () => {
  const { manifest, schema } = await load();
  const broken = clone(manifest);
  broken.components.rootfs.digest = `sha256:${"0".repeat(64)}`;
  const result = checkConfidentialImageManifest(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("all-zero placeholder")));
});

test("appCompose digest drifting from measurements.compose is rejected", async () => {
  const { manifest, schema } = await load();
  const broken = clone(manifest);
  broken.measurements.compose = `sha256:${"7".repeat(64)}`;
  const result = checkConfidentialImageManifest(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("measurements.compose")),
    result.errors.join("\n"),
  );
});

test("a missing required component is rejected by the schema", async () => {
  const { manifest, schema } = await load();
  const broken = clone(manifest);
  delete broken.components.initrd;
  const result = checkConfidentialImageManifest(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.startsWith("schema:")));
});

test("a malformed toolchain sha is rejected by the schema", async () => {
  const { manifest, schema } = await load();
  const broken = clone(manifest);
  broken.buildInputs.toolchain[0].sha256 = "short";
  const result = checkConfidentialImageManifest(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.startsWith("schema:")));
});

test("a malformed layer commit is rejected by the schema", async () => {
  const { manifest, schema } = await load();
  const broken = clone(manifest);
  broken.buildInputs.layers[0].commit = "nothex";
  const result = checkConfidentialImageManifest(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.startsWith("schema:")));
});

test("an unsupported substrate is rejected by the schema enum", async () => {
  const { manifest, schema } = await load();
  const broken = clone(manifest);
  broken.image.substrate = "sev-snp";
  const result = checkConfidentialImageManifest(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.startsWith("schema:")));
});

test("an unknown extra property is rejected by the schema", async () => {
  const { manifest, schema } = await load();
  const broken = clone(manifest);
  broken.components.kernel.extra = true;
  const result = checkConfidentialImageManifest(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("additional property not allowed")),
  );
});

test("the example image manifest matches the release manifest tee.measurements", async () => {
  const { manifest } = await load();
  const releaseManifest = await readJson(
    path.join(
      repoRoot,
      "packages/os/release/confidential-2026-05-21/manifest.json",
    ),
  );
  // The "image is the policy" contract: the normalized measurements in the image
  // manifest must equal the signed golden measurements in the release manifest.
  for (const name of ["boot", "os", "policy", "agent"]) {
    assert.equal(
      manifest.measurements[name],
      releaseManifest.tee.measurements[name],
      `image-manifest measurements.${name} must equal release tee.measurements.${name}`,
    );
  }
});
