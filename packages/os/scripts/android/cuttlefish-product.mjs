/**
 * Production descriptor checks for a brand's Cuttlefish validation product.
 *
 * A downstream product (for example Alpha's `alphaphone_cf_x86_64_phone`)
 * names its Cuttlefish target, its brand config (brand-config.ts schema), a
 * source-lock profile (verify-source-lock.ts schema; normally the shared
 * reviewed `cuttlefish` profile in `android/aosp.lock.json`), pinned host
 * packages and its reviewed signer. Every check reads repository files only:
 * an empty list admits production staging inputs, never an image build, boot
 * or device qualification.
 *
 * The launcher stays nonprivileged (stage-launcher-overlay.ts) and the only
 * privileged package is the separately admitted listener (sense-listener.mjs),
 * the same least-privilege profile as the Pixel 10a composition.
 */
import fs from "node:fs";
import path from "node:path";
import { loadBrandConfig } from "./brand-config.ts";
import { placeholderFields } from "./pixel10a-release.mjs";
import { loadProfile } from "./verify-source-lock.ts";

export const CUTTLEFISH_TARGETS = Object.freeze([
  "cuttlefish_x86_64",
  "cuttlefish_arm64",
]);
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Whether the selected profile admits this product: the profile lists it, or
 * every device tree path its brand config inherits is a required source file
 * of the reviewed profile (a downstream product on the shared Cuttlefish tree).
 */
export function profileAdmitsProduct(profile, brand) {
  if ((profile?.supportedProducts ?? []).includes(brand?.productName))
    return true;
  const trees = brand?.aospDeviceTreePaths ?? [];
  const required = new Set(profile?.requiredSourceFiles ?? []);
  return trees.length > 0 && trees.every((tree) => required.has(tree));
}

/**
 * Problems that keep `product` (read from `file` under `root`) from production
 * staging. `productDirectory` bounds the brand config and any product-local
 * lock; `sharedSourceLock` is the repository-relative path of the shared lock
 * a downstream product may name instead; `separateLocks` lists locks of other
 * products that must never be selected.
 */
export function cuttlefishProductProblems(
  product,
  {
    root,
    file,
    appId,
    productDirectory,
    sharedSourceLock = null,
    applicationSignerFile,
  },
) {
  const at = (rel) => path.join(root, rel);
  const read = (rel) => JSON.parse(fs.readFileSync(at(rel), "utf8"));
  const under = (rel) =>
    typeof rel === "string" &&
    rel.startsWith(`${productDirectory}/`) &&
    !rel.split("/").includes("..");
  const problems = [];
  if (product?.schema !== 1) problems.push(`${file}: schema must be 1`);
  for (const field of placeholderFields(product))
    problems.push(`${file}: ${field} is unset or a placeholder`);
  if (!CUTTLEFISH_TARGETS.includes(product?.target))
    problems.push(
      `${file}: target must be one of ${CUTTLEFISH_TARGETS.join(", ")}`,
    );
  let brand = null;
  if (!under(product?.brandConfig))
    problems.push(
      `${file}: brandConfig must name a file under ${productDirectory}/`,
    );
  else {
    try {
      brand = loadBrandConfig(at(product.brandConfig));
    } catch (error) {
      problems.push(`${product.brandConfig}: ${error.message}`);
    }
    if (brand) {
      for (const field of placeholderFields(brand))
        problems.push(
          `${product.brandConfig}: ${field} is unset or a placeholder`,
        );
      if (brand.packageName !== appId)
        problems.push(
          `${product.brandConfig}: packageName ${brand.packageName} is not ${appId}`,
        );
      if (brand.productName !== product.product)
        problems.push(
          `${product.brandConfig}: productName ${brand.productName} is not ${product.product}`,
        );
      if (brand.aospLockProfile !== product.sourceLock?.profile)
        problems.push(
          `${product.brandConfig}: aospLockProfile is not the descriptor's source-lock profile`,
        );
      if (brand.aospLockPath !== product.sourceLock?.file)
        problems.push(
          `${product.brandConfig}: aospLockPath is not the descriptor's source lock`,
        );
    }
  }
  const lockFile = product?.sourceLock?.file;
  const profileName = product?.sourceLock?.profile;
  if (Object.values(product?.separateLocks ?? {}).includes(lockFile))
    problems.push(
      `${lockFile} is a separate product's lock; it is not admitted for the Cuttlefish product`,
    );
  else if (
    !(under(lockFile) || (sharedSourceLock && lockFile === sharedSourceLock)) ||
    !fs.existsSync(at(lockFile))
  )
    problems.push(
      `${file}: sourceLock.file must name an existing lock under ${productDirectory}/${sharedSourceLock ? ` or the shared lock ${sharedSourceLock}` : ""}`,
    );
  else {
    const lock = read(lockFile);
    if (lock.admitted === false) problems.push(`${lockFile} is not admitted`);
    let profile = null;
    try {
      profile = loadProfile(profileName, at(lockFile));
    } catch (error) {
      problems.push(`${lockFile}: ${error.message}`);
    }
    for (const field of placeholderFields(lock.profiles?.[profileName] ?? {}))
      problems.push(
        `${lockFile}: profiles.${profileName}.${field} is unset or a placeholder`,
      );
    if (profile && profile.kind !== "virtual")
      problems.push(
        `${lockFile}: profile ${profileName} is a ${profile.kind} device; only the Cuttlefish product is admitted`,
      );
    if (profile && brand && !profileAdmitsProduct(profile, brand))
      problems.push(
        `${lockFile}: profile ${profileName} does not admit ${product.product} (list it, or inherit only its required device trees)`,
      );
  }
  const hosts = Array.isArray(product?.hostPackages)
    ? product.hostPackages
    : [];
  if (!hosts.length)
    problems.push(`${file}: hostPackages lists no Cuttlefish host package`);
  for (const pkg of hosts)
    if (!pkg?.name || !pkg?.version || !HEX64.test(pkg?.sha256 ?? ""))
      problems.push(
        `${file}: host package ${pkg?.name ?? "(unnamed)"} needs a version and a SHA-256`,
      );
  if (product?.signer?.apkDescriptor !== applicationSignerFile)
    problems.push(
      `${file}: signer.apkDescriptor must be ${applicationSignerFile}`,
    );
  else if (fs.existsSync(at(applicationSignerFile))) {
    const signer = read(applicationSignerFile).signerSha256;
    if (!HEX64.test(signer ?? ""))
      problems.push(
        `${applicationSignerFile} signerSha256 is ${JSON.stringify(signer)}, not a reviewed release certificate`,
      );
  } else problems.push(`${applicationSignerFile} is missing`);
  if (!HEX64.test(product?.signer?.platformCertificateSha256 ?? ""))
    problems.push(
      `${file}: signer.platformCertificateSha256 must be a SHA-256`,
    );
  return [...new Set(problems)];
}
