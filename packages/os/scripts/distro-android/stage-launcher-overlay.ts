#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
/** Validate a downstream HOME APK and stage an additive AOSP product overlay.
 * This does not claim agent payload, privileged permissions, default HOME policy,
 * image boot, or release qualification. The caller owns those separate gates.
 */
import fs from "node:fs";
import os from "node:os";
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

function launcherSigner(signatures: string): string {
  const certificates = [
    ...signatures.matchAll(/certificate SHA-256 digest:\s*(\S+)/g),
  ].map((match) => match[1].replaceAll(":", "").toLowerCase());
  if (certificates.length !== 1 || !/^[a-f0-9]{64}$/.test(certificates[0]))
    throw new Error("Exactly one valid launcher signer is required");
  return certificates[0];
}

/** Self-selecting an APK signer is allowed only for explicit development staging.
 * Production still requires an independently reviewed descriptor. Inspect a
 * private copy; stageLauncher rechecks the actual staged bytes against this pin.
 */
export function createDevelopmentLauncherDescriptor(options: {
  identity: Pick<LauncherDescriptor, "brand" | "moduleName" | "packageName">;
  apk: string;
  apksigner: string;
  development: boolean;
  env?: NodeJS.ProcessEnv;
}): LauncherDescriptor {
  if (options.development !== true)
    throw new Error("Descriptor generation requires explicit development mode");
  const identity = validateDescriptor({
    schemaVersion: 1,
    brand: options.identity.brand,
    moduleName: options.identity.moduleName,
    packageName: options.identity.packageName,
    apkSha256: "0".repeat(64),
    certificateSha256: "0".repeat(64),
  });
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "launcher-descriptor-"),
  );
  try {
    const apk = path.join(temporary, "Launcher.apk");
    fs.copyFileSync(options.apk, apk);
    const apkSha256 = createHash("sha256")
      .update(fs.readFileSync(apk))
      .digest("hex");
    const signatures = execFileSync(
      options.apksigner,
      ["verify", "--print-certs", apk],
      {
        encoding: "utf8",
        env: options.env,
        timeout: 30000,
      },
    );
    return {
      ...identity,
      apkSha256,
      certificateSha256: launcherSigner(signatures),
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
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
  interface ManifestElement {
    indent: number;
    name: string;
    attributes: string[];
    children: ManifestElement[];
    parent?: ManifestElement;
  }
  const elements: ManifestElement[] = [];
  const ancestors: ManifestElement[] = [];
  for (const line of xml.split("\n")) {
    const match = /^(\s*)E: ([\w-]+)/.exec(line);
    if (!match) {
      if (/^\s*A:/.test(line)) ancestors.at(-1)?.attributes.push(line);
      continue;
    }
    const indent = match[1].length;
    while ((ancestors.at(-1)?.indent ?? -1) >= indent) ancestors.pop();
    const parent = ancestors.at(-1);
    const element: ManifestElement = {
      indent,
      name: match[2],
      attributes: [],
      children: [],
      parent,
    };
    parent?.children.push(element);
    elements.push(element);
    ancestors.push(element);
  }
  const disabled = (element: ManifestElement) =>
    element.attributes.some((attribute) =>
      /android:enabled[^\n]*\)0x0(?:\s|$)/.test(attribute),
    );
  const named = (element: ManifestElement, name: string) =>
    element.attributes.some(
      (attribute) =>
        /^\s*A: android:name(?:\([^)]*\))?=/.test(attribute) &&
        attribute.includes(`"${name}"`),
    );
  const homeFilter = elements.some((filter) => {
    const activity = filter.parent;
    if (filter.name !== "intent-filter" || activity?.name !== "activity")
      return false;
    if (
      !activity.attributes.some((attribute) =>
        /android:exported[^\n]*0xffffffff/.test(attribute),
      ) ||
      disabled(activity)
    )
      return false;
    for (let parent = activity.parent; parent; parent = parent.parent) {
      if (parent.name === "application" && disabled(parent)) return false;
    }
    return (
      filter.children.some(
        (child) =>
          child.name === "action" && named(child, "android.intent.action.MAIN"),
      ) &&
      ["android.intent.category.HOME", "android.intent.category.DEFAULT"].every(
        (category) =>
          filter.children.some(
            (child) => child.name === "category" && named(child, category),
          ),
      )
    );
  });
  if (!homeFilter) throw new Error("APK is not a MAIN/HOME/DEFAULT launcher");
  if (!development && /android:debuggable[^\n]*0xffffffff/.test(xml))
    throw new Error("Debug launcher requires --development");
  if (launcherSigner(signatures) !== d.certificateSha256)
    throw new Error("Launcher signer mismatch or multiple signers");
}
export function renderOverlay(d: LauncherDescriptor) {
  return {
    blueprint: `// Generated from a hash- and signer-verified downstream launcher.\nandroid_app_import {\n    name: "${d.moduleName}",\n    apk: "Launcher.apk",\n    presigned: true,\n    preprocessed: true,\n    product_specific: true,\n    dex_preopt: { enabled: false },\n}\n`,
    product: `# Additive: default HOME selection and privilege policy belong to device provisioning.\nPRODUCT_PACKAGES += ${d.moduleName}\n`,
  };
}
export function stageLauncher(options: {
  env?: NodeJS.ProcessEnv;
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
      execFileSync(command, args, { encoding: "utf8", env: options.env });
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
