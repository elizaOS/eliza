/**
 * Shared judgement of an APK release record and of an in-place APK update.
 *
 * A product's APK verification (for example a `verify-apks` step) writes one row per APK into
 * an `apk-manifest.json`. `apkReleaseBlockers` reads a release row back and names every reason it
 * may not be distributed, so a gate that refuses it (image staging, pilot provisioning and
 * update, head qualification) can say why. It is stricter than the row's own `distributable`
 * flag: a row whose recorded facts contradict it is still blocked, and a fact that was never
 * recorded counts as unresolved. An empty list is the only admissible answer.
 *
 * Product policy is data:
 * - `admitSigner(row, releaseSigner)` recomputes signing admission against the product's
 *   committed release signer; `signerFile` names that file in messages.
 * - `licenceBlocks(item)` selects the recorded licence check items that block. By default none
 *   do: open-source licence flags (`licenceFlags`) are a record, never a blocker, and only a
 *   product's separately named licence check (for example an unresolved proprietary font) may
 *   be made blocking by its own policy.
 *
 * The update helpers compare an installed and a candidate APK (signer-equal, strictly higher
 * versionCode) and per-domain app-data readbacks before and after `adb install -r`.
 */

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * @param {Record<string, any>} row one `results[]` entry with mode "release"
 * @param {{
 *   manifestTestMocks?: unknown,
 *   admission?: {failures?: string[], blockers?: string[], signerMatches?: boolean},
 *   releaseSigner?: unknown,
 *   admitSigner?: (row: Record<string, any>, signer: unknown) => {failures?: string[], blockers?: string[], signerMatches?: boolean},
 *   signerFile?: string,
 *   image?: {platformCertificateSha256?: unknown},
 *   licenceBlocks?: (item: string) => boolean,
 * }} [options]
 * @returns {string[]}
 */
export function apkReleaseBlockers(
  row,
  {
    manifestTestMocks = false,
    admission = row?.releaseAdmission,
    releaseSigner,
    admitSigner,
    signerFile = "the product release signer",
    image,
    licenceBlocks = () => false,
  } = {},
) {
  const blockers = [];
  if (releaseSigner !== undefined) {
    if (typeof admitSigner !== "function")
      throw new Error("releaseSigner needs an admitSigner policy");
    try {
      admission = admitSigner(row, releaseSigner);
    } catch (error) {
      admission = {
        failures: [error.message],
        blockers: [],
        signerMatches: false,
      };
    }
  }
  if (
    image !== undefined &&
    !HEX64.test(image?.platformCertificateSha256 ?? "")
  )
    blockers.push(
      `image platform certificate is ${JSON.stringify(image?.platformCertificateSha256 ?? null)}, not a reviewed release certificate`,
    );
  if (manifestTestMocks !== false || row.testMocks !== false)
    blockers.push("test-mocks build");
  if (row.bundleAudit !== "passed")
    blockers.push("release did not pass the flag-off bundle audit");
  if (row.signed !== true) blockers.push("unsigned release");
  if (!admission) blockers.push("release signing admission was not recorded");
  else {
    blockers.push(...(admission.failures ?? []), ...(admission.blockers ?? []));
    if (
      row.signed === true &&
      admission.signerMatches !== true &&
      !(admission.failures?.length || admission.blockers?.length)
    )
      blockers.push(`release signer does not match ${signerFile}`);
  }
  if (row.runtime !== "PACKAGED")
    blockers.push(
      `unpackaged runtime (resident runtime ${row.runtime ?? "not recorded"})`,
    );
  else if (row.runtimeNotices !== true)
    blockers.push("notices lack the packaged runtime");
  // On-device voice is the only local speech route: a release without it has no local
  // speech. A packaged bundle must match its record byte for byte and the record must be
  // qualified (device acceptance); bytes never qualify it.
  const voice = row.voiceHost;
  if (
    !voice ||
    typeof voice !== "object" ||
    Array.isArray(voice) ||
    typeof voice.packaged !== "boolean"
  )
    blockers.push("on-device voice admission was not recorded");
  else if (!voice.packaged)
    blockers.push(
      "no on-device voice packaged (local speech would be unavailable)",
    );
  else {
    const missing = [
      (!Array.isArray(voice.differences) || voice.differences.length) &&
        "bytes differ from the voice-host record",
      voice.qualified !== true && "device qualification pending",
    ].filter(Boolean);
    if (missing.length)
      blockers.push(`unqualified on-device voice (${missing.join(", ")})`);
  }
  // The product's licence check must have been run and recorded; only the items its policy
  // names block. Open-source licence flags are never read here.
  if (!Array.isArray(row.licenceBlockers))
    blockers.push("font licence check was not recorded");
  else blockers.push(...row.licenceBlockers.map(String).filter(licenceBlocks));
  const named = [...new Set(blockers)];
  if (row.distributable !== true && !named.length)
    named.push("verify-apks did not record this release as distributable");
  return named;
}

/** An in-place update must keep the installed signer and raise the versionCode. */
export function apkUpdateAdmission({
  installedVersionCode,
  installedSigner,
  newVersionCode,
  newSigner,
}) {
  const problems = [];
  if (
    !Number.isInteger(installedVersionCode) ||
    !Number.isInteger(newVersionCode) ||
    newVersionCode <= installedVersionCode
  )
    problems.push(
      `new versionCode ${newVersionCode} must be greater than the installed ${installedVersionCode}`,
    );
  if (!installedSigner || installedSigner !== newSigner)
    problems.push(
      `new signer ${newSigner ?? "none"} differs from the installed ${installedSigner ?? "unknown"}`,
    );
  return problems;
}

