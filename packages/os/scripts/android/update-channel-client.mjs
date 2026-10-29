/**
 * Read-only update-channel client for an installed AOSP image.
 *
 * It reads one update manifest (as publish-update-manifest.ts writes it), verifies the
 * signed release contract embedded for the booted device against the reviewed trust
 * policy, and compares that release with the booted build fingerprint. It reports what
 * the channel offers; it never downloads an archive or payload, never follows an
 * artifact's downloadUrl, and never applies, stages or schedules an update. Applying a
 * release stays an operator step (aosp-ota-update.mjs, install-release.ts).
 *
 * The client is off unless a product turns it on: `enabled` defaults to
 * UPDATE_CHANNEL_CLIENT_ENABLED (false), and a disabled client fetches nothing.
 */
import { validateEnvelope } from "./release-contract.ts";

export const UPDATE_CHANNEL_CLIENT_ENABLED = false;
const CHANNELS = new Set(["canary", "beta", "stable"]);

/** `ro.build.fingerprint` split into its identity parts, or null when malformed. */
export function parseFingerprint(fingerprint) {
  const match =
    /^([^/\s]+)\/([^/\s]+)\/([^/:\s]+):([^/\s]+)\/([^/\s]+)\/([^/:\s]+):([^/\s]+)\/([^/\s]+)$/.exec(
      String(fingerprint ?? ""),
    );
  if (!match) return null;
  const [, brand, product, device, release, id, incremental, type, tags] =
    match;
  return { brand, product, device, release, id, incremental, type, tags };
}

/**
 * Judge one manifest against the booted build. Pure: `manifest` is already-parsed JSON and
 * `policy` the reviewed trust policy (validateEnvelope's second argument).
 */
export function evaluateUpdateChannel({
  manifest,
  channel,
  booted,
  policy,
  validate = validateEnvelope,
}) {
  const problems = [];
  const identity = parseFingerprint(booted?.fingerprint);
  if (!identity) problems.push("the booted build fingerprint is unreadable");
  if (!CHANNELS.has(channel)) problems.push(`unknown channel ${channel}`);
  if (manifest?.schemaVersion !== 2)
    problems.push("the manifest is not a schemaVersion 2 update manifest");
  else if (manifest.channel !== channel)
    problems.push(`the manifest is for ${manifest.channel}, not ${channel}`);
  if (problems.length) return { state: "refused", problems };
  const candidates = (manifest.artifacts ?? []).filter(
    (artifact) => artifact?.codename === identity.device,
  );
  if (candidates.length === 0)
    return {
      state: "refused",
      problems: [`the manifest has no release for ${identity.device}`],
    };
  if (candidates.length > 1)
    return {
      state: "refused",
      problems: [
        `the manifest lists ${candidates.length} releases for ${identity.device}`,
      ],
    };
  const [artifact] = candidates;
  let release;
  let subjectSha256;
  try {
    ({ release, subjectSha256 } = validate(artifact.contract, policy));
  } catch (error) {
    return {
      state: "refused",
      problems: [`the release contract does not verify: ${error.message}`],
    };
  }
  if (
    release.channel !== channel ||
    release.version !== manifest.version ||
    release.tag !== manifest.tag
  )
    problems.push(
      "the contract's release, channel or tag is not the manifest's",
    );
  if (
    artifact.subjectSha256 !== subjectSha256 ||
    artifact.sha256 !== release.archive?.sha256 ||
    artifact.filename !== release.archive?.filename ||
    artifact.target !== release.target?.id
  )
    problems.push("the manifest entry is not the signed contract's archive");
  const offered = parseFingerprint(release.buildFingerprint);
  if (
    !offered ||
    offered.brand !== identity.brand ||
    offered.product !== identity.product ||
    offered.device !== identity.device
  )
    problems.push(
      `the channel's release ${release.buildFingerprint} is not a build of the booted product ${identity.brand}/${identity.product}/${identity.device}`,
    );
  if (offered && offered.type !== identity.type)
    problems.push(
      `the channel's release is a ${offered.type} build; the booted build is ${identity.type}`,
    );
  if (problems.length) return { state: "refused", problems };
  const summary = {
    releaseId: release.releaseId,
    version: release.version,
    tag: release.tag,
    buildFingerprint: release.buildFingerprint,
    archive: {
      filename: release.archive.filename,
      sha256: release.archive.sha256,
    },
    subjectSha256,
  };
  return {
    state:
      release.buildFingerprint === booted.fingerprint ? "current" : "available",
    release: summary,
    problems: [],
    downloaded: false,
    applied: false,
  };
}

/**
 * A client bound to one channel. `fetchManifest()` returns the manifest JSON (text or
 * parsed); it is the only I/O the client performs and it is never called while disabled.
 * `readBootedFingerprint()` returns the running image's ro.build.fingerprint.
 */
export function createUpdateChannelClient({
  enabled = UPDATE_CHANNEL_CLIENT_ENABLED,
  channel,
  fetchManifest,
  readBootedFingerprint,
  policy,
  validate = validateEnvelope,
}) {
  return Object.freeze({
    enabled: enabled === true,
    async check() {
      if (enabled !== true)
        return {
          state: "disabled",
          problems: [],
          downloaded: false,
          applied: false,
        };
      let manifest;
      try {
        const body = await fetchManifest();
        manifest = typeof body === "string" ? JSON.parse(body) : body;
      } catch (error) {
        return {
          state: "unavailable",
          problems: [`the update manifest could not be read: ${error.message}`],
          downloaded: false,
          applied: false,
        };
      }
      const booted = { fingerprint: await readBootedFingerprint() };
      return {
        downloaded: false,
        applied: false,
        ...evaluateUpdateChannel({
          manifest,
          channel,
          booted,
          policy,
          validate,
        }),
      };
    },
  });
}
