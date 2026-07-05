#!/usr/bin/env node
/**
 * Mint/refresh iOS DEVELOPMENT provisioning profiles for the device test lane
 * via the App Store Connect (ASC) API — no Xcode UI, no interactive account
 * session. Given the ASC key triplet and a device UDID, it ensures the device
 * is registered, ensures a bundle id exists for the main app AND every
 * app-extension, mints/refreshes an IOS_APP_DEVELOPMENT profile for each pinned
 * to that device, and downloads each into
 * ~/Library/MobileDevice/Provisioning Profiles/ — exactly where
 * ios-device-deploy's discoverProfiles() (ios-device-deploy.mjs:110-160)
 * already scans. Idempotent; prints a per-bundle-id table.
 *
 * This is the agent-automatable DEVELOPMENT-profile path that unblocks appex
 * on-device testing (#13567). Distribution signing stays a human step (#13118).
 *
 * Credentials (env; mirrors apple-store-release.yml's three secrets + a file
 * alternative for the key):
 *   APP_STORE_API_KEY_ID     ASC API key id (the .p8's kid)          [required]
 *   APP_STORE_API_ISSUER_ID  ASC API issuer id                       [required]
 *   APP_STORE_API_KEY_PATH   path to AuthKey_<id>.p8    ┐ one of these
 *   APP_STORE_API_KEY_P8     inline .p8 PEM contents    ┘ two required
 *
 * Usage:
 *   node scripts/ios-mint-profiles.mjs --device <udid> [--device-name <name>]
 *     [--product <path/to/App.app>] [--profiles-dir <dir>] [--check-only]
 *
 *   --check-only   validate config + credentials shape and print the plan
 *                  WITHOUT calling Apple or writing any file (offline dry run).
 *   --product      discover appexes from a built .app's PlugIns/ instead of the
 *                  static suffix list (so a new extension is picked up).
 *   --device       falls back to ELIZA_IOS_DEVICE_UDID / ELIZA_IOS_DEVICE_ID.
 *
 * The pure decision logic (JWT claims, request/response shapes, arg/env parsing,
 * appex enumeration) lives in ios-asc-lib.mjs, unit-tested by ios-asc-lib.test.mjs
 * in the packages/app vitest suite. This file owns the impure edges: reading the
 * .p8, `fetch`, and writing profile files.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ASC_API_BASE,
  appexSuffixesFromPlugIns,
  buildAscJwtClaims,
  buildCreateBundleIdRequest,
  buildCreateProfileRequest,
  buildDeleteProfileRequest,
  buildFindBundleIdRequest,
  buildFindDeviceRequest,
  buildFindProfileRequest,
  buildListCertificatesRequest,
  buildRegisterDeviceRequest,
  decodeProfileContent,
  enumerateBundleIds,
  firstResource,
  formatAscErrors,
  isPlausibleUdid,
  parseMintArgs,
  profileNameForBundleId,
  resolveAscCredentials,
  resourceIdsFromListResponse,
  signAscJwt,
} from "./ios-asc-lib.mjs";

const log = (message) => console.log(`[ios-mint-profiles] ${message}`);
const fail = (message) => {
  console.error(`[ios-mint-profiles] ERROR: ${message}`);
  process.exit(1);
};

function defaultProfilesDir() {
  return path.join(
    os.homedir(),
    "Library",
    "MobileDevice",
    "Provisioning Profiles",
  );
}

/** Read the .p8 PEM from the file path or inline env value. */
function loadPrivateKeyPem({ keyPath, keyPem }) {
  if (keyPath) {
    if (!fs.existsSync(keyPath)) {
      fail(`APP_STORE_API_KEY_PATH points at a missing file: ${keyPath}`);
    }
    return fs.readFileSync(keyPath, "utf8");
  }
  return keyPem;
}

/**
 * One authenticated ASC API call. Mints a fresh JWT per call (well under the
 * 20-minute cap; a full run is seconds). Returns parsed JSON on 2xx; throws a
 * boundary error carrying Apple's own error detail on anything else so a
 * 403/409 surfaces its real cause. DELETE returns 200/204 with no body.
 *
 * // error-policy:J1 process/transport boundary — translates a non-2xx ASC
 * // response (or a fetch/parse failure) into a structured, actionable throw.
 */