/**
 * The device-shell walk of an app's data directory: every file's SHA-256 except caches and
 * code-cache (Android may clear them at any time). adb joins arguments into one device-shell
 * command line, so this is one single-quoted word whose patterns use double quotes, and it
 * ends with the walk's exit status so a failed walk never reads as an empty inventory.
 */
export const DOMAIN_SCRIPT =
  'find . -type f ! -path "./cache/*" ! -path "./code_cache/*" -exec sha256sum {} + ; echo "READBACK_EXIT=$?"';

/** Parse `sha256sum` lines into { domain: { file: digest } }. */
export function parseDomainInventory(output) {
  const domains = {};
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\.\/(\S.*)$/.exec(line.trim());
    if (!match) continue;
    const [, digest, file] = match;
    const domain = file.includes("/") ? file.slice(0, file.indexOf("/")) : ".";
    domains[domain] ??= {};
    domains[domain][file] = digest;
  }
  return domains;
}

/** Compare two domain inventories; returns sorted human-readable differences. */
export function compareDomains(before, after) {
  const problems = [];
  for (const domain of new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ])) {
    const a = before?.[domain] ?? {};
    const b = after?.[domain] ?? {};
    for (const file of Object.keys(a))
      if (!(file in b)) problems.push(`${file} was lost`);
      else if (a[file] !== b[file]) problems.push(`${file} changed`);
    for (const file of Object.keys(b))
      if (!(file in a)) problems.push(`${file} appeared`);
  }
  return problems.sort();
}

/** Parse one run-as readback; null when run-as is refused, throws when the walk failed. */
export function readbackInventory(output) {
  const text = String(output ?? "");
  if (
    /run-as: package not debuggable|is not debuggable|Package .* is unknown/.test(
      text,
    )
  )
    return null;
  const exit = /^READBACK_EXIT=(\d+)\s*$/m.exec(text)?.[1];
  if (exit !== "0")
    throw new Error(
      `App-data readback failed (exit ${exit ?? "missing"}): ${text.trim().split(/\r?\n/).slice(-3).join(" | ")}`,
    );
  return parseDomainInventory(text);
}

/** The `adb` arguments querying an app's integrity export for one nonce. */
export function integrityQuery(authority, nonce) {
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(authority ?? ""))
    throw new Error("Integrity authority must be a content-provider authority");
  if (!/^[0-9a-f]{32,128}$/.test(nonce ?? ""))
    throw new Error("Integrity nonce must be 32 to 128 hex characters");
  // The URI is single-quoted for the device shell ("?" must not glob).
  return [
    "shell",
    "content",
    "query",
    "--uri",
    `'content://${authority}/domains?nonce=${nonce}'`,
  ];
}

/**
 * Parse `content query` output of an app's integrity export into
 * { domain: { "domain/<path HMAC>": content HMAC } }. null when the installed build has no
 * export; throws on a refused, failed or truncated export.
 */
export function parseIntegrityExport(output) {
  const text = String(output ?? "");
  if (
    /Could not find provider|Unknown authority|No content provider found/i.test(
      text,
    )
  )
    return null;
  if (
    /Permission Denial|SecurityException|Exception|Error while accessing provider/.test(
      text,
    )
  )
    throw new Error(
      `Integrity export failed: ${text.trim().split(/\r?\n/).slice(0, 2).join(" | ")}`,
    );
  const domains = {};
  let rows = 0;
  let end = null;
  for (const line of text.split(/\r?\n/)) {
    const match =
      /^Row: \d+ domain=(.+?), key=([0-9a-f]{64}|\d+), digest=([0-9a-f]{64})$/.exec(
        line.trim(),
      );
    if (!match) continue;
    const [, domain, key, digest] = match;
    if (domain === "#end") {
      end = Number(key);
      continue;
    }
    if (!HEX64.test(key) || /[/,=]/.test(domain))
      throw new Error(`Malformed integrity export row: ${line.trim()}`);
    domains[domain] ??= {};
    domains[domain][`${domain}/${key}`] = digest;
    rows++;
  }
  if (end === null)
    throw new Error("Integrity export has no end row; the output is truncated");
  if (end !== rows)
    throw new Error(
      `Integrity export lists ${rows} files but its end row says ${end}`,
    );
  return domains;
}

/**
 * The failures of one in-place update, from package facts and readbacks taken before and
 * after `adb install -r`. An empty `before` inventory makes the byte-identical check vacuous
 * and is itself a failure; a null `before` means only package identity was read back.
 */
export function inPlaceUpdateFailures({
  apk,
  before,
  after,
  installedSha256,
  domainsBefore,
  domainsAfter,
}) {
  const failures = [];
  if (installedSha256 !== apk.sha256)
    failures.push("installed bytes differ from the admitted APK");
  if (after.versionCode !== apk.versionCode)
    failures.push(
      `installed versionCode ${after.versionCode} is not ${apk.versionCode}`,
    );
  if (after.userId !== before.userId)
    failures.push("package uid changed (data would be unreachable)");
  if (after.firstInstallTime !== before.firstInstallTime)
    failures.push(
      "first-install time changed (the update replaced the install)",
    );
  if (domainsBefore) {
    if (
      !Object.values(domainsBefore).some((files) => Object.keys(files).length)
    )
      failures.push(
        "no app data was found before the update; the readback proves nothing",
      );
    failures.push(...compareDomains(domainsBefore, domainsAfter ?? {}));
  }
  return failures;
}
