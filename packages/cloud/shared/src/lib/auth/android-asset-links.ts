/**
 * Digital Asset Links statement list for `/.well-known/assetlinks.json`.
 *
 * Android verifies an `autoVerify` App Link by fetching this document from the
 * link host. A verified link is what lets a native client receive its OAuth
 * redirect (for example `https://eliza.app/alphaphone/auth/callback`) without
 * any other app being able to claim it, which is why the redirect is an https
 * App Link rather than a custom scheme.
 *
 * The statements come from operator configuration, never from the request:
 * `ELIZA_ANDROID_ASSET_LINKS_JSON` is a JSON array of
 * `{ package_name, sha256_cert_fingerprints[], relations? }`. Any malformed
 * entry fails the WHOLE document closed to `[]`. Publishing a partial list
 * would silently drop an app's association, while publishing a mistyped
 * fingerprint is impossible to notice from the outside; an empty list makes
 * the misconfiguration visible as a verification failure on every device.
 */

export const ANDROID_ASSET_LINKS_ENV = "ELIZA_ANDROID_ASSET_LINKS_JSON";

export const ANDROID_ASSET_LINKS_RELATIONS = [
  "delegate_permission/common.handle_all_urls",
  "delegate_permission/common.get_login_creds",
] as const;

export type AndroidAssetLinksRelation = (typeof ANDROID_ASSET_LINKS_RELATIONS)[number];

export interface AndroidAssetLinkStatement {
  relation: AndroidAssetLinksRelation[];
  target: {
    namespace: "android_app";
    package_name: string;
    sha256_cert_fingerprints: string[];
  };
}

export type AndroidAssetLinksResult =
  | { ok: true; statements: AndroidAssetLinkStatement[] }
  | { ok: false; reason: AndroidAssetLinksConfigError };

export type AndroidAssetLinksConfigError =
  | "invalid_json"
  | "not_an_array"
  | "too_many_entries"
  | "too_large"
  | "invalid_entry"
  | "invalid_package_name"
  | "invalid_fingerprint"
  | "invalid_relation"
  | "duplicate_package";

const MAX_CONFIG_BYTES = 16_384;
const MAX_ENTRIES = 16;
const MAX_FINGERPRINTS_PER_APP = 8;
const ENTRY_KEYS = new Set(["package_name", "sha256_cert_fingerprints", "relations"]);
// Java package name: dot-separated segments, each starting with a letter.
const ANDROID_PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
// The exact form Android's verifier and `keytool -list` print: 32 uppercase
// colon-separated hex bytes.
const SHA256_FINGERPRINT_RE = /^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/;
const DEFAULT_RELATIONS: AndroidAssetLinksRelation[] = [
  "delegate_permission/common.handle_all_urls",
];

function isRelation(value: unknown): value is AndroidAssetLinksRelation {
  return (
    typeof value === "string" &&
    (ANDROID_ASSET_LINKS_RELATIONS as readonly string[]).includes(value)
  );
}

/** Parse and validate operator config. Absent or blank config is an empty list. */
export function parseAndroidAssetLinksConfig(raw: unknown): AndroidAssetLinksResult {
  if (raw === undefined || raw === null) return { ok: true, statements: [] };
  if (typeof raw !== "string") return { ok: false, reason: "invalid_json" };
  if (raw.trim() === "") return { ok: true, statements: [] };
  if (raw.length > MAX_CONFIG_BYTES) return { ok: false, reason: "too_large" };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // error-policy:J3 malformed operator config fails the document closed.
    return { ok: false, reason: "invalid_json" };
  }
  if (!Array.isArray(value)) return { ok: false, reason: "not_an_array" };
  if (value.length > MAX_ENTRIES) return { ok: false, reason: "too_many_entries" };

  const statements: AndroidAssetLinkStatement[] = [];
  const seenPackages = new Set<string>();
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).some((key) => !ENTRY_KEYS.has(key))
    ) {
      return { ok: false, reason: "invalid_entry" };
    }
    const record = entry as Record<string, unknown>;
    const packageName = record.package_name;
    if (
      typeof packageName !== "string" ||
      packageName.length > 255 ||
      !ANDROID_PACKAGE_RE.test(packageName)
    ) {
      return { ok: false, reason: "invalid_package_name" };
    }
    if (seenPackages.has(packageName)) return { ok: false, reason: "duplicate_package" };
    seenPackages.add(packageName);

    const fingerprints = record.sha256_cert_fingerprints;
    if (
      !Array.isArray(fingerprints) ||
      fingerprints.length === 0 ||
      fingerprints.length > MAX_FINGERPRINTS_PER_APP ||
      fingerprints.some(
        (fingerprint) =>
          typeof fingerprint !== "string" || !SHA256_FINGERPRINT_RE.test(fingerprint),
      ) ||
      new Set(fingerprints).size !== fingerprints.length
    ) {
      return { ok: false, reason: "invalid_fingerprint" };
    }

    let relations = DEFAULT_RELATIONS;
    if (record.relations !== undefined) {
      const rawRelations = record.relations;
      if (
        !Array.isArray(rawRelations) ||
        rawRelations.length === 0 ||
        !rawRelations.every(isRelation) ||
        new Set(rawRelations).size !== rawRelations.length
      ) {
        return { ok: false, reason: "invalid_relation" };
      }
      relations = rawRelations;
    }

    statements.push({
      relation: [...relations],
      target: {
        namespace: "android_app",
        package_name: packageName,
        sha256_cert_fingerprints: [...(fingerprints as string[])],
      },
    });
  }
  return { ok: true, statements };
}
