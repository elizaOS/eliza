/**
 * Pure decision logic for the one-command iOS device automation scripts
 * (ios-device-deploy.mjs / ios-device-logs.mjs / ios-device-capture.mjs).
 *
 * Everything exported here is deterministic, or takes impure edges as injected
 * dependencies, so it can be unit-tested (see ios-device-lib.test.mjs, run by
 * `bun run --cwd packages/app test`, i.e. the root test:client lane). The
 * scripts own the actual impure edges (spawning `security` / `xcodebuild` /
 * `devicectl`, reading files).
 */
import crypto from "node:crypto";

// ── XML property-list parse / serialize ─────────────────────────────────
// Provisioning profiles (`security cms -D`), entitlements plists, and
// .xctestrun files are all XML plists. We parse the subset Apple emits:
// dict / array / string / integer / real / true / false / date / data.

/** Wrapper for <data> nodes so values survive a parse → serialize round trip. */
export class PlistData {
  /** @param {string} base64 whitespace-free base64 payload */
  constructor(base64) {
    this.base64 = base64;
  }
  toBuffer() {
    return Buffer.from(this.base64, "base64");
  }
}

const XML_ENTITIES = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeXmlText(text) {
  return text.replace(
    /&(?:lt|gt|amp|quot|apos|#x?[0-9a-fA-F]+);/g,
    (entity) => {
      if (XML_ENTITIES[entity]) return XML_ENTITIES[entity];
      const numeric = entity.startsWith("&#x")
        ? Number.parseInt(entity.slice(3, -1), 16)
        : Number.parseInt(entity.slice(2, -1), 10);
      return String.fromCodePoint(numeric);
    },
  );
}

function encodeXmlText(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function tokenizePlistXml(xml) {
  const tokens = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*?)?)(\/?)>|([^<]+)/g;
  let match = re.exec(xml);
  while (match !== null) {
    if (match[5] !== undefined) {
      tokens.push({ kind: "text", text: match[5] });
    } else if (match[1] === "/") {
      tokens.push({ kind: "close", tag: match[2] });
    } else if (match[4] === "/") {
      tokens.push({ kind: "selfclose", tag: match[2] });
    } else {
      tokens.push({ kind: "open", tag: match[2] });
    }
    match = re.exec(xml);
  }
  return tokens;
}

/**
 * Parse an XML plist document (or fragment) into JS values.
 * dict → plain object, array → Array, string → string, integer/real → number,
 * true/false → boolean, date → Date, data → PlistData.
 *
 * @param {string} xml
 * @returns {unknown} the root value
 */
export function parsePlist(xml) {
  const start = xml.indexOf("<plist");
  const scoped =
    start === -1
      ? xml
      : xml.slice(xml.indexOf(">", start) + 1, xml.lastIndexOf("</plist>"));
  const tokens = tokenizePlistXml(scoped).filter(
    (t) => !(t.kind === "text" && t.text.trim() === ""),
  );
  let index = 0;

  function fail(message) {
    throw new Error(`[parsePlist] ${message} (token #${index})`);
  }

  function collectText(closeTag) {
    let text = "";
    while (index < tokens.length && tokens[index].kind === "text") {
      text += tokens[index].text;
      index += 1;
    }
    const closer = tokens[index];
    if (closer?.kind !== "close" || closer.tag !== closeTag) {
      fail(`expected </${closeTag}>`);
    }
    index += 1;
    return text;
  }

  function parseValue() {
    const token = tokens[index];
    if (!token) fail("unexpected end of document");
    if (token.kind === "selfclose") {
      index += 1;
      switch (token.tag) {
        case "true":
          return true;
        case "false":
          return false;
        case "dict":
          return {};
        case "array":
          return [];
        case "string":
          return "";
        case "data":
          return new PlistData("");
        default:
          fail(`unsupported self-closing <${token.tag}/>`);
      }
    }
    if (token.kind !== "open")
      fail(`expected an opening tag, got ${token.kind}`);
    index += 1;
    switch (token.tag) {
      case "dict": {
        const dict = {};
        while (tokens[index] && tokens[index].kind !== "close") {
          const keyToken = tokens[index];
          if (keyToken.kind !== "open" || keyToken.tag !== "key") {
            fail("expected <key> inside <dict>");
          }
          index += 1;
          const key = decodeXmlText(collectText("key"));
          dict[key] = parseValue();
        }
        if (tokens[index]?.tag !== "dict") fail("expected </dict>");
        index += 1;
        return dict;
      }
      case "array": {
        const items = [];
        while (tokens[index] && tokens[index].kind !== "close") {
          items.push(parseValue());
        }
        if (tokens[index]?.tag !== "array") fail("expected </array>");
        index += 1;
        return items;
      }
      case "string":
        return decodeXmlText(collectText("string"));
      case "integer":
        return Number.parseInt(collectText("integer").trim(), 10);
      case "real":
        return Number.parseFloat(collectText("real").trim());
      case "date":
        return new Date(collectText("date").trim());
      case "data":
        return new PlistData(collectText("data").replace(/\s+/g, ""));
      default:
        return fail(`unsupported plist tag <${token.tag}>`);
    }
  }

  const value = parseValue();
  if (index !== tokens.length) fail("trailing content after root value");
  return value;
}

function serializePlistValue(value, indent) {
  const pad = "\t".repeat(indent);
  if (value === true) return `${pad}<true/>`;
  if (value === false) return `${pad}<false/>`;
  if (typeof value === "string")
    return `${pad}<string>${encodeXmlText(value)}</string>`;
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? `${pad}<integer>${value}</integer>`
      : `${pad}<real>${value}</real>`;
  }
  if (value instanceof Date)
    return `${pad}<date>${value.toISOString().replace(/\.\d{3}Z$/, "Z")}</date>`;
  if (value instanceof PlistData) return `${pad}<data>${value.base64}</data>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}<array/>`;
    const items = value.map((item) => serializePlistValue(item, indent + 1));
    return `${pad}<array>\n${items.join("\n")}\n${pad}</array>`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return `${pad}<dict/>`;
    const entries = keys.map(
      (key) =>
        `${pad}\t<key>${encodeXmlText(key)}</key>\n${serializePlistValue(value[key], indent + 1)}`,
    );
    return `${pad}<dict>\n${entries.join("\n")}\n${pad}</dict>`;
  }
  throw new Error(`[buildPlistXml] unsupported value: ${String(value)}`);
}

