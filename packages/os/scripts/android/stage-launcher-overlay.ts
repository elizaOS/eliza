#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
/** Validate a downstream HOME APK and stage an additive AOSP product overlay.
 * An optional reviewed list of runtime permissions is granted on first boot.
 * This does not claim agent payload, privileged permissions, default HOME policy,
 * image boot, or release qualification. The caller owns those separate gates.
 * Companion APKs (for example an update supervisor) are staged beside it only when
 * they carry the launcher's signer; they get no grants and no privileged placement.
 * Pinned browser and vault APKs are staged by stage-browser-apps.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A second presigned package of the same product, pinned by hash. Its signer pin is
 * the launcher's certificateSha256, so a companion cannot carry another signer. */
export interface CompanionDescriptor {
  moduleName: string;
  packageName: string;
  apkSha256: string;
}
export interface LauncherDescriptor {
  schemaVersion: 1;
  brand: string;
  moduleName: string;
  packageName: string;
  apkSha256: string;
  certificateSha256: string;
  /**
   * Runtime permissions the image grants this launcher on first boot, through
   * a product default-permissions file. Each must be declared by the APK.
   */
  defaultPermissions?: string[];
  /** Default: product. A system-only GSI must carry both APK and grants in system. */
  partition?: "product" | "system";
  /** Same-signer packages staged in the same partition, without grants or HOME. */
  companions?: CompanionDescriptor[];
}
const MODULE = /^[A-Z][A-Za-z0-9]*$/;
const PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PERMISSION = /^android\.permission\.[A-Z][A-Z0-9_]{0,63}$/;
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
  if (!MODULE.test(d.moduleName)) throw new Error("Invalid module name");
  if (!PACKAGE.test(d.packageName)) throw new Error("Invalid package name");
  for (const key of ["apkSha256", "certificateSha256"] as const) {
    if (!SHA256.test(d[key])) throw new Error(`Invalid ${key}`);
  }
  if (
    d.defaultPermissions !== undefined &&
    (!Array.isArray(d.defaultPermissions) ||
      !d.defaultPermissions.length ||
      d.defaultPermissions.length > 32 ||
      new Set(d.defaultPermissions).size !== d.defaultPermissions.length ||
      d.defaultPermissions.some(
        (permission) =>
          typeof permission !== "string" || !PERMISSION.test(permission),
      ))
  )
    throw new Error("Invalid default permissions");
  if (d.partition !== undefined && !["product", "system"].includes(d.partition))
    throw new Error("Invalid launcher partition");
  if (d.companions !== undefined) {
    if (!Array.isArray(d.companions) || !d.companions.length)
      throw new Error("Invalid companions");
    // Staged file and Soong module names must not collide with the launcher's.
    const modules = new Set([
      d.moduleName,
      `${d.moduleName}DefaultPermissions`,
      "Launcher",
    ]);
    const packages = new Set([d.packageName]);
    for (const c of d.companions) {
      if (
        !c ||
        typeof c !== "object" ||
        Object.keys(c).sort().join() !== "apkSha256,moduleName,packageName" ||
        typeof c.moduleName !== "string" ||
        typeof c.packageName !== "string" ||
        typeof c.apkSha256 !== "string" ||
        !MODULE.test(c.moduleName) ||
        !PACKAGE.test(c.packageName) ||
        !SHA256.test(c.apkSha256) ||
        modules.has(c.moduleName) ||
        packages.has(c.packageName)
      )
        throw new Error("Invalid companion");
      modules.add(c.moduleName);
      packages.add(c.packageName);
    }
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
/** True when one eligible exported activity has MAIN/HOME/DEFAULT together.
 * A receiver or a private/disabled activity does not qualify as a launcher. */
function hasHomeActivity(xml: string, anyHomeDeclaration = false): boolean {
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
  return elements.some((filter) => {
    const activity = filter.parent;
    if (filter.name !== "intent-filter") return false;
    // Companion packages must not declare HOME, including aliases and older
    // manifests whose exported state is implicit. They may become enabled later.
    if (anyHomeDeclaration)
      return (
        ["activity", "activity-alias"].includes(activity?.name ?? "") &&
        filter.children.some(
          (child) =>
            child.name === "category" &&
            named(child, "android.intent.category.HOME"),
        )
      );
    if (activity?.name !== "activity") return false;
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
}
const DEBUGGABLE = /android:debuggable[^\n]*0xffffffff/;
export function validateInspection(
  d: LauncherDescriptor,
  badging: string,
  xml: string,
  signatures: string,
  development: boolean,
) {
  if (/package: name='([^']+)'/.exec(badging)?.[1] !== d.packageName)
    throw new Error("Launcher package mismatch");
  if (!hasHomeActivity(xml))
    throw new Error("APK is not a MAIN/HOME/DEFAULT launcher");
  if (!development && DEBUGGABLE.test(xml))
    throw new Error("Debug launcher requires --development");
  if (launcherSigner(signatures) !== d.certificateSha256)
    throw new Error("Launcher signer mismatch or multiple signers");
  const declared = new Set(
    [...badging.matchAll(/^uses-permission: name='([^']+)'/gm)].map(
      (match) => match[1],
    ),
  );
  for (const permission of d.defaultPermissions ?? [])
    if (!declared.has(permission))
      throw new Error(`Launcher does not declare ${permission}`);
}
/** A companion must be the pinned package, carry exactly the launcher's signer and
 * offer no second HOME activity. */
export function validateCompanionInspection(
  d: LauncherDescriptor,
  companion: CompanionDescriptor,
  badging: string,
  xml: string,
  signatures: string,
  development: boolean,
) {
  const name = companion.moduleName;
  if (/package: name='([^']+)'/.exec(badging)?.[1] !== companion.packageName)
    throw new Error(`${name} package mismatch`);
  if (hasHomeActivity(xml, true))
    throw new Error(`${name} must not be a launcher`);
  if (!development && DEBUGGABLE.test(xml))
    throw new Error(`Debug ${name} requires --development`);
  if (launcherSigner(signatures) !== d.certificateSha256)
    throw new Error(`${name} signer differs from the launcher signer`);
}
export function renderOverlay(d: LauncherDescriptor) {
  validateDescriptor(d);
  const partitionProperty =
    d.partition === "system" ? "" : "    product_specific: true,\n";
  const permissionsModule = `${d.moduleName}DefaultPermissions`;
  const permissions = d.defaultPermissions?.length
    ? `<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated from the reviewed launcher descriptor. -->\n<exceptions>\n    <exception package="${d.packageName}">\n${d.defaultPermissions.map((permission) => `        <permission name="${permission}" fixed="false"/>\n`).join("")}    </exception>\n</exceptions>\n`
    : null;
  const app = (name: string, apk: string) =>
    `android_app_import {\n    name: "${name}",\n    apk: "${apk}",\n    presigned: true,\n    preprocessed: true,\n${partitionProperty}    dex_preopt: { enabled: false },\n}\n`;
  const companions = d.companions ?? [];
  return {
    blueprint: `// Generated from a hash- and signer-verified downstream launcher.\n${app(d.moduleName, "Launcher.apk")}${permissions ? `\n// First-boot runtime grants the person can still revoke (fixed="false").\nprebuilt_etc {\n    name: "${permissionsModule}",\n    src: "default-permissions.xml",\n    sub_dir: "default-permissions",\n    filename: "default-permissions-${d.packageName}.xml",\n${partitionProperty}}\n` : ""}${companions.map((c) => `\n// Companion ${c.packageName}: same signer as the launcher, no grants.\n${app(c.moduleName, `${c.moduleName}.apk`)}`).join("")}`,
    product: `# Additive: default HOME selection and privilege policy belong to device provisioning.\nPRODUCT_PACKAGES += ${[d.moduleName, ...(permissions ? [permissionsModule] : []), ...companions.map((c) => c.moduleName)].join(" ")}\n`,
    permissions,
  };
}
export function stageLauncher(options: {
  env?: NodeJS.ProcessEnv;
  descriptor: string;
  apk: string;
  /** One APK path for each descriptor companion, keyed by its moduleName. */
  companions?: Record<string, string>;
  output: string;
  aapt: string;
  apksigner: string;
  development: boolean;
}) {
  const d = validateDescriptor(
    JSON.parse(fs.readFileSync(options.descriptor, "utf8")),
  );
  const companions = d.companions ?? [];
  const supplied = Object.keys(options.companions ?? {}).sort();
  if (
    supplied.join() !==
    companions
      .map((c) => c.moduleName)
      .sort()
      .join()
  )
    throw new Error("Supply exactly one APK for each descriptor companion");
  if (fs.existsSync(options.output))
    throw new Error("Output exists; choose a new staging directory");
  // Inspect the same private copy that is ultimately staged, avoiding a mutable-input race.
  const parent = path.dirname(path.resolve(options.output));
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, ".launcher-stage-"));
  try {
    const copy = (source: string, name: string, sha256: string) => {
      const apk = path.join(temporary, name);
      fs.copyFileSync(source, apk);
      const digest = createHash("sha256")
        .update(fs.readFileSync(apk))
        .digest("hex");
      if (digest !== sha256)
        throw new Error(`${name.slice(0, -4)} APK hash mismatch`);
      return apk;
    };
    // Every hash is checked before any SDK tool runs.
    const apk = copy(options.apk, "Launcher.apk", d.apkSha256);
    const companionApks = companions.map(
      (c) =>
        [
          c,
          copy(
            options.companions?.[c.moduleName] ?? "",
            `${c.moduleName}.apk`,
            c.apkSha256,
          ),
        ] as const,
    );
    const run = (command: string, args: string[]) =>
      execFileSync(command, args, { encoding: "utf8", env: options.env });
    const inspect = (file: string) =>
      [
        run(options.aapt, ["dump", "badging", file]),
        run(options.aapt, ["dump", "xmltree", file, "AndroidManifest.xml"]),
        run(options.apksigner, ["verify", "--print-certs", file]),
      ] as const;
    validateInspection(d, ...inspect(apk), options.development);
    for (const [c, file] of companionApks)
      validateCompanionInspection(d, c, ...inspect(file), options.development);
    const overlay = renderOverlay(d);
    fs.writeFileSync(path.join(temporary, "Android.bp"), overlay.blueprint);
    fs.writeFileSync(path.join(temporary, "product.mk"), overlay.product);
    if (overlay.permissions)
      fs.writeFileSync(
        path.join(temporary, "default-permissions.xml"),
        overlay.permissions,
      );
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
  const companions: Record<string, string> = {};
  let development = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? "";
    if (flag === "--development") {
      development = true;
      continue;
    }
    const value = argv[++i] ?? "";
    const companion =
      flag === "--companion" ? /^([A-Z][A-Za-z0-9]*)=(.+)$/.exec(value) : null;
    if (
      ![
        "--descriptor",
        "--apk",
        "--companion",
        "--output",
        "--aapt",
        "--apksigner",
      ].includes(flag) ||
      !value ||
      value.startsWith("--") ||
      (flag === "--companion" &&
        (!companion?.[1] || !companion[2] || companion[1] in companions))
    )
      throw new Error(
        "Expected --descriptor PATH --apk PATH [--companion MODULE=PATH ...] --output NEW_DIR [--aapt PATH] [--apksigner PATH] [--development]",
      );
    if (companion?.[1] && companion[2]) companions[companion[1]] = companion[2];
    else args[flag.slice(2)] = value;
  }
  if (!args.descriptor || !args.apk || !args.output)
    throw new Error("Descriptor, APK and new output directory are required");
  console.log(
    stageLauncher({
      descriptor: args.descriptor,
      apk: args.apk,
      companions,
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
