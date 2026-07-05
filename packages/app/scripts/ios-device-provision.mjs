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
 * registered device / existing bundle id is reused; a same-named profile is
 * refreshed (dev profiles are immutable, so it is deleted + recreated). Minted
 * profiles are written into the profiles dir where `discoverProfiles()` looks.
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

export const ASC_API_BASE = "https://api.appstoreconnect.apple.com";
export const ASC_AUDIENCE = "appstoreconnect-v1";
export const JWT_TTL_SECONDS = 20 * 60; // ASC rejects tokens older than 20 min.
export const REQUIRED_ENV = [
  "APP_STORE_API_KEY_ID",
  "APP_STORE_API_ISSUER_ID",
  "APP_STORE_API_KEY_P8",
];

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

/**
 * Mint (or refresh) a development profile for a bundle id. Development profiles
 * are immutable, so a same-named profile is deleted and recreated with the
 * current device + certificate set.
 */
export async function mintDevelopmentProfile(
  asc,
  { name, bundleIdRef, deviceIds, certificateIds },
) {
  const existing = await asc(
    "GET",
    `/v1/profiles?filter[name]=${encodeURIComponent(name)}&limit=1`,
  );
  if (existing.data && existing.data.length > 0) {
    await asc("DELETE", `/v1/profiles/${existing.data[0].id}`);
  }
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
  const stem = profileData.attributes?.uuid || profileData.id;
  const file = path.join(dir, `${stem}.mobileprovision`);
  fs.writeFileSync(file, Buffer.from(content, "base64"));
  return file;
}

/**
 * Discover the app + appex bundle ids from a built `App.app` product by reading
 * each `CFBundleIdentifier` (`plutil`, macOS). `runPlutil` is injectable for
 * tests; the default shells out to `plutil`.
 */
export function discoverAppBundleIds(productAppDir, { runPlutil } = {}) {
  const read =
    runPlutil ||
    ((plistPath) =>
      execFileSync(
        "plutil",
        ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plistPath],
        { encoding: "utf8" },
      ).trim());
  const out = [];
  const appPlist = path.join(productAppDir, "Info.plist");
  if (fs.existsSync(appPlist)) {
    out.push({ identifier: read(appPlist), name: "App" });
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
}) {
  if (!udid) throw new Error("provision: a device UDID is required.");
  if (!bundleIds || bundleIds.length === 0) {
    throw new Error(
      "provision: no bundle ids resolved (pass --bundle-id or --product with appexes).",
    );
  }
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
    const profileName = `Eliza Dev - ${bid.identifier}`;
    const profile = await mintDevelopmentProfile(asc, {
      name: profileName,
      bundleIdRef: bundle.id,
      deviceIds: [device.id],
      certificateIds,
    });
    const file = writeProfile(profile, dir);
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