async function ascRequest({ method, path: apiPath, body }, jwt) {
  const url = `${ASC_API_BASE}${apiPath}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    throw new Error(
      `ASC ${method} ${apiPath} network failure: ${errorMessage(cause)}`,
      { cause },
    );
  }

  const text = await response.text();
  const json = text ? safeJson(text) : null;
  if (!response.ok) {
    throw new Error(
      `ASC ${method} ${apiPath} -> ${formatAscErrors(json, response.status)}`,
    );
  }
  return json;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // error-policy:J3 untrusted-input sanitizing — a non-JSON 2xx body is an
    // explicit "no parseable resource", not a fabricated empty object.
    return null;
  }
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Ensure the device UDID is registered; return its ASC resource id. */
async function ensureDevice(jwt, udid, deviceName) {
  const found = firstResource(
    await ascRequest(buildFindDeviceRequest(udid), jwt),
  );
  if (found) {
    log(`device ${udid} already registered (id ${found.id})`);
    return found.id;
  }
  log(`registering device ${udid}`);
  const created = await ascRequest(
    buildRegisterDeviceRequest(udid, { name: deviceName }),
    jwt,
  );
  const resource = created?.data;
  if (!resource?.id)
    fail(`device registration returned no resource id for ${udid}`);
  return resource.id;
}

/** Ensure a bundle id exists; return its ASC resource id. */
async function ensureBundleId(jwt, bundleId) {
  const found = firstResource(
    await ascRequest(buildFindBundleIdRequest(bundleId), jwt),
  );
  if (found) return found.id;
  log(`creating bundle id ${bundleId}`);
  const created = await ascRequest(buildCreateBundleIdRequest(bundleId), jwt);
  const resource = created?.data;
  if (!resource?.id)
    fail(`bundle id creation returned no resource id for ${bundleId}`);
  return resource.id;
}

/** All DEVELOPMENT certificate resource ids for the account. */
async function listDevelopmentCertificateIds(jwt) {
  const response = await ascRequest(buildListCertificatesRequest(), jwt);
  return resourceIdsFromListResponse(response, "listDevelopmentCertificateIds");
}

/**
 * Mint (or refresh) the development profile for one bundle id pinned to the
 * device set, download it, and write it into profilesDir. Development profiles
 * are immutably device-locked at creation, so a stale same-name profile is
 * deleted first, then recreated with the current device — the idempotent path.
 */
async function mintProfile({
  jwt,
  bundleId,
  bundleIdResourceId,
  certificateIds,
  deviceIds,
  profilesDir,
}) {
  const profileName = profileNameForBundleId(bundleId);
  const existing = firstResource(
    await ascRequest(buildFindProfileRequest(profileName), jwt),
  );
  if (existing) {
    log(
      `refreshing profile "${profileName}" (deleting stale id ${existing.id})`,
    );
    await ascRequest(buildDeleteProfileRequest(existing.id), jwt);
  }
  const created = await ascRequest(
    buildCreateProfileRequest({
      bundleId,
      bundleIdResourceId,
      certificateIds,
      deviceIds,
    }),
    jwt,
  );
  const resource = created?.data;
  if (!resource) fail(`profile creation returned no resource for ${bundleId}`);
  const bytes = decodeProfileContent(resource);
  const outPath = path.join(profilesDir, `${resource.id}.mobileprovision`);
  fs.writeFileSync(outPath, bytes);
  return { profileName, resourceId: resource.id, outPath, bytes: bytes.length };
}

/**
 * Discover appex suffixes from a built product's PlugIns/ dir, or fall back to
 * the static enumeration. Returns the full { bundleId, kind, name } list.
 */
function resolveBundleEntries(productPath) {
  if (!productPath) return enumerateBundleIds();
  const plugIns = path.join(productPath, "PlugIns");
  if (!fs.existsSync(plugIns)) {
    fail(
      `--product ${productPath} has no PlugIns/ dir; point it at a built App.app`,
    );
  }
  const suffixes = appexSuffixesFromPlugIns(fs.readdirSync(plugIns));
  log(`discovered ${suffixes.length} appex(es) from ${plugIns}`);
  return enumerateBundleIds({ appexSuffixes: suffixes });
}

function printPlan(entries, { device, profilesDir, checkOnly }) {
  log(`bundle ids to provision (device ${device}):`);
  for (const entry of entries) {
    log(`  - [${entry.kind}] ${entry.bundleId}`);
  }
  log(`profiles dir: ${profilesDir}`);
  if (checkOnly) log("check-only: no Apple API calls, no files written");
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseMintArgs(argv, process.env);
  const profilesDir = args.profilesDir || defaultProfilesDir();
  const entries = resolveBundleEntries(args.product);

  const creds = resolveAscCredentials(process.env);

  // --check-only: validate everything reachable offline, print the plan, exit.
  // Device UDID + credential presence + key readability are all verifiable
  // without touching Apple.
  if (args.checkOnly) {
    printPlan(entries, { device: args.device, profilesDir, checkOnly: true });
    const problems = [];
    if (!args.device) {
      problems.push("no --device UDID (or ELIZA_IOS_DEVICE_UDID/_ID)");
    } else if (!isPlausibleUdid(args.device)) {
      problems.push(`--device "${args.device}" is not a plausible UDID`);
    }
    if (creds.missing.length > 0) {
      problems.push(`missing ASC credentials: ${creds.missing.join(", ")}`);
    } else {
      // Prove the key parses + a JWT can be constructed & signed, all offline.
      try {
        const pem = loadPrivateKeyPem(creds);
        const claims = buildAscJwtClaims({
          keyId: creds.keyId,
          issuerId: creds.issuerId,
        });
        signAscJwt(claims, pem);
        log("ASC credentials present; .p8 parsed and a test JWT was signed");
      } catch (cause) {
        problems.push(`.p8 key unusable: ${errorMessage(cause)}`);
      }
    }
    if (problems.length > 0) {
      fail(`check-only found problems:\n  - ${problems.join("\n  - ")}`);
    }
    log("check-only PASSED: config + credentials + key are usable");
    return;
  }

  // ── Live run ──────────────────────────────────────────────────────────
  if (!args.device) {
    fail(
      "no device UDID — pass --device <udid> or set ELIZA_IOS_DEVICE_UDID / ELIZA_IOS_DEVICE_ID",
    );
  }
  if (!isPlausibleUdid(args.device)) {
    fail(
      `--device "${args.device}" is not a plausible UDID (40 hex or 8-16 hex form)`,
    );
  }
  if (creds.missing.length > 0) {
    fail(
      `missing ASC credentials: ${creds.missing.join(", ")}. ` +
        "Set these (see apple-store-release.yml for the same secret names).",
    );
  }

  const pem = loadPrivateKeyPem(creds);
  const jwt = signAscJwt(
    buildAscJwtClaims({ keyId: creds.keyId, issuerId: creds.issuerId }),
    pem,
  );

  fs.mkdirSync(profilesDir, { recursive: true });
  printPlan(entries, { device: args.device, profilesDir, checkOnly: false });

  const deviceId = await ensureDevice(jwt, args.device, args.deviceName);
  const certificateIds = await listDevelopmentCertificateIds(jwt);
  if (certificateIds.length === 0) {
    fail(
      "no DEVELOPMENT certificates found in the ASC account — create an Apple " +
        "Development certificate for this team first (Xcode or ASC portal).",
    );
  }
  log(`linking ${certificateIds.length} development certificate(s)`);

  const results = [];
  for (const entry of entries) {
    const bundleIdResourceId = await ensureBundleId(jwt, entry.bundleId);
    const minted = await mintProfile({
      jwt,
      bundleId: entry.bundleId,
      bundleIdResourceId,
      certificateIds,
      deviceIds: [deviceId],
      profilesDir,
    });
    results.push({ ...entry, ...minted });
  }

  log("minted profiles:");
  for (const r of results) {
    log(
      `  ✓ [${r.kind}] ${r.bundleId} -> ${path.basename(r.outPath)} (${r.bytes} bytes)`,
    );
  }
  log(
    `done: ${results.length} profile(s) written to ${profilesDir}. ` +
      "ios:device:deploy will now discover them (one per app + appex).",
  );
}

main().catch((error) => {
  // error-policy:J1 top-level boundary — surface any unhandled failure with a
  // nonzero exit and Apple's / the pipeline's real cause, never a silent pass.
  fail(error?.stack || error?.message || String(error));
});

export { main };
