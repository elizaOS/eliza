/** Owned APK admission reuses reviewed APK signer/hash pins; provenance adds no signature authority. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { androidNativeHost } from "../../browser/scripts/android-host.mjs";
import {
  componentAssetNames,
  validateAssets,
} from "../../browser/scripts/chromium-component.mjs";

export const COMPONENT_ID = "pmldpcoefklbdbgmggcejkfoinmjfeio";
export const OWNED_BROWSER_PACKAGE = "ai.elizaos.chromium";
export const PUBLIC_CHROMIUM_DEBUG_SIGNER =
  "32a2fc74d731105859e5a85df16d95f102d85b22099b8064c5d8915c61dad1e0";
const PUBLIC_AOSP_PLATFORM_SIGNER =
  "c8a2e9bccf597c2fb6dc66bee293fc13f2fc47ec77bc6b2b0d52c11f51192ab8";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const commit = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
function requireProvenance(condition, message) {
  if (!condition) throw new Error(message);
}
export function regularVendorFile(root, relative) {
  requireProvenance(
    typeof relative === "string" &&
      /^[a-zA-Z0-9_.\-/]+$/.test(relative) &&
      relative
        .split("/")
        .every((part) => part && part !== "." && part !== "..") &&
      !path.isAbsolute(relative),
    "Unsafe browser provenance path.",
  );
  let current = path.resolve(root);
  requireProvenance(
    !fs.lstatSync(current).isSymbolicLink(),
    "Browser vendor root must not be linked.",
  );
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    requireProvenance(
      !fs.lstatSync(current).isSymbolicLink(),
      "Browser input must not be a symbolic link.",
    );
  }
  const stat = fs.statSync(current);
  requireProvenance(
    stat.isFile() && stat.nlink === 1,
    "Browser input must be a regular unlinked file.",
  );
  return current;
}
function reference(root, ref, architecture) {
  requireProvenance(
    ref &&
      Object.keys(ref).sort().join(",") === "path,sha256" &&
      digest(ref.sha256) &&
      typeof ref.path === "string" &&
      ref.path.startsWith(`manifests/browser-provenance/${architecture}/`),
    "Invalid owned browser provenance reference.",
  );
  const file = regularVendorFile(root, ref.path);
  requireProvenance(
    fs.statSync(file).size <= 16 * 1024 * 1024,
    "Browser provenance exceeds 16MiB; refusing partial evidence.",
  );
  const bytes = fs.readFileSync(file);
  requireProvenance(
    hash(bytes) === ref.sha256,
    "Owned browser provenance hash mismatch.",
  );
  return bytes;
}
export function validateOwnedPin(pin, architecture) {
  const component = pin.component;
  requireProvenance(
    pin.kind === "owned-component" &&
      pin.packageName === OWNED_BROWSER_PACKAGE &&
      !("sourceUrl" in pin) &&
      component?.schemaVersion === 1 &&
      commit(component.chromiumRevision) &&
      component.extensionId === COMPONENT_ID &&
      digest(component.launcherSignerSha256) &&
      typeof component.launcherApplication === "string" &&
      component.provenance,
    "Invalid owned component pin.",
  );
  androidNativeHost(
    component.launcherSignerSha256,
    component.launcherApplication,
  );
  requireProvenance(
    pin.architectures.length === 1 && pin.architectures[0] === architecture,
    "Owned component architecture must be explicit.",
  );
  if (pin.channel === "stable") {
    requireProvenance(
      ![PUBLIC_CHROMIUM_DEBUG_SIGNER, PUBLIC_AOSP_PLATFORM_SIGNER].includes(
        pin.signerSha256,
      ) &&
        ![PUBLIC_CHROMIUM_DEBUG_SIGNER, PUBLIC_AOSP_PLATFORM_SIGNER].includes(
          component.launcherSignerSha256,
        ),
      "Release owned browser requires production signer identities, not public test keys.",
    );
    throw new Error(
      "Stable owned browser admission is unavailable until the runtime qualification contract is implemented.",
    );
  }
  requireProvenance(
    !component.qualification,
    "Runtime qualification receipts are not yet supported; refusing unvalidated claims.",
  );
}
export function verifyOwnedProvenance(root, pin, architecture) {
  validateOwnedPin(pin, architecture);
  const component = pin.component;
  const document = JSON.parse(
    reference(root, component.provenance, architecture).toString("utf8"),
  );
  requireProvenance(
    document.schemaVersion === 1 &&
      document.repository ===
        "https://chromium.googlesource.com/chromium/src" &&
      document.chromiumRevision === component.chromiumRevision &&
      document.extensionId === COMPONENT_ID &&
      document.launcherSignerSha256 === component.launcherSignerSha256 &&
      document.launcherApplication === component.launcherApplication,
    "Owned component source/identity binding mismatch.",
  );
  const binding = {
    sha256: pin.sha256,
    signerSha256: pin.signerSha256,
    packageName: pin.packageName,
    versionName: pin.versionName,
    versionCode: pin.versionCode,
    architecture,
  };
  for (const [name, value] of Object.entries(binding))
    requireProvenance(
      document.apk?.[name] === value,
      `Owned APK provenance binding mismatch: ${name}.`,
    );
  const overlayBytes = reference(root, document.overlay, architecture);
  const overlay = JSON.parse(overlayBytes.toString("utf8"));
  const reviewed = JSON.parse(
    fs.readFileSync(
      new URL("../../browser/scripts/chromium/upstream.json", import.meta.url),
      "utf8",
    ),
  );
  requireProvenance(
    component.chromiumRevision === reviewed.revision &&
      Object.keys(overlay.inputs ?? {}).length ===
        Object.keys(reviewed.sha256).length &&
      Object.entries(reviewed.sha256).every(
        ([name, value]) => overlay.inputs[name] === value,
      ),
    "Owned component source hashes do not match the reviewed generator pin.",
  );
  requireProvenance(
    overlay.chromiumRevision === component.chromiumRevision &&
      overlay.extensionId === COMPONENT_ID &&
      overlay.platform === "android" &&
      overlay.unrestrictedAllowlistBypass === false,
    "Owned component overlay policy mismatch.",
  );
  requireProvenance(
    hash(reference(root, document.patch, architecture)) === overlay.patchSha256,
    "Owned component patch provenance mismatch.",
  );
  const expectedHost = androidNativeHost(
    component.launcherSignerSha256,
    component.launcherApplication,
  );
  requireProvenance(
    JSON.stringify(overlay.nativeHost) === JSON.stringify(expectedHost),
    "Owned component overlay launcher identity mismatch.",
  );
  const assetNames = componentAssetNames(document.resources ?? {});
  const inventory = (value) =>
    Object.keys(value ?? {})
      .sort()
      .join(",");
  requireProvenance(
    inventory(overlay.resources) === [...assetNames].sort().join(","),
    "Owned overlay resource inventory mismatch.",
  );
  requireProvenance(
    Object.keys(document.resources ?? {})
      .sort()
      .join(",") === [...assetNames].sort().join(","),
    "Owned component resource inventory mismatch.",
  );
  const assets = {};
  for (const name of assetNames) {
    const bytes = reference(root, document.resources[name], architecture);
    requireProvenance(
      overlay.resources?.[name]?.sha256 === hash(bytes) &&
        overlay.resources[name].bytes === bytes.length,
      `Owned component resource mismatch: ${name}.`,
    );
    assets[name] = bytes;
  }
  // Reuse the generator's manifest, resource and host checks without evaluating code.
  validateAssets(
    assets,
    "android",
    component.launcherSignerSha256,
    component.launcherApplication,
  );
  const args = reference(root, document.gnArgs, architecture).toString("utf8");
  const assignment = (name) => {
    const matches = [
      ...args.matchAll(
        new RegExp(`^\\s*${name}\\s*=\\s*([^#\\n]+)\\s*(?:#.*)?$`, "gm"),
      ),
    ];
    requireProvenance(
      matches.length === 1,
      `Owned GN argument must be explicit once: ${name}.`,
    );
    return matches[0][1].trim();
  };
  requireProvenance(
    assignment("target_os") === '"android"' &&
      assignment("target_cpu") ===
        { x86_64: '"x64"', arm64: '"arm64"' }[architecture] &&
      assignment("is_desktop_android") === "true",
    "Owned Chromium Desktop Android GN arguments mismatch.",
  );
  requireProvenance(
    assignment("chrome_public_manifest_package") ===
      JSON.stringify(OWNED_BROWSER_PACKAGE),
    "Owned Chromium GN package does not match the reviewed APK identity.",
  );
  if (pin.channel === "stable")
    requireProvenance(
      assignment("is_debug") === "false" &&
        assignment("is_official_build") === "true",
      "Release owned Chromium requires official non-debug GN arguments.",
    );

  return document;
}
