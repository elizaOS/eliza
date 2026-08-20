#!/usr/bin/env node

/**
 * ios:device:provision (#13567) — mint iOS **development** provisioning profiles
 * for the app + every appex non-interactively via the App Store Connect API, so
 * the physical-device test lane can install the full app (widgets, keyboard,
 * DeviceActivity, WebsiteBlocker) and rebuild its XCUITest runner WITHOUT a
 * signed-in Xcode account session.
 *
 * Today `ios:device:deploy` needs one development profile per appex
 * (`ios-device-deploy.mjs` `discoverProfiles()` scans
 * `~/Library/MobileDevice/Provisioning Profiles/`); only the main-app profile
 * exists on the lane host, so #13174 added `--skip-appexes` as a stopgap and the
 * appex surfaces are missing from every on-device install. The ASC API can
 * register the device, create bundle ids, and mint development profiles
 * non-interactively — the same `APP_STORE_API_KEY_ID` / `APP_STORE_API_ISSUER_ID`
 * / `APP_STORE_API_KEY_P8` triplet `apple-store-release.yml` already uses for
 * TestFlight. This script wires that path for the DEVELOPMENT test loop
 * (#13118 covers DISTRIBUTION signing separately).
 *
 * Usage:
 *   ios:device:provision --device <UDID> [--product <App.app>] \
 *     [--bundle-id <id> ...] [--app-name <name>] [--dry-run]
 *
 * Bundle ids are resolved from (in precedence order): explicit `--bundle-id`
 * flags, then the appexes discovered inside `--product <App.app>/PlugIns/*.appex`
 * (their `CFBundleIdentifier`) plus the app itself. Idempotent — an already
 * registered device / existing bundle id is reused. Before minting, supported
 * Bundle ID capabilities are reconciled from the maintained target entitlement
 * files; every downloaded profile is decoded and must grant all target
 * entitlements (including exact App Groups) or the run fails closed. Each
 * device gets its own stable profile name, so provisioning one device never
 * removes another device's working profile. Existing valid profiles are
 * reused; invalid or stale same-name profiles are preserved while a uniquely
 * named replacement is created and validated. New bytes stay in a
 * same-filesystem quarantine until validation succeeds, then move atomically
 * into the directory where `discoverProfiles()` looks.
 *
 * The API-flow, JWT construction, and credential handling are exported as pure
 * functions with an injectable `fetchImpl` so the contract is unit-tested
 * without real credentials or the network (`ios-device-provision.test.mjs`); the
 * live run against real ASC creds + a device is the Needs-agent-verify step.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  entitlementSourceForTarget,
  normalizeProvisioningProfile,
  parsePlist,
  profileEntitlementAuthorizes,
  profileMatchesTarget,
} from "./ios-device-lib.mjs";

export const ASC_API_BASE = "https://api.appstoreconnect.apple.com";
export const ASC_AUDIENCE = "appstoreconnect-v1";
export const JWT_TTL_SECONDS = 20 * 60; // ASC rejects tokens older than 20 min.
export const REQUIRED_ENV = [
  "APP_STORE_API_KEY_ID",
  "APP_STORE_API_ISSUER_ID",
  "APP_STORE_API_KEY_P8",
];

export class ProvisioningProfileValidationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ProvisioningProfileValidationError";
  }
}

export function profilesDir() {
  return path.join(
    os.homedir(),
    "Library",
    "MobileDevice",
    "Provisioning Profiles",
  );
}

/**
 * Resolve + validate the ASC API credentials from the environment. Fails fast
 * naming every missing var (mirrors `apple-store-release.yml`), never falling
 * back to a partial/unauthenticated state. `APP_STORE_API_KEY_P8` may be the
 * inline PEM contents OR a path to the `.p8` file.
 */
