/**
 * Pure decision logic for the App Store Connect (ASC) API device-lane profile
 * minting script (ios-mint-profiles.mjs). Everything here is deterministic and
 * side-effect free except `signAscJwt`, which reads a private key it is handed
 * (the key material never leaves the caller) — so the whole surface is unit
 * testable in the packages/app vitest suite (see ios-asc-lib.test.mjs) with no
 * Apple account, no `fetch`, and only node built-ins.
 *
 * The script owns the impure edges: reading the .p8 file, calling `fetch`
 * against api.appstoreconnect.apple.com, and writing the downloaded
 * .mobileprovision blobs into ~/Library/MobileDevice/Provisioning Profiles/,
 * where ios-device-deploy's discoverProfiles() already scans for them.
 *
 * ASC API reference (as of 2024): profiles / bundleIds / devices are all under
 * https://api.appstoreconnect.apple.com/v1. Auth is a short-lived ES256 JWT
 * signed with the .p8 private key, keyed by the key id, issued by the issuer id
 * (https://developer.apple.com/documentation/appstoreconnectapi/generating_tokens_for_api_requests).
 */
import crypto from "node:crypto";

/** ASC API base — v1 is the only version these endpoints live under. */
export const ASC_API_BASE = "https://api.appstoreconnect.apple.com/v1";

/** JWT audience Apple requires for every ASC token. */
export const ASC_JWT_AUDIENCE = "appstoreconnect-v1";

/**
 * Apple caps ASC token lifetime at 20 minutes; tokens minted for longer are
 * rejected 401. We default to a conservative window well under the cap.
 */
export const ASC_JWT_MAX_LIFETIME_SECONDS = 20 * 60;
export const ASC_JWT_DEFAULT_LIFETIME_SECONDS = 15 * 60;

/** The main app bundle id and every app-extension the device lane must cover. */
export const APP_BUNDLE_ID = "ai.elizaos.app";

/**
 * The five app-extension suffixes appended to APP_BUNDLE_ID. Kept in sync with
 * the PRODUCT_BUNDLE_IDENTIFIER values in the canonical iOS Xcode template
 * (packages/app-core/platforms/ios/App/App.xcodeproj/project.pbxproj) — a new
 * appex there must be added here (or discovered from the built product, see
 * appexBundleIdsFromProduct).
 */
export const APPEX_SUFFIXES = Object.freeze([
  "ElizaKeyboard",
  "ElizaWidgets",
  "DeviceActivityMonitorExtension",
  "DeviceActivityReportExtension",
  "WebsiteBlockerContentExtension",
]);

// ── base64url ───────────────────────────────────────────────────────────

/** RFC 7515 base64url: base64 with +/→-_ and no `=` padding. */
export function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

// ── JWT claim construction + signing ────────────────────────────────────

/**
 * Build the ASC JWT header + payload objects (no signature). Split out from
 * signing so the claim shape is unit-testable without a private key.
 *
 * @param {object} params
 * @param {string} params.keyId       ASC API key id (the `kid` header)
 * @param {string} params.issuerId    ASC API issuer id (the `iss` claim)
 * @param {number} [params.issuedAt]  epoch seconds; defaults to now
 * @param {number} [params.lifetimeSeconds] token lifetime; clamped to the
 *   20-minute Apple cap
 * @returns {{ header: object, payload: object }}
 */
export function buildAscJwtClaims({
  keyId,
  issuerId,
  issuedAt = Math.floor(Date.now() / 1000),
  lifetimeSeconds = ASC_JWT_DEFAULT_LIFETIME_SECONDS,
}) {
  if (!keyId || typeof keyId !== "string") {
    throw new Error("buildAscJwtClaims: keyId is required");
  }
  if (!issuerId || typeof issuerId !== "string") {
    throw new Error("buildAscJwtClaims: issuerId is required");
  }
  if (!Number.isInteger(issuedAt)) {
    throw new Error("buildAscJwtClaims: issuedAt must be an integer");
  }
  const lifetime = Math.min(
    Math.max(1, Math.floor(lifetimeSeconds)),
    ASC_JWT_MAX_LIFETIME_SECONDS,
  );
  return {
    header: { alg: "ES256", kid: keyId, typ: "JWT" },
    payload: {
      iss: issuerId,
      iat: issuedAt,
      exp: issuedAt + lifetime,
      aud: ASC_JWT_AUDIENCE,
    },
  };
}

