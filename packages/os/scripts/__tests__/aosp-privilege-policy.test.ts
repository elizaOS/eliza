/** Keeps direct-app debug privileges out of generic AOSP images. */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const aospRoot = `${repositoryRoot}/android/vendor/eliza`;

test("generic AOSP policy excludes the app-only secure-settings grant", () => {
  const manifest = JSON.parse(
    readFileSync(
      `${aospRoot}/manifests/aosp-assistant-full-control.json`,
      "utf8",
    ),
  );
  const privappPermissions = readFileSync(
    `${aospRoot}/permissions/privapp-permissions-ai.elizaos.app.xml`,
    "utf8",
  );
  const validator = readFileSync(
    `${repositoryRoot}/scripts/distro-android/validate.mjs`,
    "utf8",
  );

  expect(manifest.privilegedPermissions).not.toContain(
    "android.permission.WRITE_SECURE_SETTINGS",
  );
  expect(manifest.playStorePolicy.mustStripPermissions).toContain(
    "android.permission.WRITE_SECURE_SETTINGS",
  );
  expect(manifest.playStorePolicy.mustStripComponents).toEqual(
    expect.arrayContaining([
      "Lp3ColorPolicyInitializer",
      "Lp3ColorPolicyService",
    ]),
  );
  expect(manifest.hardwareKeyRemap).toMatchObject({
    status: "explicitly-unsupported-no-dedicated-key",
    mechanism: "framework-role-routing",
    applicableTargets: ["tegu", "grizzly", "Cuttlefish"],
  });
  expect(privappPermissions).not.toContain(
    '<permission name="android.permission.WRITE_SECURE_SETTINGS" />',
  );
  expect(validator).not.toContain("android.permission.WRITE_SECURE_SETTINGS");
});