/**
 * Serialize a JS value (as produced by parsePlist) back to an XML plist doc.
 * @param {unknown} value
 * @returns {string}
 */
export function buildPlistXml(value) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    serializePlistValue(value, 0),
    "</plist>",
    "",
  ].join("\n");
}

// ── Provisioning profile model ──────────────────────────────────────────

/**
 * Normalize a decoded provisioning-profile plist (the output of
 * `security cms -D -i <file>` run through parsePlist) into the record the
 * selection logic consumes.
 *
 * @param {Record<string, unknown>} plist
 * @param {string} sourcePath where the profile came from (for diagnostics)
 */
export function normalizeProvisioningProfile(plist, sourcePath) {
  const entitlements =
    plist.Entitlements && typeof plist.Entitlements === "object"
      ? plist.Entitlements
      : {};
  const certs = Array.isArray(plist.DeveloperCertificates)
    ? plist.DeveloperCertificates
    : [];
  return {
    name: typeof plist.Name === "string" ? plist.Name : "(unnamed)",
    uuid: typeof plist.UUID === "string" ? plist.UUID : null,
    applicationIdentifier:
      typeof entitlements["application-identifier"] === "string"
        ? entitlements["application-identifier"]
        : null,
    teamId:
      Array.isArray(plist.TeamIdentifier) && plist.TeamIdentifier.length > 0
        ? plist.TeamIdentifier[0]
        : null,
    appIdPrefix:
      Array.isArray(plist.ApplicationIdentifierPrefix) &&
      plist.ApplicationIdentifierPrefix.length > 0
        ? plist.ApplicationIdentifierPrefix[0]
        : null,
    expirationDate:
      plist.ExpirationDate instanceof Date ? plist.ExpirationDate : null,
    provisionedDevices: Array.isArray(plist.ProvisionedDevices)
      ? plist.ProvisionedDevices.map(String)
      : [],
    provisionsAllDevices: plist.ProvisionsAllDevices === true,
    developerCertificateSha1s: certs
      .filter((cert) => cert instanceof PlistData)
      .map((cert) =>
        crypto
          .createHash("sha1")
          .update(cert.toBuffer())
          .digest("hex")
          .toUpperCase(),
      ),
    getTaskAllow: entitlements["get-task-allow"] === true,
    entitlements,
    sourcePath,
  };
}

/**
 * Does `profile` provision `bundleId` on `deviceUdid` right now?
 * Returns { ok, reasons } — reasons is the list of disqualifiers (empty when ok).
 *
 * @param {ReturnType<typeof normalizeProvisioningProfile>} profile
 * @param {{ bundleId: string, deviceUdid: string | null, now?: Date }} target
 */
