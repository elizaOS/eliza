import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fs.realpathSync(
  fileURLToPath(new URL("../../android/system-updater/", import.meta.url)),
);
const inputs = [
  "Android.bp",
  "AndroidManifest.xml",
  "LICENSE",
  "product.mk",
  "res/values/config.xml",
  "permissions/default-permissions-eliza-system-updater.xml",
  "permissions/privapp-permissions-eliza-system-updater.xml",
  "sepolicy/eliza_system_updater.te",
  "sepolicy/seapp_contexts",
  ...[
    "EngineInstaller",
    "JournalStore",
    "PackageVerifier",
    "UpdateChannel",
    "UpdateJournal",
    "VerifiedPayload",
  ].map((name) => `src/ai/eliza/systemupdater/${name}.java`),
  ...["SystemUpdateJob", "UpdateActivity", "UpdateRunner"].map(
    (name) => `host/ai/eliza/systemupdater/${name}.java`,
  ),
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A product may include the inactive client. Activation remains a separate enrollment gate. */
export function admitSystemUpdater(product) {
  if (product.systemUpdater === undefined || product.systemUpdater === false)
    return null;
  if (product.systemUpdater !== true)
    throw new Error(
      "systemUpdater must be a boolean; enrollment is not a staging option",
    );
  if (!/^[a-z][a-z0-9_]*$/.test(product.vendorDirectory))
    throw new Error("Invalid updater vendor directory");
  const files = inputs.map((name) => {
    const file = path.join(source, name);
    if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile())
      throw new Error("System updater source must be a regular in-tree file");
    const bytes = fs.readFileSync(file);
    return { path: `system-updater/${name}`, sha256: digest(bytes), bytes };
  });
  const config = files
    .find((file) => file.path === "system-updater/res/values/config.xml")
    .bytes.toString("utf8");
  if (!/<bool name="os_update_enabled">false<\/bool>/.test(config))
    throw new Error(
      "System updater source must remain disabled before product enrollment",
    );
  return { files, enabled: false };
}

export function writeSystemUpdater(output, product, admitted) {
  if (!admitted) return null;
  for (const file of admitted.files) {
    const target = path.join(output, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.bytes, { flag: "wx", mode: 0o644 });
    if (digest(fs.readFileSync(target)) !== file.sha256)
      throw new Error("Staged system updater source changed");
  }
  fs.appendFileSync(
    path.join(output, "product.mk"),
    `\n# Inactive system updater; activation requires separate reviewed enrollment.\n$(call inherit-product, vendor/${product.vendorDirectory}/system-updater/product.mk)\n`,
  );
  return {
    staged: true,
    enabled: false,
    files: admitted.files.map(({ bytes, ...file }) => file),
  };
}
