/** Production descriptor checks for a brand's Cuttlefish validation product. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CUTTLEFISH_TARGETS,
  cuttlefishProductProblems,
  profileAdmitsProduct,
} from "../android/cuttlefish-product.mjs";

const sharedLock = JSON.parse(
  fs.readFileSync(
    new URL("../../android/aosp.lock.json", import.meta.url),
    "utf8",
  ),
);
const SHARED = "shared/aosp.lock.json";
const hex = (char: string, length = 64) => char.repeat(length);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-product-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel: string, value: unknown) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), JSON.stringify(value, null, 2));
  };
  const brand = {
    brand: "example",
    appName: "Example Phone",
    distroName: "Example Phone",
    packageName: "com.example.phone",
    classPrefix: "Example",
    productName: "example_cf_x86_64_phone",
    lunchTarget: "example_cf_x86_64_phone-trunk_staging-user",
    architecture: "x86_64",
    aospLockProfile: "cuttlefish",
    aospLockPath: SHARED,
    aospDeviceTreePaths: [
      "device/google/cuttlefish/vsoc_x86_64_only/phone/aosp_cf.mk",
    ],
    envPrefix: "ELIZA",
    propertyPrefix: "example",
    vendorDir: "vendor/example",
    initRcName: "init.example.rc",
    commonMakefile: "example_common.mk",
    cuttlefishMakefile: "example_cf_x86_64_phone.mk",
  };
  const product = {
    schema: 1,
    product: brand.productName,
    target: "cuttlefish_x86_64",
    brandConfig: "android/aosp/brand.example.json",
    sourceLock: { file: SHARED, profile: "cuttlefish" },
    hostPackages: [
      { name: "cuttlefish-base", version: "1.0.0", sha256: hex("1") },
      { name: "cuttlefish-user", version: "1.0.0", sha256: hex("2") },
    ],
    signer: {
      apkDescriptor: "android/release-signer.json",
      platformCertificateSha256: hex("c"),
    },
    separateLocks: { pixel10a: "shared/pixel10a-stallion.json" },
  };
  write(product.brandConfig, brand);
  write(SHARED, sharedLock);
  write("shared/pixel10a-stallion.json", { schema: 1 });
  write("android/release-signer.json", { signerSha256: hex("d") });
  const options = {
    root,
    file: "android/aosp/product.json",
    appId: brand.packageName,
    productDirectory: "android/aosp",
    sharedSourceLock: SHARED,
    applicationSignerFile: "android/release-signer.json",
  };
  return { root, write, brand, product, options };
}

test("a downstream product on the shared reviewed Cuttlefish tree is admitted", (t) => {
  const f = fixture(t);
  assert.deepEqual(cuttlefishProductProblems(f.product, f.options), []);
  assert.ok(CUTTLEFISH_TARGETS.includes(f.product.target));
  // The shared profile lists only Eliza's products; a downstream product is
  // admitted by inheriting only the profile's required device trees.
  const profile = sharedLock.profiles.cuttlefish;
  assert.equal(profile.supportedProducts.includes(f.brand.productName), false);
  assert.equal(profileAdmitsProduct(profile, f.brand), true);
  assert.equal(
    profileAdmitsProduct(profile, {
      ...f.brand,
      aospDeviceTreePaths: ["device/google/other/aosp_cf.mk"],
    }),
    false,
  );
  assert.equal(
    profileAdmitsProduct(profile, { ...f.brand, aospDeviceTreePaths: [] }),
    false,
  );
  assert.equal(
    profileAdmitsProduct(profile, {
      productName: "eliza_cf_x86_64_phone",
    }),
    true,
  );
});

test("unset, foreign and unreviewed inputs are each refused", (t) => {
  const f = fixture(t);
  const refuse = (product, pattern: RegExp, options = f.options) => {
    const problems = cuttlefishProductProblems(product, options);
    assert.ok(
      problems.some((problem) => pattern.test(problem)),
      `${pattern}\n${problems.join("\n")}`,
    );
  };
  refuse(
    {
      ...f.product,
      hostPackages: [{ ...f.product.hostPackages[0], sha256: "UNSET" }],
    },
    /cuttlefish-base is unset or a placeholder|cuttlefish-base needs a version and a SHA-256/,
  );
  refuse(
    { ...f.product, hostPackages: [] },
    /lists no Cuttlefish host package/,
  );
  refuse({ ...f.product, target: "pixel10a" }, /target must be one of/);
  refuse({ ...f.product, schema: 2 }, /schema must be 1/);
  refuse(
    {
      ...f.product,
      sourceLock: {
        file: "shared/pixel10a-stallion.json",
        profile: "cuttlefish",
      },
    },
    /separate product's lock/,
  );
  refuse(
    {
      ...f.product,
      sourceLock: { file: "elsewhere/lock.json", profile: "cuttlefish" },
    },
    /sourceLock\.file must name an existing lock under android\/aosp\/ or the shared lock/,
  );
  refuse(
    { ...f.product, sourceLock: { file: SHARED, profile: "pixel10a" } },
    /aospLockProfile is not the descriptor's source-lock profile/,
  );
  refuse(
    { ...f.product, brandConfig: "../brand.json" },
    /brandConfig must name a file under android\/aosp\//,
  );
  refuse(
    {
      ...f.product,
      signer: { ...f.product.signer, platformCertificateSha256: "UNSET" },
    },
    /platformCertificateSha256/,
  );
  refuse(
    {
      ...f.product,
      signer: { ...f.product.signer, apkDescriptor: "other.json" },
    },
    /signer\.apkDescriptor must be android\/release-signer\.json/,
  );
  f.write("android/release-signer.json", { signerSha256: "unset" });
  refuse(
    f.product,
    /signerSha256 is "unset", not a reviewed release certificate/,
  );
  f.write("android/release-signer.json", { signerSha256: hex("d") });
  f.write(f.product.brandConfig, { ...f.brand, packageName: "ai.elizaos.app" });
  refuse(f.product, /packageName ai\.elizaos\.app is not com\.example\.phone/);
  const { lunchTarget: _lunch, ...withoutLunch } = f.brand;
  f.write(f.product.brandConfig, withoutLunch);
  refuse(f.product, /missing required string field "lunchTarget"/);
  f.write(f.product.brandConfig, {
    ...f.brand,
    aospDeviceTreePaths: [
      "device/google/cuttlefish/vsoc_riscv64/phone/other.mk",
    ],
  });
  refuse(f.product, /does not admit example_cf_x86_64_phone/);
  f.write(f.product.brandConfig, f.brand);
  // A product-local lock with an unreviewed manifest revision is refused.
  const local = structuredClone(sharedLock);
  local.profiles = { cuttlefish: local.profiles.cuttlefish };
  local.profiles.cuttlefish.manifest.commit = "UNSET";
  f.write("android/aosp/aosp.lock.json", local);
  f.write(f.product.brandConfig, {
    ...f.brand,
    aospLockPath: "android/aosp/aosp.lock.json",
  });
  refuse(
    {
      ...f.product,
      sourceLock: {
        file: "android/aosp/aosp.lock.json",
        profile: "cuttlefish",
      },
    },
    /manifest\.commit is unset or a placeholder/,
  );
  // A physical profile never backs the Cuttlefish product.
  local.profiles.cuttlefish.manifest.commit =
    sharedLock.profiles.cuttlefish.manifest.commit;
  local.profiles.cuttlefish.kind = "physical";
  f.write("android/aosp/aosp.lock.json", local);
  refuse(
    {
      ...f.product,
      sourceLock: {
        file: "android/aosp/aosp.lock.json",
        profile: "cuttlefish",
      },
    },
    /profile cuttlefish is a physical device/,
  );
});