export function profileMatchesTarget(
  profile,
  { bundleId, deviceUdid, now = new Date() },
) {
  const reasons = [];
  const appId = profile.applicationIdentifier;
  if (!appId) {
    reasons.push("profile has no application-identifier entitlement");
  } else {
    const dot = appId.indexOf(".");
    const identifierPart = dot === -1 ? appId : appId.slice(dot + 1);
    const exact = identifierPart === bundleId;
    const wildcard =
      identifierPart === "*" ||
      (identifierPart.endsWith(".*") &&
        bundleId.startsWith(identifierPart.slice(0, -1)));
    if (!exact && !wildcard) {
      reasons.push(
        `application-identifier ${appId} does not cover bundle id ${bundleId}`,
      );
    }
  }
  if (!profile.expirationDate) {
    reasons.push("profile has no expiration date");
  } else if (profile.expirationDate.getTime() <= now.getTime()) {
    reasons.push(`profile expired ${profile.expirationDate.toISOString()}`);
  }
  if (deviceUdid && !profile.provisionsAllDevices) {
    if (!profile.provisionedDevices.includes(deviceUdid)) {
      reasons.push(`device UDID ${deviceUdid} not in ProvisionedDevices`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Pick the best profile for a bundle id + device out of the discovered set.
 * Preference order: exact application-identifier over wildcard, then latest
 * expiration date. Returns { selected, rejected } — rejected carries the
 * per-profile disqualifiers so callers can print actionable remediation.
 *
 * @param {Array<ReturnType<typeof normalizeProvisioningProfile>>} profiles
 * @param {{ bundleId: string, deviceUdid: string | null, now?: Date }} target
 */
export function selectProvisioningProfile(profiles, target) {
  const rejected = [];
  const matching = [];
  for (const profile of profiles) {
    const verdict = profileMatchesTarget(profile, target);
    if (verdict.ok) {
      matching.push(profile);
    } else {
      rejected.push({ profile, reasons: verdict.reasons });
    }
  }
  const isExact = (profile) => {
    const appId = profile.applicationIdentifier ?? "";
    const dot = appId.indexOf(".");
    return (dot === -1 ? appId : appId.slice(dot + 1)) === target.bundleId;
  };
  matching.sort((a, b) => {
    const exactDelta = Number(isExact(b)) - Number(isExact(a));
    if (exactDelta !== 0) return exactDelta;
    return (
      (b.expirationDate?.getTime() ?? 0) - (a.expirationDate?.getTime() ?? 0)
    );
  });
  return { selected: matching[0] ?? null, rejected };
}

// ── Signing identity discovery ──────────────────────────────────────────

/**
 * Parse `security find-identity -v -p codesigning` output.
 * @param {string} output
 * @returns {Array<{ hash: string, name: string }>}
 */
export function parseCodesigningIdentities(output) {
  const identities = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/);
    if (match) identities.push({ hash: match[1], name: match[2] });
  }
  return identities;
}

/**
 * Choose the signing identity whose certificate is embedded in the profile
 * (profile.developerCertificateSha1s are SHA-1s of the DER certs, which are
 * exactly the identity hashes `security find-identity` prints).
 *
 * @param {Array<{ hash: string, name: string }>} identities
 * @param {ReturnType<typeof normalizeProvisioningProfile>} profile
 */
export function selectSigningIdentity(identities, profile) {
  return (
    identities.find((identity) =>
      profile.developerCertificateSha1s.includes(identity.hash),
    ) ?? null
  );
}

// ── Entitlement derivation ──────────────────────────────────────────────

/**
 * Derive the entitlements to sign with from a profile's Entitlements dict,
 * resolving a wildcard application-identifier to the concrete bundle id.
 * (This mirrors what Xcode does: the signed entitlements must be a subset of
 * what the profile authorizes, and the application-identifier must be exact.)
 *
 * @param {ReturnType<typeof normalizeProvisioningProfile>} profile
 * @param {string} bundleId
 * @returns {Record<string, unknown>}
 */
export function deriveSigningEntitlements(profile, bundleId) {
  const entitlements = { ...profile.entitlements };
  const appId = entitlements["application-identifier"];
  if (typeof appId === "string") {
    const dot = appId.indexOf(".");
    const prefix = dot === -1 ? profile.appIdPrefix : appId.slice(0, dot);
    const identifierPart = dot === -1 ? appId : appId.slice(dot + 1);
    if (identifierPart.includes("*")) {
      entitlements["application-identifier"] = `${prefix}.${bundleId}`;
    }
  }
  // keychain-access-groups with wildcards break codesign on device installs;
  // resolve them the same way.
  if (Array.isArray(entitlements["keychain-access-groups"])) {
    entitlements["keychain-access-groups"] = entitlements[
      "keychain-access-groups"
    ].map((group) =>
      typeof group === "string" && group.endsWith(".*")
        ? `${group.slice(0, -1)}${bundleId}`
        : group,
    );
  }
  return entitlements;
}

// ── Codesign ordering ───────────────────────────────────────────────────

/**
 * Build the inner→outer codesign step list for a staged .app:
 * frameworks first, then loose dylibs (including dylibs nested in appexes —
 * `codesign --verify --deep` does NOT catch unsigned ones, see the #11030
 * device-boot recipe), then each appex with its entitlements, then the app.
 *
 * @param {{
 *   appPath: string,
 *   frameworks: string[],
 *   dylibs: string[],
 *   appexes: Array<{ path: string, entitlementsPath: string }>,
 *   appEntitlementsPath: string,
 * }} layout
 * @returns {Array<{ path: string, entitlementsPath: string | null }>}
 */
export function buildCodesignPlan(layout) {
  const steps = [];
  for (const framework of layout.frameworks) {
    steps.push({ path: framework, entitlementsPath: null });
  }
  for (const dylib of layout.dylibs) {
    steps.push({ path: dylib, entitlementsPath: null });
  }
  for (const appex of layout.appexes) {
    steps.push({ path: appex.path, entitlementsPath: appex.entitlementsPath });
  }
  steps.push({
    path: layout.appPath,
    entitlementsPath: layout.appEntitlementsPath,
  });
  return steps;
}

// ── .xctestrun manipulation ─────────────────────────────────────────────

/**
 * Point every UITargetAppPath in a parsed .xctestrun at a replacement app
 * (used on device runs to drive the grafted-signature App.app instead of the
 * unsigned build product). Returns the number of entries rewritten.
 *
 * @param {Record<string, unknown>} xctestrun parsed plist root
 * @param {string} newAppPath absolute path to the signed App.app
 */
export function rewriteXctestrunUITargetApp(xctestrun, newAppPath) {
  let rewritten = 0;
  const rewriteConfigurations = (configurations) => {
    for (const config of configurations ?? []) {
      for (const testTarget of config?.TestTargets ?? []) {
        if (typeof testTarget?.UITargetAppPath === "string") {
          testTarget.UITargetAppPath = newAppPath;
          rewritten += 1;
        }
      }
    }
  };
  // FormatVersion 2 puts TestConfigurations at the ROOT of the plist.
  rewriteConfigurations(
    Array.isArray(xctestrun.TestConfigurations)
      ? xctestrun.TestConfigurations
      : [],
  );
  for (const [key, value] of Object.entries(xctestrun)) {
    if (key === "__xctestrun_metadata__" || key === "TestConfigurations")
      continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      // FormatVersion 1: one dict per test target at the root.
      if (typeof value.UITargetAppPath === "string") {
        value.UITargetAppPath = newAppPath;
        rewritten += 1;
      }
    }
  }
  return rewritten;
}

/**
 * Rewrite stale references to the unsigned build-product App.app in every
 * DependentProductPaths array of a parsed .xctestrun, pointing them at the
 * signed replacement app. Device runs graft a signed App.app over the
 * unsigned one that build-for-testing left in DerivedData; rewriteXctestrun-
 * UITargetApp only fixes UITargetAppPath, but xcodebuild also installs the
 * bundles listed in each test target's DependentProductPaths — a lingering
 * reference to the unsigned `…/App.app` there makes the device install fail
 * with 0xe800801c ("No code signature") even after the UITargetAppPath rewrite.
 *
 * A path is considered stale when its basename equals the signed app's
 * basename (e.g. `App.app`) but the path itself is not already the signed app.
 * Runner apps, frameworks, and other dependent products are left untouched.
 * Returns the number of entries rewritten.
 *
 * @param {Record<string, unknown>} xctestrun parsed plist root
 * @param {string} newAppPath absolute path to the signed App.app (already
 *   __TESTROOT__-resolved)
 * @returns {number}
 */
export function sweepXctestrunDependentProductPaths(xctestrun, newAppPath) {
  const targetBase = basenameOf(newAppPath);
  let rewritten = 0;
  const sweepTarget = (testTarget) => {
    if (!testTarget || typeof testTarget !== "object") return;
    const deps = testTarget.DependentProductPaths;
    if (!Array.isArray(deps)) return;
    for (let i = 0; i < deps.length; i += 1) {
      const dep = deps[i];
      if (typeof dep !== "string") continue;
      if (dep === newAppPath) continue;
      if (basenameOf(dep) === targetBase) {
        deps[i] = newAppPath;
        rewritten += 1;
      }
    }
  };
  // FormatVersion 2: TestConfigurations array at the ROOT of the plist.
  if (Array.isArray(xctestrun.TestConfigurations)) {
    for (const config of xctestrun.TestConfigurations) {
      for (const testTarget of config?.TestTargets ?? []) {
        sweepTarget(testTarget);
      }
    }
  }
  // FormatVersion 1: one dict per test target at the root.
  for (const [key, value] of Object.entries(xctestrun)) {
    if (key === "__xctestrun_metadata__" || key === "TestConfigurations")
      continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    sweepTarget(value);
  }
  return rewritten;
}

/**
 * Cross-platform basename that treats both `/` and `\` as separators and
 * ignores a single trailing separator (an .app path may be written with one).
 * @param {string} p
 * @returns {string}
 */
function basenameOf(p) {
  const trimmed = p.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Decide whether — and where — to overwrite the DerivedData build product
 * App.app with the signed staged app before `test-without-building`.
 *
 * On a device run, `build-for-testing` leaves an UNSIGNED `App.app` in
 * `<derivedData>/Build/Products/<config>-iphoneos/App.app`. Even after the
 * .xctestrun's UITargetAppPath is rewritten to the signed graft, xcodebuild
 * still installs the DD product, and the device install fails 0xe800801c.
 * The proven fix is to `ditto` the signed app over the DD product first.
 *
 * Pure: returns the overwrite plan (or a skip reason) so the impure script
 * layer can log + execute the `ditto`. Only overwrites on device runs when a
 * signed --app-path is provided and the DD product exists.
 *
 * @param {{
 *   platform: 'sim' | 'device',
 *   signedAppPath: string | null,
 *   derivedDataProductApp: string | null,
 *   productExists: boolean,
 * }} params
 * @returns {{ overwrite: boolean, from?: string, to?: string, reason?: string }}
 */
export function planSignedAppDdOverwrite({
  platform,
  signedAppPath,
  derivedDataProductApp,
  productExists,
}) {
  if (platform !== "device") {
    return { overwrite: false, reason: "not a device run" };
  }
  if (!signedAppPath) {
    return { overwrite: false, reason: "no --app-path signed app given" };
  }
  if (!derivedDataProductApp) {
    return {
      overwrite: false,
      reason: "could not resolve the DerivedData build-product App.app",
    };
  }
  if (derivedDataProductApp === signedAppPath) {
    return {
      overwrite: false,
      reason: "signed app IS the DerivedData product — nothing to overwrite",
    };
  }
  if (!productExists) {
    return {
      overwrite: false,
      reason: `no build product at ${derivedDataProductApp} (run without --skip-build?)`,
    };
  }
  return {
    overwrite: true,
    from: signedAppPath,
    to: derivedDataProductApp,
  };
}

/**
 * Classify the result of a `codesign --verify` preflight over the runner app
 * and the (post-overwrite) DerivedData App.app. Pure: the caller passes each
 * check's boolean `signed` verdict; this returns whether to fail-fast and the
 * exact remediation text naming 0xe800801c so a device operator gets an
 * actionable error instead of the opaque devicectl install failure.
 *
 * @param {{
 *   checks: Array<{ label: string, path: string, signed: boolean }>,
 *   appPathProvided: boolean,
 * }} params
 * @returns {{ ok: boolean, unsigned: Array<{ label: string, path: string }>, message: string | null }}
 */
export function classifyCodesignPreflight({ checks, appPathProvided }) {
  const unsigned = checks
    .filter((check) => !check.signed)
    .map(({ label, path: p }) => ({ label, path: p }));
  if (unsigned.length === 0) {
    return { ok: true, unsigned: [], message: null };
  }
  const listed = unsigned
    .map(({ label, path: p }) => `  - ${label}: ${p}`)
    .join("\n");
  const remediation = appPathProvided
    ? "The signed app was grafted but a bundle is still unsigned. Re-stage the " +
      "signed app with `bun run ios:device:deploy` and pass it via --app-path."
    : "The DerivedData build product is unsigned. Stage a signed app with " +
      "`bun run ios:device:deploy` and re-run with " +
      "`--app-path <ios/build/device-deploy-stage/App.app>`.";
  return {
    ok: false,
    unsigned,
    message:
      "codesign preflight failed — installing this on a device would abort with " +
      '0xe800801c ("No code signature"). Unsigned bundle(s):\n' +
      `${listed}\n${remediation}`,
  };
}

/**
 * Collect every app bundle a parsed .xctestrun references (TestHostPath +
 * UITargetAppPath, both FormatVersion 1 and 2 layouts), resolving the
 * __TESTROOT__ placeholder against the xctestrun's directory. Used to
 * pre-install the bundles with `simctl install` before test-without-building —
 * launching while xcodebuild's own install transaction is still in flight gets
 * the fresh pid force-quit by FrontBoard (exit 0xfbfbfbfb).
 *
 * @param {Record<string, unknown>} xctestrun parsed plist root
 * @param {string} testRoot directory containing the .xctestrun file
 * @returns {string[]} absolute bundle paths, deduplicated, order-stable
 */
export function extractXctestrunAppPaths(xctestrun, testRoot) {
  const paths = [];
  const push = (value) => {
    if (typeof value === "string" && value.length > 0) {
      paths.push(value.replaceAll("__TESTROOT__", testRoot));
    }
  };
  // FormatVersion 2: TestConfigurations array at the ROOT of the plist.
  if (Array.isArray(xctestrun.TestConfigurations)) {
    for (const config of xctestrun.TestConfigurations) {
      for (const testTarget of config?.TestTargets ?? []) {
        push(testTarget?.TestHostPath);
        push(testTarget?.UITargetAppPath);
      }
    }
  }
  // FormatVersion 1: one dict per test target at the root.
  for (const [key, value] of Object.entries(xctestrun)) {
    if (key === "__xctestrun_metadata__" || key === "TestConfigurations")
      continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    push(value.TestHostPath);
    push(value.UITargetAppPath);
  }
  return [...new Set(paths)];
}

function numberFromSummaryValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === "object") {
    return numberFromSummaryValue(value._value ?? value.value ?? value.count);
  }
  return null;
}

