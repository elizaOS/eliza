#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
/** Validate a downstream HOME APK and stage an additive AOSP product overlay.
 * This does not claim agent payload, privileged permissions, default HOME policy,
 * image boot, or release qualification. The caller owns those separate gates.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface LauncherDescriptor {
  schemaVersion: 1;
  brand: string;
  moduleName: string;
  packageName: string;
  apkSha256: string;
  certificateSha256: string;
}
export function validateDescriptor(value: unknown): LauncherDescriptor {
  if (!value || typeof value !== "object")
    throw new Error("Launcher descriptor must be an object");
  const d = value as LauncherDescriptor;
  for (const key of [
    "brand",
    "moduleName",
    "packageName",
    "apkSha256",
    "certificateSha256",
  ] as const) {
    if (typeof d[key] !== "string") throw new Error(`Missing string ${key}`);
  }
  if (d.schemaVersion !== 1)
    throw new Error("Unsupported launcher descriptor version");
  if (!/^[a-z][a-z0-9_]*$/.test(d.brand))
    throw new Error("Invalid launcher brand");
  if (!/^[A-Z][A-Za-z0-9]*$/.test(d.moduleName))
    throw new Error("Invalid module name");
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(d.packageName))
    throw new Error("Invalid package name");
  for (const key of ["apkSha256", "certificateSha256"] as const) {
    if (!/^[a-f0-9]{64}$/.test(d[key])) throw new Error(`Invalid ${key}`);
  }
  return d;
}
export function validateInspection(
  d: LauncherDescriptor,
  badging: string,
  xml: string,
  signatures: string,
  development: boolean,
) {
  if (/package: name='([^']+)'/.exec(badging)?.[1] !== d.packageName)
    throw new Error("Launcher package mismatch");
  // Require one eligible exported activity with MAIN/HOME/DEFAULT together.
  // A receiver or a private/disabled activity must not qualify as a launcher.
  const lines = xml.split("\n");
  let homeFilter = false;
  const ancestors: { indent: number; name: string; attributes: string[] }[] =
    [];
  for (let i = 0; i < lines.length; i++) {
    const element = /^(\s*)E: ([\w-]+)/.exec(lines[i]);
    if (!element) {
      if (/^\s*A:/.test(lines[i])) ancestors.at(-1)?.attributes.push(lines[i]);
      continue;
    }
    const indent = element[1].length;
    while ((ancestors.at(-1)?.indent ?? -1) >= indent)
      ancestors.pop();
    const parent = ancestors.at(-1);
    if (element[2] === "intent-filter" && parent?.name === "activity") {
      const attributes = parent.attributes.join("\n");
      const exported = /android:exported[^\n]*0xffffffff/.test(attributes);
      const disabled = /android:enabled[^\n]*\)0x0(?:\s|$)/.test(attributes);
      const appDisabled = ancestors.some(
        (node) =>
          node.name === "application" &&
          /android:enabled[^\n]*\)0x0(?:\s|$)/.test(node.attributes.join("\n")),
      );
      let j = i + 1;
      while (
        j < lines.length &&
        (!lines[j].trim() || lines[j].search(/\S/) > indent)
      )
        j++;
      const filter = lines.slice(i, j).join("\n");
      if (
        exported &&
        !disabled &&
        !appDisabled &&
        [
          "android.intent.action.MAIN",
          "android.intent.category.HOME",
          "android.intent.category.DEFAULT",
        ].every((value) => filter.includes(`"${value}"`))
      )
        homeFilter = true;
    }
    ancestors.push({ indent, name: element[2], attributes: [] });
  }
  if (!homeFilter) throw new Error("APK is not a MAIN/HOME/DEFAULT launcher");
  if (!development && /android:debuggable[^\n]*0xffffffff/.test(xml))
    throw new Error("Debug launcher requires --development");
  const certificates = [
    ...signatures.matchAll(/certificate SHA-256 digest:\s*([a-fA-F0-9:]+)/g),
  ].map((m) => m[1].replaceAll(":", "").toLowerCase());
  if (certificates.length !== 1 || certificates[0] !== d.certificateSha256)
    throw new Error("Launcher signer mismatch or multiple signers");
}
export function renderOverlay(d: LauncherDescriptor) {
  return {
    blueprint: `// Generated from a hash- and signer-verified downstream launcher.\nandroid_app_import {\n    name: "${d.moduleName}",\n    apk: "Launcher.apk",\n    presigned: true,\n    preprocessed: true,\n    product_specific: true,\n    dex_preopt: { enabled: false },\n}\n`,
    product: `# Additive: default HOME selection and privilege policy belong to device provisioning.\nPRODUCT_PACKAGES += ${d.moduleName}\n`,
  };
}
export function stageLauncher(options: {
  descriptor: string;
  apk: string;
  output: string;
  aapt: string;
  apksigner: string;
  development: boolean;
}) {
  const d = validateDescriptor(
    JSON.parse(fs.readFileSync(options.descriptor, "utf8")),
  );
  if (fs.existsSync(options.output))
    throw new Error("Output exists; choose a new staging directory");
  // Inspect the same private copy that is ultimately staged, avoiding a mutable-input race.
  const parent = path.dirname(path.resolve(options.output));
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, ".launcher-stage-"));
  try {
    const apk = path.join(temporary, "Launcher.apk");
    fs.copyFileSync(options.apk, apk);
    const digest = createHash("sha256")
      .update(fs.readFileSync(apk))
      .digest("hex");
    if (digest !== d.apkSha256) throw new Error("Launcher APK hash mismatch");
    const run = (command: string, args: string[]) =>
      execFileSync(command, args, { encoding: "utf8" });
    const badging = run(options.aapt, ["dump", "badging", apk]);
    const xml = run(options.aapt, [
      "dump",
      "xmltree",
      apk,
      "AndroidManifest.xml",
    ]);
    const signatures = run(options.apksigner, ["verify", "--print-certs", apk]);
    validateInspection(d, badging, xml, signatures, options.development);
    const overlay = renderOverlay(d);
    fs.writeFileSync(path.join(temporary, "Android.bp"), overlay.blueprint);
    fs.writeFileSync(path.join(temporary, "product.mk"), overlay.product);
    fs.writeFileSync(
      path.join(temporary, "launcher.json"),
      `${JSON.stringify({ ...d, development: options.development }, null, 2)}\n`,
    );
    fs.renameSync(temporary, options.output);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return path.resolve(options.output);
}
export function main(argv = process.argv.slice(2)) {
  const args: Record<string, string> = {};
  let development = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--development") {
      development = true;
      continue;
    }
    if (
      !["--descriptor", "--apk", "--output", "--aapt", "--apksigner"].includes(
        argv[i],
      ) ||
      !argv[i + 1] ||
      argv[i + 1].startsWith("--")
    )
      throw new Error(
        "Expected --descriptor PATH --apk PATH --output NEW_DIR [--aapt PATH] [--apksigner PATH] [--development]",
      );
    args[argv[i].slice(2)] = argv[++i];
  }
  if (!args.descriptor || !args.apk || !args.output)
    throw new Error("Descriptor, APK and new output directory are required");
  console.log(
    stageLauncher({
      descriptor: args.descriptor,
      apk: args.apk,
      output: args.output,
      aapt: args.aapt || "aapt",
      apksigner: args.apksigner || "apksigner",
      development,
    }),
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
