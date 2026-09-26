import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadBrandConfig } from "../distro-android/brand-config.ts";
import { validateProductLayer } from "../distro-android/validate.ts";

const vendor = fileURLToPath(
  new URL("../../android/vendor/eliza", import.meta.url),
);
const brand = loadBrandConfig(
  fileURLToPath(new URL("../distro-android/brand.eliza.json", import.meta.url)),
);

test("product validation rejects Telecom classes from a different dialer", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "telecom-overlay-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(vendor, root, {
    recursive: true,
    filter: (source) => !/\.(apk|zip|png|webp|so|woff2?)$/.test(source),
  });
  const directory = path.join(
    root,
    "overlays/packages/services/Telecomm/res/values",
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "config.xml"),
    '<resources><string name="incall_default_class">com.android.incallui.InCallServiceImpl</string><string name="dialer_default_class">com.android.dialer.DialtactsActivity</string></resources>',
  );
  assert.throws(
    () => validateProductLayer(root, brand),
    /Telecom overlay incall_default_class/,
  );
});

test("the shipped vendor product has matching Telecom defaults", () => {
  validateProductLayer(vendor, brand);
});