/**
 * Sign the ASC JWT with the .p8 EC P-256 private key. ES256 over JOSE requires
 * the signature in IEEE P1363 (raw r‖s, 64 bytes) form — node's default EC
 * signature is ASN.1/DER, so we must pass `dsaEncoding: "ieee-p1363"` or Apple
 * rejects the token.
 *
 * @param {{ header: object, payload: object }} claims
 * @param {string|Buffer|crypto.KeyObject} privateKeyPem the .p8 contents (PEM)
 * @returns {string} the compact-serialized JWT
 */
export function signAscJwt(claims, privateKeyPem) {
  const signingInput = `${base64url(JSON.stringify(claims.header))}.${base64url(
    JSON.stringify(claims.payload),
  )}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: privateKeyPem,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64url(signature)}`;
}

// ── bundle-id ↔ appex mapping ───────────────────────────────────────────

/**
 * The full ordered list of bundle ids the device lane provisions: the main app
 * first, then one per appex suffix. Deterministic so the printed per-bundle-id
 * table and the mint order are stable.
 *
 * @param {{ appBundleId?: string, appexSuffixes?: readonly string[] }} [opts]
 * @returns {Array<{ bundleId: string, kind: "app"|"appex", name: string }>}
 */
export function enumerateBundleIds({
  appBundleId = APP_BUNDLE_ID,
  appexSuffixes = APPEX_SUFFIXES,
} = {}) {
  const entries = [{ bundleId: appBundleId, kind: "app", name: "App" }];
  for (const suffix of appexSuffixes) {
    entries.push({
      bundleId: `${appBundleId}.${suffix}`,
      kind: "appex",
      name: suffix,
    });
  }
  return entries;
}

/**
 * Derive appex bundle ids from a built .app product by listing PlugIns/*.appex.
 * Preferred over the static APPEX_SUFFIXES list when a real product is present,
 * so a newly-added extension is provisioned without editing this file. Returns
 * suffixes only (basename minus ".appex"); the caller prefixes the app id.
 *
 * @param {string[]} plugInEntries  readdir of `<App.app>/PlugIns`
 * @returns {string[]} sorted appex suffixes
 */
export function appexSuffixesFromPlugIns(plugInEntries) {
  const suffixes = [];
  for (const entry of plugInEntries) {
    if (typeof entry === "string" && entry.endsWith(".appex")) {
      suffixes.push(entry.slice(0, -".appex".length));
    }
  }
  return suffixes.sort();
}

// ── ASC API request construction ────────────────────────────────────────
//
// Endpoint/payload builders return plain { method, path, body? } descriptors so
// the exact wire shape is asserted in tests; the script turns them into fetch
// calls against ASC_API_BASE with the Bearer JWT + application/json headers.

/** GET the bundleId resource whose `identifier` == bundleId (filter query). */
export function buildFindBundleIdRequest(bundleId) {
  const params = new URLSearchParams({
    "filter[identifier]": bundleId,
    limit: "200",
  });
  return { method: "GET", path: `/bundleIds?${params.toString()}` };
}

/**
 * POST a new bundleId. `platform` is IOS for iOS app + extension ids; `name`
 * must be alphanumeric/space only (Apple rejects dots), so we derive it from
 * the identifier with dots→spaces.
 */
export function buildCreateBundleIdRequest(bundleId) {
  return {
    method: "POST",
    path: "/bundleIds",
    body: {
      data: {
        type: "bundleIds",
        attributes: {
          identifier: bundleId,
          name: bundleIdToName(bundleId),
          platform: "IOS",
        },
      },
    },
  };
}