function collectXcresultSummaryStats(value, stats = null) {
  const current = stats ?? {
    passed: null,
    failed: null,
    skipped: null,
    total: null,
    resultValues: [],
  };
  if (Array.isArray(value)) {
    for (const item of value) collectXcresultSummaryStats(item, current, "");
    return current;
  }
  if (!value || typeof value !== "object") return current;
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const lowerKey = rawKey.toLowerCase();
    if (
      (lowerKey === "result" || lowerKey.endsWith("result")) &&
      typeof rawValue === "string"
    ) {
      current.resultValues.push(rawValue.toLowerCase());
    }
    const numeric = numberFromSummaryValue(rawValue);
    if (numeric !== null) {
      if (/passedtests|passcount|passedcount|testspassed/.test(lowerKey)) {
        current.passed = Math.max(current.passed ?? 0, numeric);
      } else if (
        /failedtests|failurecount|failedcount|testsfailed/.test(lowerKey)
      ) {
        current.failed = Math.max(current.failed ?? 0, numeric);
      } else if (
        /skippedtests|skipcount|skippedcount|testsskipped/.test(lowerKey)
      ) {
        current.skipped = Math.max(current.skipped ?? 0, numeric);
      } else if (/testscount|testcount|totaltests|tests/.test(lowerKey)) {
        current.total = Math.max(current.total ?? 0, numeric);
      }
    }
    collectXcresultSummaryStats(rawValue, current);
  }
  return current;
}

