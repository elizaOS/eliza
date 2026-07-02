/**
 * Pure decision logic for the one-command iOS device automation scripts
 * (ios-device-deploy.mjs / ios-device-logs.mjs / ios-device-capture.mjs).
 *
 * Everything exported here is deterministic and side-effect free so it can be
 * unit-tested (see ios-device-lib.test.mjs, run by `bun run --cwd packages/app
 * test`, i.e. the root test:client lane). The scripts own the impure edges
 * (spawning `security` / `xcodebuild` / `devicectl`, reading files).
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
