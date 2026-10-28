/**
 * Stock vendor API checks shared by every Pixel target.
 *
 * A Pixel product keeps the factory vendor partition, so the platform it is
 * built with must declare the same board API level as the vendor's VINTF
 * sepolicy version. A mismatched development release is corrected in the lunch
 * configuration, never by rewriting the vendor manifest.
 */
import fs from "node:fs";
import path from "node:path";

const apiLevel = /^[0-9]{6}$/;
const token = /^[a-z0-9_]+$/;

function fail(prefix, message) {
  throw new Error(`[${prefix}] ${message}`);
}

/** The single RELEASE_BOARD_API_LEVEL value of an AOSP release configuration. */
export function readReleaseBoardApi(
  aospRoot,
  releaseConfig,
  prefix = "distro-android",
) {
  if (!token.test(releaseConfig ?? ""))
    fail(prefix, "A locked Pixel release configuration is required");
  const flagPath = path.join(
    aospRoot,
    "build/release/flag_values",
    releaseConfig,
    "RELEASE_BOARD_API_LEVEL.textproto",
  );
  if (!fs.existsSync(flagPath))
    fail(prefix, `Pixel release ${releaseConfig} declares no board API level`);
  const values = [
    ...fs
      .readFileSync(flagPath, "utf8")
      .matchAll(/string_value:\s*"([0-9]+)"/g),
  ];
  if (values.length !== 1)
    fail(prefix, `Pixel release ${releaseConfig} must declare one board API`);
  return values[0][1];
}

/** The vendor VINTF manifest of the device's generated stock vendor tree must keep the locked API. */
export function assertGeneratedVintfApi(
  aospRoot,
  expectedApi,
  codename = "grizzly",
  prefix = "distro-android:grizzly",
) {
  if (!apiLevel.test(expectedApi ?? ""))
    fail(prefix, "Missing locked vendor API level");
  if (!token.test(codename ?? "")) fail(prefix, "Invalid device codename");
  const manifestPath = path.join(
    aospRoot,
    "vendor/google_devices",
    codename,
    "vintf/vendor/manifest.xml",
  );
  if (!fs.existsSync(manifestPath))
    fail(prefix, `Generated ${codename} vendor VINTF manifest is missing`);
  const contents = fs.readFileSync(manifestPath, "utf8");
  const versions = [
    ...contents.matchAll(
      /<sepolicy>\s*<version>([0-9]+)<\/version>\s*<\/sepolicy>/g,
    ),
  ];
  if (versions.length !== 1 || versions[0][1] !== expectedApi)
    fail(
      prefix,
      `Generated vendor VINTF policy must retain locked API ${expectedApi}`,
    );
}

/**
 * Both halves of the stock vendor contract: the release configuration the
 * product is lunched with and the generated vendor VINTF manifest each carry
 * the locked vendor API level.
 */
export function assertStockVendorApi(
  aospRoot,
  { codename, releaseConfig, vendorApiLevel },
  prefix = `distro-android:${codename}`,
) {
  if (!apiLevel.test(vendorApiLevel ?? ""))
    fail(prefix, "Missing locked vendor API level");
  const boardApi = readReleaseBoardApi(aospRoot, releaseConfig, prefix);
  if (boardApi !== vendorApiLevel)
    fail(
      prefix,
      `Pixel release ${releaseConfig} does not match stock vendor API ${vendorApiLevel}`,
    );
  assertGeneratedVintfApi(aospRoot, vendorApiLevel, codename, prefix);
  return { codename, releaseConfig, vendorApiLevel };
}