/**
 * Classify `xcrun xcresulttool get test-results summary --path <bundle>` JSON
 * for health-gate purposes. Xcode has changed this payload shape across
 * versions, so this consumes both explicit count fields and recursive result
 * strings. The strict rule is intentionally small: an all-skipped run or a run
 * with an explicit zero passed-tests count is not a useful health signal.
 *
 * @param {unknown} summary parsed xcresulttool summary JSON
 * @returns {{ ok: boolean, reason: string | null, stats: { passed: number | null, failed: number | null, skipped: number | null, total: number | null, resultValues: string[] } }}
 */
export function classifyXcresultSummaryForGate(summary) {
  const stats = collectXcresultSummaryStats(summary);
  const hasPassedResult = stats.resultValues.includes("passed");
  const hasFailedResult = stats.resultValues.includes("failed");
  const hasSkippedResult = stats.resultValues.includes("skipped");
  if (stats.passed === 0) {
    return {
      ok: false,
      reason: "test-summary reports passedTests=0",
      stats,
    };
  }
  if (
    stats.skipped !== null &&
    stats.skipped > 0 &&
    (stats.passed ?? 0) === 0 &&
    (stats.failed ?? 0) === 0
  ) {
    return {
      ok: false,
      reason: "test-summary reports an all-skipped run",
      stats,
    };
  }
  if (hasSkippedResult && !hasPassedResult && !hasFailedResult) {
    return {
      ok: false,
      reason: "test-summary result is Skipped with no passed tests",
      stats,
    };
  }
  return { ok: true, reason: null, stats };
}

/**
 * Recursively replace the __TESTROOT__ placeholder in every string value of a
 * parsed .xctestrun. Required whenever the .xctestrun file is written
 * somewhere other than the Build/Products dir it was generated in — xcodebuild
 * resolves __TESTROOT__ against the .xctestrun file's OWN directory, so a
 * relocated file would point TestHostPath at the wrong place.
 *
 * @template T
 * @param {T} value parsed plist value (mutated in place for dicts/arrays)
 * @param {string} testRoot absolute Build/Products dir of the original file
 * @returns {T}
 */
export function resolveXctestrunTestRoot(value, testRoot) {
  if (typeof value === "string") {
    return value.replaceAll("__TESTROOT__", testRoot);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      value[i] = resolveXctestrunTestRoot(value[i], testRoot);
    }
    return value;
  }
  if (value && typeof value === "object" && !(value instanceof PlistData)) {
    if (value instanceof Date) return value;
    for (const key of Object.keys(value)) {
      value[key] = resolveXctestrunTestRoot(value[key], testRoot);
    }
    return value;
  }
  return value;
}

// ── Device / defaults resolution ────────────────────────────────────────

export const DEFAULT_APP_BUNDLE_ID = "ai.elizaos.app";

export const DEFAULT_IOS_XCUITEST_SHARDS = [
  "AppUITests/BootCaptureUITests/testBootReachesHomeOrErrorCard",
  "AppUITests/BootCaptureUITests/testComposerAcceptsTypedText",
  "AppUITests/BootCaptureUITests/testComposerSendsPromptAndWaitsForReply",
  "AppUITests/BootCaptureUITests/testCloudOnboardingChatAndVoice",
  "AppUITests/BootCaptureUITests/testLocalOnboardingChatAndVoice",
  "AppUITests/GestureSemanticsUITests",
  "AppUITests/LauncherGestureLoopUITests",
  "AppUITests/ViewWalkthroughUITests",
  "AppUITests/WidgetGalleryCaptureUITests",
  "AppUITests/DeviceExtensionSurfaceUITests",
  "AppUITests/DeviceLifecycleUITests",
];