/** ASC bundleId names may not contain dots; map "a.b.c" → "a b c". */
export function bundleIdToName(bundleId) {
  return bundleId
    .replaceAll(/[^A-Za-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** GET the devices list filtered by UDID. */
export function buildFindDeviceRequest(udid) {
  const params = new URLSearchParams({ "filter[udid]": udid, limit: "200" });
  return { method: "GET", path: `/devices?${params.toString()}` };
}

/**
 * POST-register a device UDID. Apple requires a non-empty name; we default to a
 * lane-recognizable one. platform IOS covers iPhone/iPad development devices.
 */
export function buildRegisterDeviceRequest(udid, { name } = {}) {
  return {
    method: "POST",
    path: "/devices",
    body: {
      data: {
        type: "devices",
        attributes: {
          name: name || `device-lane ${udid}`,
          platform: "IOS",
          udid,
        },
      },
    },
  };
}

/** GET development profiles by exact name (we name profiles deterministically). */
export function buildFindProfileRequest(profileName) {
  const params = new URLSearchParams({
    "filter[name]": profileName,
    limit: "200",
  });
  return { method: "GET", path: `/profiles?${params.toString()}` };
}

/**
 * The deterministic profile name for a bundle id. Stable naming lets the script
 * find-and-delete a stale profile before re-minting (dev profiles are pinned to
 * a device set at creation time, so refreshing a device list means recreate).
 */
export function profileNameForBundleId(bundleId) {
  return `eliza-device-lane ${bundleId}`;
}

/**
 * POST a development profile linking a bundleId to the given certificate + device
 * relationships. profileType IOS_APP_DEVELOPMENT is the development
 * (not distribution) profile the on-device test loop needs.
 *
 * @param {object} params
 * @param {string} params.bundleId        for the deterministic profile name
 * @param {string} params.bundleIdResourceId  ASC id of the bundleId resource
 * @param {string[]} params.certificateIds  ASC ids of dev certificates
 * @param {string[]} params.deviceIds       ASC ids of registered devices
 */
export function buildCreateProfileRequest({
  bundleId,
  bundleIdResourceId,
  certificateIds,
  deviceIds,
}) {
  if (!bundleIdResourceId) {
    throw new Error(
      "buildCreateProfileRequest: bundleIdResourceId is required",
    );
  }
  if (!Array.isArray(certificateIds) || certificateIds.length === 0) {
    throw new Error(
      "buildCreateProfileRequest: at least one certificateId is required",
    );
  }
  if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
    throw new Error(
      "buildCreateProfileRequest: at least one deviceId is required",
    );
  }
  return {
    method: "POST",
    path: "/profiles",
    body: {
      data: {
        type: "profiles",
        attributes: {
          name: profileNameForBundleId(bundleId),
          profileType: "IOS_APP_DEVELOPMENT",
        },
        relationships: {
          bundleId: { data: { type: "bundleIds", id: bundleIdResourceId } },
          certificates: {
            data: certificateIds.map((id) => ({ type: "certificates", id })),
          },
          devices: {
            data: deviceIds.map((id) => ({ type: "devices", id })),
          },
        },
      },
    },
  };
}

/** DELETE a profile by ASC id (used to refresh a stale device-locked profile). */
export function buildDeleteProfileRequest(profileResourceId) {
  return { method: "DELETE", path: `/profiles/${profileResourceId}` };
}

/** GET development certificates (DEVELOPMENT type) to link into new profiles. */
export function buildListCertificatesRequest() {
  const params = new URLSearchParams({
    "filter[certificateType]": "DEVELOPMENT",
    limit: "200",
  });
  return { method: "GET", path: `/certificates?${params.toString()}` };
}

// ── ASC API response parsing ────────────────────────────────────────────

/**
 * The single JSON:API resource in a list response, or null when the list is
 * empty. ASC list endpoints return { data: [...] }; a filtered find returns 0
 * or 1 rows. Throws on a malformed shape rather than fabricating an empty hit —
 * a broken pipeline must not read as "not found".
 */
export function firstResource(responseJson) {
  if (!responseJson || typeof responseJson !== "object") {
    throw new Error("firstResource: response is not an object");
  }
  const data = responseJson.data;
  if (data === undefined) {
    throw new Error("firstResource: response has no `data` field");
  }
  if (!Array.isArray(data)) {
    throw new Error("firstResource: response `data` is not an array");
  }
  return data.length > 0 ? data[0] : null;
}

/**
 * Extract required JSON:API resource ids from a list response. Empty is valid;
 * malformed is not, because callers use the returned list to decide whether a
 * real account has no usable resources.
 */
export function resourceIdsFromListResponse(responseJson, label) {
  if (!responseJson || typeof responseJson !== "object") {
    throw new Error(`${label}: response is not an object`);
  }
  const data = responseJson.data;
  if (data === undefined) {
    throw new Error(`${label}: response has no \`data\` field`);
  }
  if (!Array.isArray(data)) {
    throw new Error(`${label}: response \`data\` is not an array`);
  }
  return data.map((resource) => resource?.id).filter(Boolean);
}

/**
 * Extract the base64 profileContent from a created/read profile resource and
 * decode it to the raw .mobileprovision bytes. Throws when absent — the file we
 * write must be a real profile, never an empty placeholder.
 *
 * @returns {Buffer}
 */
export function decodeProfileContent(profileResource) {
  const content = profileResource?.attributes?.profileContent;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error(
      "decodeProfileContent: profile resource has no profileContent",
    );
  }
  return Buffer.from(content, "base64");
}

/**
 * Turn an ASC error response body into a single actionable line. ASC returns
 * { errors: [{ status, code, title, detail }] }; we join them so a 409/403 from
 * Apple surfaces the real cause instead of a bare status code.
 */
export function formatAscErrors(responseJson, status) {
  const errors = Array.isArray(responseJson?.errors) ? responseJson.errors : [];
  if (errors.length === 0) {
    return `ASC API returned HTTP ${status} with no error detail`;
  }
  return errors
    .map((e) => {
      const parts = [e.status, e.code, e.title, e.detail].filter(Boolean);
      return parts.join(" — ");
    })
    .join("; ");
}

// ── env / arg parsing ───────────────────────────────────────────────────

/**
 * Resolve the ASC credential triplet from env. Mirrors the three secret names
 * apple-store-release.yml already validates (APP_STORE_API_KEY_ID /
 * APP_STORE_API_ISSUER_ID / APP_STORE_API_KEY_P8) and adds APP_STORE_API_KEY_PATH
 * as the .p8-file alternative to the inline PEM. Returns a `{ missing }` list
 * instead of throwing so the script can fail-fast naming every absent var at
 * once (mirroring apple-store-release.yml:411-414).
 *
 * @param {Record<string,string|undefined>} env
 * @returns {{ keyId: string|null, issuerId: string|null, keyPath: string|null,
 *   keyPem: string|null, missing: string[] }}
 */
export function resolveAscCredentials(env) {
  const keyId = trimOrNull(env.APP_STORE_API_KEY_ID);
  const issuerId = trimOrNull(env.APP_STORE_API_ISSUER_ID);
  const keyPath = trimOrNull(env.APP_STORE_API_KEY_PATH);
  const keyPem = trimOrNull(env.APP_STORE_API_KEY_P8);

  const missing = [];
  if (!keyId) missing.push("APP_STORE_API_KEY_ID");
  if (!issuerId) missing.push("APP_STORE_API_ISSUER_ID");
  // Either an on-disk .p8 path OR the inline PEM satisfies the key requirement.
  if (!keyPath && !keyPem) {
    missing.push("APP_STORE_API_KEY_PATH or APP_STORE_API_KEY_P8");
  }
  return { keyId, issuerId, keyPath, keyPem, missing };
}

function trimOrNull(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse this script's CLI: `--device <udid>` (required for a live run),
 * `--check-only` (validate config, never call Apple), `--device-name <name>`,
 * `--profiles-dir <dir>`, `--product <App.app>` (discover appexes from a built
 * product instead of the static list). `--device` also falls back to
 * ELIZA_IOS_DEVICE_UDID / ELIZA_IOS_DEVICE_ID.
 *
 * @param {string[]} argv
 * @param {Record<string,string|undefined>} [env]
 */
export function parseMintArgs(argv, env = {}) {
  const args = {
    device: null,
    deviceName: null,
    profilesDir: null,
    product: null,
    checkOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const [flag, inlineValue] = splitFlag(token);
    // A value flag reads its `--flag=value` form or consumes the next token,
    // advancing the loop index so it is not re-parsed as a bare flag.
    const takeValue = () => {
      if (inlineValue != null) return inlineValue;
      i += 1;
      return argv[i] ?? null;
    };
    switch (flag) {
      case "--check-only":
      case "--dry-run":
        args.checkOnly = true;
        break;
      case "--device":
        args.device = takeValue();
        break;
      case "--device-name":
        args.deviceName = takeValue();
        break;
      case "--profiles-dir":
        args.profilesDir = takeValue();
        break;
      case "--product":
        args.product = takeValue();
        break;
      default:
        // Unknown tokens are ignored so the script composes with wrapper flags.
        break;
    }
  }
  if (!args.device) {
    args.device =
      trimOrNull(env.ELIZA_IOS_DEVICE_UDID) ??
      trimOrNull(env.ELIZA_IOS_DEVICE_ID) ??
      null;
  }
  return args;
}

function splitFlag(token) {
  if (typeof token !== "string" || !token.startsWith("--"))
    return [token, null];
  const eq = token.indexOf("=");
  if (eq === -1) return [token, null];
  return [token.slice(0, eq), token.slice(eq + 1)];
}

/**
 * A UDID is 40 hex chars (older devices) or the newer 25-char
 * XXXXXXXX-XXXXXXXXXXXXXXXX form. We validate shape before hitting Apple so an
 * obvious typo fails locally with an actionable message instead of a 400.
 */
export function isPlausibleUdid(udid) {
  if (typeof udid !== "string") return false;
  const value = udid.trim();
  if (/^[0-9a-fA-F]{40}$/.test(value)) return true;
  if (/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}$/.test(value)) return true;
  return false;
}