export function resolveAscCredentials(env = process.env) {
  const missing = REQUIRED_ENV.filter((k) => !env[k] || !String(env[k]).trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing App Store Connect API credentials: ${missing.join(", ")}. ` +
        "Set all three (same secrets as apple-store-release.yml). " +
        "APP_STORE_API_KEY_P8 may be the .p8 contents or a path to the key file.",
    );
  }
  let privateKeyPem = String(env.APP_STORE_API_KEY_P8);
  if (!privateKeyPem.includes("BEGIN") && fs.existsSync(privateKeyPem)) {
    privateKeyPem = fs.readFileSync(privateKeyPem, "utf8");
  }
  return {
    keyId: String(env.APP_STORE_API_KEY_ID).trim(),
    issuerId: String(env.APP_STORE_API_ISSUER_ID).trim(),
    privateKeyPem,
  };
}

const base64url = (input) => Buffer.from(input).toString("base64url");

/**
 * Build a short-lived ES256 App Store Connect JWT from the P8 key. `now`
 * (unix seconds) is injectable so the token is deterministic under test.
 */
export function createAscJwt(
  { keyId, issuerId, privateKeyPem },
  now = Math.floor(Date.now() / 1000),
) {
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = {
    iss: issuerId,
    iat: now,
    exp: now + JWT_TTL_SECONDS,
    aud: ASC_AUDIENCE,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;
  let key;
  try {
    key = crypto.createPrivateKey(privateKeyPem);
  } catch (err) {
    throw new Error(
      `APP_STORE_API_KEY_P8 is not a valid private key: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (key.asymmetricKeyType !== "ec") {
    throw new Error(
      "APP_STORE_API_KEY_P8 must be an EC (P-256) App Store Connect key.",
    );
  }
  // `ieee-p1363` yields the raw r||s signature ES256 (JWS) requires, not DER.
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * A minimal ASC API client bound to a JWT. `fetchImpl` is injectable for tests.
 * Surfaces API errors verbatim (fail fast) rather than swallowing them.
 */
export function makeAscClient({ jwt, fetchImpl = fetch, base = ASC_API_BASE }) {
  return async function asc(method, endpoint, body) {
    const res = await fetchImpl(`${base}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const detail =
        (json.errors || [])
          .map((e) => e.detail || e.title || e.code)
          .filter(Boolean)
          .join("; ") ||
        text ||
        `HTTP ${res.status}`;
      throw new Error(`ASC ${method} ${endpoint} → ${res.status}: ${detail}`);
    }
    return json;
  };
}

/** Ensure the device UDID is registered; reuse it if already present. */
export async function ensureDeviceRegistered(
  asc,
  { udid, name = "eliza-device-lane", platform = "IOS" },
) {
  const existing = await asc(
    "GET",
    `/v1/devices?filter[udid]=${encodeURIComponent(udid)}&limit=1`,
  );
  if (existing.data && existing.data.length > 0) {
    return { id: existing.data[0].id, created: false };
  }
  const created = await asc("POST", "/v1/devices", {
    data: { type: "devices", attributes: { name, platform, udid } },
  });
  return { id: created.data.id, created: true };
}

/**
 * Pick a usable DEVELOPMENT certificate id — a development profile must
 * reference at least one. Throws with actionable guidance if none exists.
 */
export async function getDevelopmentCertificateIds(asc) {
  const certs = await asc(
    "GET",
    "/v1/certificates?filter[certificateType]=DEVELOPMENT&limit=200",
  );
  const ids = (certs.data || []).map((c) => c.id);
  if (ids.length === 0) {
    throw new Error(
      "No DEVELOPMENT certificate found on the App Store Connect team. " +
        "Create an Apple Development certificate (Xcode > Settings > Accounts, " +
        "or the ASC API) before minting development profiles.",
    );
  }
  return ids;
}

/** Ensure a bundle id exists; reuse it if already present. */
export async function ensureBundleId(
  asc,
  { identifier, name, platform = "IOS" },
) {
  const existing = await asc(
    "GET",
    `/v1/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=1`,
  );
  if (existing.data && existing.data.length > 0) {
    return { id: existing.data[0].id, created: false };
  }
  const created = await asc("POST", "/v1/bundleIds", {
    data: {
      type: "bundleIds",
      attributes: { identifier, name: name || identifier, platform },
    },
  });
  return { id: created.data.id, created: true };
}

const ENTITLEMENT_REQUIREMENTS = Object.freeze({
  "com.apple.developer.associated-domains": {
    capabilityType: "ASSOCIATED_DOMAINS",
  },
  "com.apple.developer.family-controls": {
    managed:
      "Family Controls is approval-gated; an Account Holder/Admin must enable the approved capability on this App ID",
  },
  "com.apple.developer.healthkit": { capabilityType: "HEALTHKIT" },
  "com.apple.developer.healthkit.background-delivery": {
    managed:
      "HealthKit background delivery is validated from the minted profile after enabling HEALTHKIT",
  },
  "com.apple.developer.kernel.extended-virtual-addressing": {
    managed:
      "extended virtual addressing is profile-managed and has no App Store Connect CapabilityType",
  },
  "com.apple.developer.kernel.increased-memory-limit": {
    managed:
      "increased memory limit is profile-managed and has no App Store Connect CapabilityType",
  },
  "com.apple.security.application-groups": {
    capabilityType: "APP_GROUPS",
    managed:
      "App Group identifiers must already be registered and assigned to the App ID by an Account Holder/Admin; the public ASC API only enables APP_GROUPS",
  },
  "aps-environment": { capabilityType: "PUSH_NOTIFICATIONS" },
});

export function classifyEntitlementProvisioningRequirements(entitlements = {}) {
  const supportedCapabilities = new Set();
  const profileValidatedManaged = [];
  const unclassified = [];
  for (const key of Object.keys(entitlements)) {
    const requirement = ENTITLEMENT_REQUIREMENTS[key];
    if (!requirement) {
      unclassified.push(key);
      continue;
    }
    if (requirement.capabilityType) {
      supportedCapabilities.add(requirement.capabilityType);
    }
    if (requirement.managed) {
      profileValidatedManaged.push({ key, guidance: requirement.managed });
    }
  }
  return {
    supportedCapabilities: [...supportedCapabilities].sort(),
    profileValidatedManaged,
    unclassified,
  };
}

export function capabilitiesForEntitlements(entitlements = {}) {
  return classifyEntitlementProvisioningRequirements(entitlements)
    .supportedCapabilities;
}

/** Reconcile every ASC-supported capability implied by target entitlements. */
export async function reconcileBundleCapabilities(
  asc,
  { bundleIdRef, entitlements = {} },
) {
  const listed = await asc(
    "GET",
    `/v1/bundleIds/${bundleIdRef}/bundleIdCapabilities?limit=200`,
  );
  const existing = new Set(
    (listed.data ?? []).map((row) => row.attributes?.capabilityType),
  );
  const enabled = [];
  for (const capabilityType of capabilitiesForEntitlements(entitlements)) {
    if (!existing.has(capabilityType)) {
      await asc("POST", "/v1/bundleIdCapabilities", {
        data: {
          type: "bundleIdCapabilities",
          attributes: { capabilityType },
          relationships: {
            bundleId: { data: { type: "bundleIds", id: bundleIdRef } },
          },
        },
      });
    }
    enabled.push(capabilityType);
  }
  return enabled;
}

export function validateProvisioningEntitlements(
  required,
  granted,
  bundleIdentifier,
) {
  const requirements = classifyEntitlementProvisioningRequirements(required);
  if (requirements.unclassified.length > 0) {
    throw new ProvisioningProfileValidationError(
      `Provisioning requirements for ${bundleIdentifier} contain unclassified target entitlements: ${requirements.unclassified.join(", ")}. ` +
        "Add an explicit ASC-supported or profile-managed policy before minting.",
    );
  }
  const applicationIdentifier = granted?.["application-identifier"];
  const appIdPrefix =
    typeof applicationIdentifier === "string"
      ? applicationIdentifier.split(".", 1)[0]
      : null;
  const teamId =
    typeof granted?.["com.apple.developer.team-identifier"] === "string"
      ? granted["com.apple.developer.team-identifier"]
      : appIdPrefix;
  const missing = Object.entries(required ?? {})
    .filter(
      ([key, value]) =>
        !profileEntitlementAuthorizes(key, value, granted?.[key], {
          appIdPrefix,
          teamId,
        }),
    )
    .map(([key]) => key);
  if (missing.length > 0) {
    const guidance = requirements.profileValidatedManaged
      .filter((row) => missing.includes(row.key))
      .map((row) => `${row.key}: ${row.guidance}`)
      .join("; ");
    throw new ProvisioningProfileValidationError(
      `Provisioning profile for ${bundleIdentifier} does not grant target entitlements: ${missing.join(", ")}. ` +
        `${guidance || "Reconcile the Bundle ID capabilities in App Store Connect before deploying."}`,
    );
  }
}

export function decodeMobileProvision(file) {
  const xml = execFileSync("security", ["cms", "-D", "-i", file], {
    encoding: "utf8",
  });
  return parsePlist(xml);
}

/**
 * Keep development profile names stable per bundle+device without embedding the
 * full UDID in ASC-visible names.
 */
export function developmentProfileName(identifier, deviceId) {
  const suffix = crypto
    .createHash("sha256")
    .update(String(deviceId))
    .digest("hex")
    .slice(0, 12);
  return `Eliza Dev - ${identifier} - ${suffix}`;
}

/**
 * Give a replacement profile a collision-resistant name while leaving the
 * previous profile intact. ASC profile names are unique and profiles are
 * immutable, so recovery must create-before-delete; stale profiles can be
 * retired manually after the replacement has been exercised on a device.
 */
export function replacementDevelopmentProfileName(
  stableName,
  randomUuid = () => crypto.randomUUID(),
) {
  const suffix = String(randomUuid()).replaceAll("-", "").slice(0, 12);
  if (!suffix) {
    throw new Error(
      "Unable to generate a development profile replacement name.",
    );
  }
  return `${stableName} - refresh-${suffix}`;
}

/**
 * Mint a development profile for a bundle id, or reuse a same-named profile
 * that already covers this bundle/device/certificate set. Development profiles
 * are immutable and ASC profile names are unique, so an invalid same-name
 * profile is preserved while a uniquely named replacement is created.
 */
function relationshipIds(resource, relationship) {
  const data = resource?.relationships?.[relationship]?.data;
  if (Array.isArray(data)) return data.map((entry) => entry.id);
  if (data?.id) return [data.id];
  return [];
}

export function profileCoversRequest(
  profile,
  { bundleIdRef, deviceIds, certificateIds },
) {
  const bundleIds = relationshipIds(profile, "bundleId");
  const profileDeviceIds = relationshipIds(profile, "devices");
  const profileCertificateIds = relationshipIds(profile, "certificates");
  return (
    bundleIds.includes(bundleIdRef) &&
    deviceIds.every((id) => profileDeviceIds.includes(id)) &&
    certificateIds.every((id) => profileCertificateIds.includes(id))
  );
}

export function profileIsUsable(profile, now = new Date()) {
  const state = profile?.attributes?.profileState;
  if (state && state !== "ACTIVE") return false;
  const expiration = profile?.attributes?.expirationDate;
  if (expiration && new Date(expiration).getTime() <= now.getTime()) {
    return false;
  }
  return true;
}

async function createDevelopmentProfile(
  asc,
  { name, bundleIdRef, deviceIds, certificateIds },
) {
  const created = await asc("POST", "/v1/profiles", {
    data: {
      type: "profiles",
      attributes: { name, profileType: "IOS_APP_DEVELOPMENT" },
      relationships: {
        bundleId: { data: { type: "bundleIds", id: bundleIdRef } },
        devices: {
          data: deviceIds.map((id) => ({ type: "devices", id })),
        },
        certificates: {
          data: certificateIds.map((id) => ({ type: "certificates", id })),
        },
      },
    },
  });
  return created.data;
}

async function createReplacementDevelopmentProfile(
  asc,
  { name, bundleIdRef, deviceIds, certificateIds, replacementNameFactory },
) {
  return {
    profile: await createDevelopmentProfile(asc, {
      name: replacementDevelopmentProfileName(name, replacementNameFactory),
      bundleIdRef,
      deviceIds,
      certificateIds,
    }),
    reused: false,
  };
}

async function listReusableDevelopmentProfiles(
  asc,
  { stableName, bundleIdRef, deviceIds, certificateIds },
) {
  const listed = await asc(
    "GET",
    `/v1/bundleIds/${bundleIdRef}/profiles?fields[profiles]=name,profileType,profileState,profileContent,uuid,createdDate,expirationDate&limit=200`,
  );
  const refreshPrefix = `${stableName} - refresh-`;
  const named = (listed.data ?? []).filter((profile) => {
    const profileName = profile.attributes?.name;
    const profileType = profile.attributes?.profileType;
    return (
      (profileName === stableName || profileName?.startsWith(refreshPrefix)) &&
      (!profileType || profileType === "IOS_APP_DEVELOPMENT")
    );
  });
  named.sort((left, right) => {
    const leftCreated = Date.parse(left.attributes?.createdDate ?? "") || 0;
    const rightCreated = Date.parse(right.attributes?.createdDate ?? "") || 0;
    return rightCreated - leftCreated;
  });

  const reusable = [];
  for (const summary of named) {
    if (!profileIsUsable(summary)) continue;
    const fetched = await asc(
      "GET",
      `/v1/profiles/${summary.id}?include=bundleId,devices,certificates`,
    );
    const profile = fetched.data;
    if (
      profileIsUsable(profile) &&
      profileCoversRequest(profile, {
        bundleIdRef,
        deviceIds,
        certificateIds,
      }) &&
      profile.attributes?.profileContent
    ) {
      reusable.push(profile);
    }
  }
  return { reusable, namedCount: named.length };
}

async function resolveDevelopmentProfile(
  asc,
  { name, bundleIdRef, deviceIds, certificateIds, replacementNameFactory },
) {
  const existing = await asc(
    "GET",
    `/v1/profiles?filter[name]=${encodeURIComponent(name)}&include=bundleId,devices,certificates&limit=1`,
  );
  if (existing.data && existing.data.length > 0) {
    const profile = existing.data[0];
    if (
      profileCoversRequest(profile, { bundleIdRef, deviceIds, certificateIds })
    ) {
      if (!profileIsUsable(profile)) {
        return createReplacementDevelopmentProfile(asc, {
          name,
          bundleIdRef,
          deviceIds,
          certificateIds,
          replacementNameFactory,
        });
      }
      if (profile.attributes?.profileContent) {
        return { profile, reused: true };
      }
      const fetched = await asc("GET", `/v1/profiles/${profile.id}`);
      if (!profileIsUsable(fetched.data)) {
        return createReplacementDevelopmentProfile(asc, {
          name,
          bundleIdRef,
          deviceIds,
          certificateIds,
          replacementNameFactory,
        });
      }
      if (fetched.data?.attributes?.profileContent) {
        return { profile: fetched.data, reused: true };
      }
      return createReplacementDevelopmentProfile(asc, {
        name,
        bundleIdRef,
        deviceIds,
        certificateIds,
        replacementNameFactory,
      });
    }
    return createReplacementDevelopmentProfile(asc, {
      name,
      replacementNameFactory,
      bundleIdRef,
      deviceIds,
      certificateIds,
    });
  }
  return {
    profile: await createDevelopmentProfile(asc, {
      name,
      bundleIdRef,
      deviceIds,
      certificateIds,
    }),
    reused: false,
  };
}

export async function mintDevelopmentProfile(asc, request) {
  const resolution = await resolveDevelopmentProfile(asc, request);
  return resolution.profile;
}

/**
 * Write a minted profile's base64 `profileContent` into `dir` as
 * `<uuid>.mobileprovision` (the shape `discoverProfiles()` reads). Returns the
 * written path.
 */
export function writeProfile(profileData, dir = profilesDir()) {
  const content = profileData?.attributes?.profileContent;
  if (!content) {
    throw new Error(
      `Minted profile ${
        profileData?.attributes?.name || profileData?.id || "?"
      } returned no profileContent.`,
    );
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, profileFilename(profileData));
  fs.writeFileSync(file, Buffer.from(content, "base64"));
  return file;
}

function profileFilename(profileData) {
  const stem = profileData?.attributes?.uuid || profileData?.id;
  if (
    typeof stem !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stem) ||
    path.basename(stem) !== stem
  ) {
    throw new ProvisioningProfileValidationError(
      `Provisioning profile returned an unsafe uuid/id for local storage: ${JSON.stringify(stem)}.`,
    );
  }
  return `${stem}.mobileprovision`;
}

/** Validate profile bytes in a same-filesystem quarantine and optionally install atomically. */
export function validateAndInstallProfile(
  profileData,
  {
    dir = profilesDir(),
    requiredEntitlements = {},
    bundleIdentifier,
    deviceUdid = null,
    now = new Date(),
    decodeProfile = decodeMobileProvision,
    install = true,
  },
) {
  fs.mkdirSync(dir, { recursive: true });
  const quarantine = fs.mkdtempSync(
    path.join(dir, ".eliza-profile-quarantine-"),
  );
  try {
    const quarantinedFile = writeProfile(profileData, quarantine);
    let decoded;
    try {
      decoded = decodeProfile(quarantinedFile);
    } catch (error) {
      // error-policy:J2 Preserve the decoder failure as rejected profile content.
      throw new ProvisioningProfileValidationError(
        `Provisioning profile ${profileData?.attributes?.uuid || profileData?.id || "?"} could not be decoded.`,
        { cause: error },
      );
    }
    const expectedUuid = profileData?.attributes?.uuid ?? profileData?.id;
    if (
      typeof decoded?.UUID !== "string" ||
      decoded.UUID.toUpperCase() !== expectedUuid.toUpperCase()
    ) {
      throw new ProvisioningProfileValidationError(
        `Provisioning profile content UUID ${JSON.stringify(decoded?.UUID)} does not match App Store Connect UUID ${expectedUuid}.`,
      );
    }
    validateProvisioningEntitlements(
      requiredEntitlements,
      decoded?.Entitlements ?? {},
      bundleIdentifier,
    );
    const normalized = normalizeProvisioningProfile(decoded, quarantinedFile);
    const coverage = profileMatchesTarget(normalized, {
      bundleId: bundleIdentifier,
      deviceUdid,
      now,
      requireGetTaskAllow: true,
      requiredEntitlements,
    });
    if (!coverage.ok) {
      throw new ProvisioningProfileValidationError(
        `Provisioning profile for ${bundleIdentifier} is not a usable development profile: ${coverage.reasons.join("; ")}.`,
      );
    }
    if (!install) return null;
    const installedFile = path.join(dir, profileFilename(profileData));
    fs.renameSync(quarantinedFile, installedFile);
    return installedFile;
  } finally {
    fs.rmSync(quarantine, { recursive: true, force: true });
  }
}

/**
 * Discover the app + appex bundle ids from a built `App.app` product by reading
 * each `CFBundleIdentifier` (`plutil`, macOS). `runPlutil` is injectable for
 * tests; the default shells out to `plutil`.
 */
export function discoverAppBundleIds(
  productAppDir,
  { runPlutil, readTargetEntitlements } = {},
) {
  const read =
    runPlutil ||
    ((plistPath) =>
      execFileSync(
        "plutil",
        ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plistPath],
        { encoding: "utf8" },
      ).trim());
  const entitlementsRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "app-core",
    "platforms",
    "ios",
    "App",
    "App",
  );
  const readEntitlements =
    readTargetEntitlements ??
    ((targetName) => {
      const source = path.join(
        entitlementsRoot,
        entitlementSourceForTarget(targetName),
      );
      if (!fs.existsSync(source)) {
        throw new Error(
          `No maintained entitlement source found for iOS target ${targetName}: ${source}`,
        );
      }
      const xml = execFileSync(
        "plutil",
        ["-convert", "xml1", "-o", "-", source],
        {
          encoding: "utf8",
        },
      );
      return parsePlist(xml);
    });
  const out = [];
  const appPlist = path.join(productAppDir, "Info.plist");
  if (fs.existsSync(appPlist)) {
    out.push({
      identifier: read(appPlist),
      name: "App",
      entitlements: readEntitlements("App"),
    });
  }
  const plugIns = path.join(productAppDir, "PlugIns");
  if (fs.existsSync(plugIns)) {
    for (const appex of fs.readdirSync(plugIns)) {
      if (!appex.endsWith(".appex")) continue;
      const plist = path.join(plugIns, appex, "Info.plist");
      if (fs.existsSync(plist)) {
        out.push({
          identifier: read(plist),
          name: appex.replace(/\.appex$/, ""),
          entitlements: readEntitlements(appex.replace(/\.appex$/, "")),
        });
      }
    }
  }
  // De-dup by identifier, first-wins.
  const seen = new Set();
  return out.filter((b) => {
    if (!b.identifier || seen.has(b.identifier)) return false;
    seen.add(b.identifier);
    return true;
  });
}

export function validateBundleIds(bundleIds, source = "provision") {
  if (!bundleIds || bundleIds.length === 0) {
    throw new Error(
      `${source}: no bundle ids resolved (pass --bundle-id or --product with appexes).`,
    );
  }
  for (const bid of bundleIds) {
    if (!bid?.identifier?.trim()) {
      throw new Error(`${source}: resolved an empty bundle identifier.`);
    }
  }
}

/**
 * Full provisioning flow. Idempotent. Returns a per-bundle-id result table.
 * `fetchImpl`, `dir`, and `now` are injectable for tests.
 */
export async function provision({
  creds,
  udid,
  bundleIds,
  deviceName,
  fetchImpl = fetch,
  dir = profilesDir(),
  now,
  decodeProfile = decodeMobileProvision,
  replacementNameFactory,
}) {
  if (!udid) throw new Error("provision: a device UDID is required.");
  validateBundleIds(bundleIds);
  const jwt = createAscJwt(creds, now);
  const asc = makeAscClient({ jwt, fetchImpl });
  const device = await ensureDeviceRegistered(asc, { udid, name: deviceName });
  const certificateIds = await getDevelopmentCertificateIds(asc);
  const results = [];
  for (const bid of bundleIds) {
    const bundle = await ensureBundleId(asc, {
      identifier: bid.identifier,
      name: bid.name,
    });
    await reconcileBundleCapabilities(asc, {
      bundleIdRef: bundle.id,
      entitlements: bid.entitlements ?? {},
    });
    const profileName = developmentProfileName(bid.identifier, device.id);
    const listedProfiles = await listReusableDevelopmentProfiles(asc, {
      stableName: profileName,
      bundleIdRef: bundle.id,
      deviceIds: [device.id],
      certificateIds,
    });
    let profile = null;
    let file = null;
    for (const candidate of listedProfiles.reusable) {
      try {
        const candidateFile = validateAndInstallProfile(candidate, {
          dir,
          requiredEntitlements: bid.entitlements ?? {},
          bundleIdentifier: bid.identifier,
          deviceUdid: udid,
          decodeProfile,
        });
        profile = candidate;
        file = candidateFile;
        break;
      } catch (error) {
        // error-policy:J3 ASC profile content is untrusted input; an explicit
        // validation failure rejects only this candidate and scans the rest.
        // An ACTIVE profile can still carry stale managed grants. Keep scanning
        // newer/older candidates before minting another immutable profile.
        if (!(error instanceof ProvisioningProfileValidationError)) {
          throw error;
        }
      }
    }
    if (!profile) {
      const createName =
        listedProfiles.namedCount === 0
          ? profileName
          : replacementDevelopmentProfileName(
              profileName,
              replacementNameFactory,
            );
      profile = await createDevelopmentProfile(asc, {
        name: createName,
        bundleIdRef: bundle.id,
        deviceIds: [device.id],
        certificateIds,
      });
      file = validateAndInstallProfile(profile, {
        dir,
        requiredEntitlements: bid.entitlements ?? {},
        bundleIdentifier: bid.identifier,
        deviceUdid: udid,
        decodeProfile,
      });
    }
    results.push({
      identifier: bid.identifier,
      bundleCreated: bundle.created,
      profile: profile.attributes?.name || profileName,
      file,
    });
  }
  return { device, certificateIds, results };
}

function parseArgs(argv) {
  const args = { bundleIds: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--device") args.udid = argv[++i];
    else if (a === "--product") args.product = argv[++i];
    else if (a === "--app-name") args.deviceName = argv[++i];
    else if (a === "--bundle-id") args.bundleIds.push(argv[++i]);
    else if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.udid) {
    console.error(
      "ios:device:provision --device <UDID> [--product <App.app>] [--bundle-id <id> ...]",
    );
    process.exit(2);
  }
  const creds = resolveAscCredentials();
  let bundleIds = args.bundleIds.map((identifier) => ({ identifier }));
  if (bundleIds.length === 0 && args.product) {
    bundleIds = discoverAppBundleIds(args.product);
  }
  validateBundleIds(bundleIds, "ios:device:provision");
  if (args.dryRun) {
    // Prove the JWT + resolution without mutating the ASC team.
    createAscJwt(creds);
    console.log(
      `[provision] dry-run — device ${args.udid}, ${bundleIds.length} bundle id(s):`,
    );
    for (const b of bundleIds) console.log(`  - ${b.identifier}`);
    return;
  }
  const { device, results } = await provision({
    creds,
    udid: args.udid,
    bundleIds,
    deviceName: args.deviceName,
  });
  console.log(
    `[provision] device ${args.udid} → id ${device.id} (${
      device.created ? "registered" : "already registered"
    })`,
  );
  console.log("[provision] bundle id                         profile → file");
  for (const r of results) {
    console.log(
      `  ${r.identifier.padEnd(38)} ${r.bundleCreated ? "(new bundle) " : ""}${r.file}`,
    );
  }
  console.log(`[provision] ${results.length} development profile(s) written.`);
}

// Only run when invoked directly, not when imported by the test.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname)
) {
  main().catch((err) => {
    console.error(`[provision] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