export function safeShardName(identifier) {
  return String(identifier || "unknown")
    .replace(/^AppUITests\//, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

export function buildIosXcuitestShardPlan({
  onlyTesting = null,
  defaultShards = DEFAULT_IOS_XCUITEST_SHARDS,
} = {}) {
  const requested =
    typeof onlyTesting === "string" && onlyTesting.trim()
      ? onlyTesting.trim()
      : "AppUITests";
  const identifiers = requested === "AppUITests" ? defaultShards : [requested];
  return identifiers.map((identifier, index) => ({
    index: index + 1,
    identifier,
    resultName: `${String(index + 1).padStart(2, "0")}-${safeShardName(
      identifier,
    )}`,
  }));
}

export function extractSwiftXcuitestEntries(sources) {
  const entries = [];
  for (const source of sources ?? []) {
    const text = source?.text;
    if (typeof text !== "string") continue;
    const classMatch = text.match(
      /\b(?:final\s+)?class\s+(\w+)\s*:\s*XCTestCase\b/,
    );
    if (!classMatch) continue;
    const className = classMatch[1];
    const methods = [...text.matchAll(/\bfunc\s+(test\w+)\s*\(/g)].map(
      (match) => match[1],
    );
    entries.push({
      className,
      methods,
      path: typeof source.path === "string" ? source.path : null,
    });
  }
  return entries;
}

export function findUncoveredIosXcuitestEntries({ entries, shards }) {
  const shardSet = new Set(shards ?? []);
  const uncovered = [];
  for (const entry of entries ?? []) {
    if (!entry?.className) continue;
    const classShard = `AppUITests/${entry.className}`;
    if (shardSet.has(classShard)) continue;
    for (const method of entry.methods ?? []) {
      const methodShard = `${classShard}/${method}`;
      if (!shardSet.has(methodShard)) uncovered.push(methodShard);
    }
  }
  return uncovered;
}

export function isBenignIosAppAbsence(output) {
  // simctl reports an absent app differently per verb: uninstall/get-container
  // say "not installed"/"could not find", while `terminate` against an app that
  // is not currently running exits non-zero with "found nothing to terminate".
  // For a fresh-container reset all of these mean the same benign thing — there
  // was nothing to clean up — so the reset must not treat them as failures.
  return /not installed|not found|no such app|unknown application|does not exist|could not find|found nothing to terminate|no matching processes|not currently running/i.test(
    String(output ?? ""),
  );
}

/**
 * Boot-trace files inside the app data container, pulled by
 * `ios-device-logs.mjs --pull-boot-trace`.
 *
 * COUPLING (leg D1): mirrors the native sink in
 * packages/app-core/platforms/ios/App/App/ElizaStartupTrace.swift
 * (`traceFileName` / `rotatedTraceFileName`) — the native side appends JSONL
 * to Documents/eliza-boot-trace.jsonl and rotates one generation to
 * eliza-boot-trace.prev.jsonl. The renderer appends into the SAME primary
 * file through the Agent plugin's `appendBootTrace` bridge (single-writer
 * queue), so there is no separate renderer stream. Keep these names in sync
 * with that Swift file. ELIZA_IOS_BOOT_TRACE_PATH is a PULL-SIDE override
 * consumed only by ios-device-logs.mjs (native code does not read it).
 */
export const DEFAULT_BOOT_TRACE_CONTAINER_PATH =
  "Documents/eliza-boot-trace.jsonl";
export const BOOT_TRACE_SIBLING_CONTAINER_PATHS = [
  "Documents/eliza-boot-trace.prev.jsonl",
];

/**
 * Resolve the devicectl device identifier: --device flag beats
 * ELIZA_IOS_DEVICE_ID. Returns null when neither is provided.
 *
 * @param {{ flagValue?: string | null, env?: Record<string, string | undefined> }} options
 */
export function resolveDeviceId({ flagValue = null, env = process.env } = {}) {
  const fromFlag = flagValue?.trim();
  if (fromFlag) return fromFlag;
  const fromEnv = env.ELIZA_IOS_DEVICE_ID?.trim();
  return fromEnv || null;
}

/**
 * Pick the hardware UDID for a devicectl device out of
 * `devicectl list devices --json-output` payload, matching either the
 * devicectl identifier (UUID form) or the hardware UDID itself.
 *
 * @param {{ result?: { devices?: Array<Record<string, any>> } }} payload
 * @param {string} deviceId
 * @returns {{ identifier: string, udid: string, name: string } | null}
 */
export function findDeviceRecord(payload, deviceId) {
  const devices = payload?.result?.devices ?? [];
  const wanted = deviceId.toLowerCase();
  for (const device of devices) {
    const identifier = String(device?.identifier ?? "");
    const udid = String(device?.hardwareProperties?.udid ?? "");
    const name = String(device?.deviceProperties?.name ?? "");
    if (
      identifier.toLowerCase() === wanted ||
      udid.toLowerCase() === wanted ||
      (name && name.toLowerCase() === wanted)
    ) {
      return { identifier, udid, name };
    }
  }
  return null;
}

/**
 * Normalize the shape emitted by `devicectl device info lockState`.
 * The useful fields have appeared both at top level and under result payloads
 * across Xcode toolchains, so consume either without guessing at unknown data.
 *
 * @param {Record<string, unknown>} payload
 * @returns {{ passcodeRequired: boolean | null, unlockedSinceBoot: boolean | null, locked: boolean, reason: string | null }}
 */
export function normalizeDeviceLockState(payload) {
  const candidate =
    payload?.result?.lockState && typeof payload.result.lockState === "object"
      ? payload.result.lockState
      : payload?.result && typeof payload.result === "object"
        ? payload.result
        : payload;
  const passcodeRequired =
    typeof candidate?.passcodeRequired === "boolean"
      ? candidate.passcodeRequired
      : null;
  const unlockedSinceBoot =
    typeof candidate?.unlockedSinceBoot === "boolean"
      ? candidate.unlockedSinceBoot
      : null;
  if (passcodeRequired === true) {
    return {
      passcodeRequired,
      unlockedSinceBoot,
      locked: true,
      reason: "passcode required",
    };
  }
  if (unlockedSinceBoot === false) {
    return {
      passcodeRequired,
      unlockedSinceBoot,
      locked: true,
      reason: "not unlocked since boot",
    };
  }
  return {
    passcodeRequired,
    unlockedSinceBoot,
    locked: false,
    reason: null,
  };
}

export function formatDeviceUnlockWaitMessage({
  device,
  timeoutSeconds,
  reason,
}) {
  const name = device?.name || "iOS device";
  const identifier = device?.identifier || "unknown identifier";
  const suffix = reason ? ` (${reason})` : "";
  return `${name} (${identifier}) is locked${suffix}; unlock the phone and keep it awake. Waiting up to ${timeoutSeconds}s.`;
}

/**
 * Wait until a physical iOS device is unlocked.
 *
 * The impure edges are injected so the polling behavior stays unit-testable.
 *
 * @param {{
 *   device: { identifier: string, name?: string },
 *   probeLockState: () => Record<string, unknown> | Promise<Record<string, unknown>>,
 *   sleep: (ms: number) => Promise<void>,
 *   notify?: (message: string) => void,
 *   waitSeconds?: number,
 *   pollIntervalSeconds?: number,
 *   now?: () => number,
 * }} options
 * @returns {Promise<ReturnType<typeof normalizeDeviceLockState>>}
 */
export async function assertDeviceUnlocked({
  device,
  probeLockState,
  sleep,
  notify = () => {},
  waitSeconds = 120,
  pollIntervalSeconds = 5,
  now = Date.now,
}) {
  const timeoutMs = Math.max(0, Number(waitSeconds) || 0) * 1000;
  const pollMs = Math.max(1, Number(pollIntervalSeconds) || 1) * 1000;
  const deadline = now() + timeoutMs;
  let notified = false;
  let lastState = null;

  while (true) {
    lastState = normalizeDeviceLockState(await probeLockState());
    if (!lastState.locked) return lastState;
    if (!notified) {
      notify(
        formatDeviceUnlockWaitMessage({
          device,
          timeoutSeconds: Math.ceil(timeoutMs / 1000),
          reason: lastState.reason,
        }),
      );
      notified = true;
    }
    if (now() >= deadline) {
      throw new Error(
        `${formatDeviceUnlockWaitMessage({
          device,
          timeoutSeconds: Math.ceil(timeoutMs / 1000),
          reason: lastState.reason,
        })} Timed out before the device became usable.`,
      );
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}

/**
 * Minimal CLI arg parser for these scripts: `--flag value`, `--flag=value`,
 * and boolean `--flag`. Unknown positionals are returned under `_`.
 *
 * @param {string[]} argv
 * @param {{ booleans?: string[] }} options
 */
export function parseCliArgs(argv, { booleans = [] } = {}) {
  const args = { _: [] };
  const booleanSet = new Set(booleans);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const name = token.slice(2);
    if (
      booleanSet.has(name) ||
      i + 1 >= argv.length ||
      argv[i + 1].startsWith("--")
    ) {
      args[name] = true;
    } else {
      args[name] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

// ── XCUITest failed-test parsing + retry-in-isolation (#13566) ──────────

/**
 * Parse the failed-test identifiers out of a captured
 * `xcrun xcresulttool get test-results summary --format json` payload.
 *
 * Xcode 16's summary emits a `testFailures` array whose rows carry a
 * `testIdentifierString` ("Class/testMethod()" form) plus `testName` and
 * `targetName`. Older/alternate captures nest the same data under
 * `topInsights` or a bare `failures` array; we accept any of them and dedupe.
 * The `-only-testing` argument xcodebuild wants is `Target/Class/method` —
 * `testIdentifierString` omits the target and keeps the `()` suffix on the
 * method, so we normalize: drop a trailing `()`, and prefix the target
 * (from the row's `targetName`, else the caller-supplied `fallbackTarget`).
 *
 * Pure — the caller reads the file and passes the parsed object (or the raw
 * JSON string). A non-object / unparseable input yields an empty list rather
 * than throwing, so a malformed summary degrades to "no isolable failures"
 * and the harness keeps its normal nonzero-exit verdict (fail-closed: we
 * never fabricate a pass, we just can't offer retry-in-isolation).
 *
 * @param {unknown} summary parsed summary object OR raw JSON string
 * @param {{ fallbackTarget?: string }} [options]
 * @returns {Array<{ identifier: string, testName: string, targetName: string | null }>}
 */
export function parseFailedTestIdentifiers(
  summary,
  { fallbackTarget = "AppUITests" } = {},
) {
  let root = summary;
  if (typeof summary === "string") {
    try {
      root = JSON.parse(summary);
    } catch {
      return [];
    }
  }
  if (!root || typeof root !== "object") return [];

  const rows = [];
  const pushRows = (value) => {
    if (Array.isArray(value)) {
      for (const row of value) {
        if (row && typeof row === "object") rows.push(row);
      }
    }
  };
  pushRows(root.testFailures);
  pushRows(root.failures);
  // topInsights on some captures nests { impact, category, testFailures: [...] }
  if (Array.isArray(root.topInsights)) {
    for (const insight of root.topInsights) {
      if (insight && typeof insight === "object")
        pushRows(insight.testFailures);
    }
  }

  const seen = new Set();
  const failures = [];
  for (const row of rows) {
    const targetName =
      typeof row.targetName === "string" && row.targetName.trim()
        ? row.targetName.trim()
        : null;
    const rawId =
      typeof row.testIdentifierString === "string" &&
      row.testIdentifierString.trim()
        ? row.testIdentifierString.trim()
        : typeof row.testIdentifier === "string" && row.testIdentifier.trim()
          ? row.testIdentifier.trim()
          : typeof row.testName === "string" && row.testName.trim()
            ? row.testName.trim()
            : null;
    if (!rawId) continue;
    const identifier = buildOnlyTestingIdentifier(rawId, {
      targetName: targetName ?? fallbackTarget,
    });
    if (!identifier || seen.has(identifier)) continue;
    seen.add(identifier);
    failures.push({
      identifier,
      testName:
        typeof row.testName === "string" && row.testName.trim()
          ? row.testName.trim()
          : rawId,
      targetName,
    });
  }
  return failures;
}

/**
 * Normalize an xcresult test identifier into the `Target/Class/method` form
 * that `xcodebuild -only-testing:` accepts. Handles:
 *   - trailing `()` on the method ("Class/testFoo()" → "Class/testFoo")
 *   - an already-target-prefixed id (kept as-is once the `()` is stripped)
 *   - a bare "Class/testFoo" (prefixed with `targetName`)
 *   - a bare "Class" (a whole-class failure — prefixed, no method)
 *
 * @param {string} rawId
 * @param {{ targetName: string }} options
 * @returns {string | null}
 */
export function buildOnlyTestingIdentifier(rawId, { targetName }) {
  if (typeof rawId !== "string") return null;
  const trimmed = rawId.trim().replace(/\(\)$/, "");
  if (!trimmed) return null;
  const segments = trimmed.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  // Already target-prefixed? A 3-segment id, or a 2-segment id whose head
  // equals the target, is taken verbatim; otherwise prefix the target.
  if (segments.length >= 3) return segments.join("/");
  if (segments[0] === targetName) return segments.join("/");
  return [targetName, ...segments].join("/");
}

/**
 * Fold per-test isolated-rerun outcomes into a three-way verdict list and an
 * overall exit decision, per #13566:
 *   - a test that FAILED in the full suite but PASSED in isolation → `flake`
 *   - a test that FAILED both → `fail`
 * (Tests that passed in the suite never enter this pass.) The run should exit
 * NONZERO iff at least one real `fail` remains; a run whose only failures were
 * flakes exits 0 with those tests recorded as `flake` for trend data.
 *
 * Pure — the caller runs each isolated `xcodebuild test-without-building` and
 * passes `{ identifier, isolatedPassed }`. An identifier missing from the
 * results map is treated conservatively as still-failing (`fail`) so a
 * skipped/crashed isolated rerun can never green-wash the suite.
 *
 * @param {Array<{ identifier: string, testName?: string }>} suiteFailures
 * @param {Array<{ identifier: string, isolatedPassed: boolean }>} isolatedResults
 * @returns {{
 *   verdicts: Array<{ identifier: string, testName: string, verdict: 'flake' | 'fail' }>,
 *   flakes: string[],
 *   realFailures: string[],
 *   exitNonZero: boolean,
 * }}
 */
export function classifyIsolatedReruns(suiteFailures, isolatedResults) {
  const isolatedById = new Map();
  for (const result of isolatedResults ?? []) {
    if (result && typeof result.identifier === "string") {
      isolatedById.set(result.identifier, result.isolatedPassed === true);
    }
  }
  const verdicts = [];
  const flakes = [];
  const realFailures = [];
  for (const failure of suiteFailures ?? []) {
    if (!failure || typeof failure.identifier !== "string") continue;
    const passedIsolated = isolatedById.get(failure.identifier) === true;
    const verdict = passedIsolated ? "flake" : "fail";
    verdicts.push({
      identifier: failure.identifier,
      testName: failure.testName ?? failure.identifier,
      verdict,
    });
    if (verdict === "flake") flakes.push(failure.identifier);
    else realFailures.push(failure.identifier);
  }
  return {
    verdicts,
    flakes,
    realFailures,
    exitNonZero: realFailures.length > 0,
  };
}

// ── --skip-build stale-runner guard (#13566) ────────────────────────────

/**
 * Decide whether a reused test runner (--skip-build) is stale relative to the
 * XCUITest Swift sources it was compiled from. A runner built BEFORE any
 * AppUITests source was last modified executes day-old tests and can
 * false-green a change to the very suite under test (#13566).
 *
 * Pure — the caller stats the `.xctestrun` and the AppUITests/*.swift sources
 * and passes their mtimes (ms). Returns a decision the script turns into a
 * fail-fast (naming the newest stale source + the rebuild command) unless the
 * operator passes an explicit override.
 *
 * Fail-closed: if the runner mtime is unknown (null) we report `stale` — a
 * skip-build run we cannot date is not trusted to be fresh. An empty source
 * list (no sources found) is NOT stale (nothing to be stale against), so a
 * repo layout change can't wedge the guard shut.
 *
 * @param {{
 *   runnerMtimeMs: number | null,
 *   sources: Array<{ path: string, mtimeMs: number }>,
 *   allowStale?: boolean,
 * }} params
 * @returns {{
 *   stale: boolean,
 *   overridden: boolean,
 *   newestSource: { path: string, mtimeMs: number } | null,
 *   deltaMs: number,
 * }}
 */
export function evaluateRunnerStaleness({
  runnerMtimeMs,
  sources,
  allowStale = false,
}) {
  const validSources = (sources ?? []).filter(
    (s) => s && typeof s.mtimeMs === "number" && Number.isFinite(s.mtimeMs),
  );
  let newestSource = null;
  for (const source of validSources) {
    if (!newestSource || source.mtimeMs > newestSource.mtimeMs) {
      newestSource = source;
    }
  }
  // No datable runner → cannot prove freshness → treat as stale (fail-closed).
  if (runnerMtimeMs === null || !Number.isFinite(runnerMtimeMs)) {
    return {
      stale: true,
      overridden: allowStale === true,
      newestSource,
      deltaMs: 0,
    };
  }
  // No sources to compare against → nothing can be stale.
  if (!newestSource) {
    return { stale: false, overridden: false, newestSource: null, deltaMs: 0 };
  }
  const stale = newestSource.mtimeMs > runnerMtimeMs;
  return {
    stale,
    overridden: stale && allowStale === true,
    newestSource,
    deltaMs: stale ? newestSource.mtimeMs - runnerMtimeMs : 0,
  };
}

// ── Console-capture exit classification (#11515) ────────────────────────

/**
 * Signatures of the #11515 SIGTRAP. An attached `devicectl … launch --console`
 * runs the target under a debug session (ptrace + exception ports). On the
 * full-Bun (no-JIT) engine-host build that debug session turns a benign
 * guard-page / breakpoint probe into a fatal EXC_BREAKPOINT the moment the
 * engine host loads — the app dies with **signal 5 (SIGTRAP)**. Icon-tap /
 * unattended launches are NOT under a debug session and boot healthily.
 * devicectl relays the target's termination reason into the console log
 * ("signal 5", "SIGTRAP", or an EXC_BREAKPOINT note). The " 5" alternative is
 * anchored with word boundaries so it never matches our own "signal 15" detach.
 */
export const CONSOLE_SIGTRAP_SIGNATURE =
  /EXC_BREAKPOINT|SIGTRAP|\bsignal\s+5\b|Trace\/BPT\s+trap/i;

/**
 * Classify how a bounded `devicectl … launch --console` capture ended. Pure —
 * the caller passes the console child's exit `code`/`signal`, whether OUR own
 * bounded timer requested the detach, and the captured console log text.
 *
 * Precedence matters: the #11515 SIGTRAP is checked FIRST, because devicectl
 * surfaces the target crash as a nonzero exit code (signal null) which would
 * otherwise be misreported as a generic "phone locked / not paired" early exit.
 *
 * @param {{ code?: number | null, signal?: string | null, detachRequested?: boolean, logText?: string }} params
 * @returns {{ kind: 'sigtrap-engine-host' | 'bounded-detach' | 'early-exit' | 'ok', fatal: boolean, message: string }}
 */
export function classifyConsoleExit({
  code = null,
  signal = null,
  detachRequested = false,
  logText = "",
} = {}) {
  if (signal === "SIGTRAP" || CONSOLE_SIGTRAP_SIGNATURE.test(logText)) {
    return {
      kind: "sigtrap-engine-host",
      fatal: false,
      message:
        "attached-console launch SIGTRAP'd at full-Bun engine-host load (#11515): " +
        "`devicectl … launch --console` runs the app under a debug session, which is " +
        "incompatible with the no-JIT Bun engine host — the app dies with signal 5 the " +
        "moment the engine loads. This is NOT an app bug: icon-tap / unattended launches " +
        "boot healthily. Use `--no-console --pull-boot-trace` for engine-start observability.",
    };
  }
  if (detachRequested || signal === "SIGTERM") {
    return {
      kind: "bounded-detach",
      fatal: false,
      message:
        "console mode ties the app lifetime to this process — the app was terminated " +
        "(signal 15) when the bounded capture detached; this is the expected end of a " +
        "bounded capture, not a crash.",
    };
  }
  if (code !== 0 && code !== null) {
    return {
      kind: "early-exit",
      fatal: true,
      message:
        `devicectl console exited early with code ${code}. Is the phone unlocked and ` +
        "paired? Console attach needs an unlocked, trusted device.",
    };
  }
  return {
    kind: "ok",
    fatal: false,
    message: "console capture completed cleanly.",
  };
}
