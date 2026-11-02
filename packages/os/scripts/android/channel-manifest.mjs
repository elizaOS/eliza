#!/usr/bin/env node
/**
 * Write one update channel manifest for A/B OS updates: the one format the on-device updater
 * (android/updater, ChannelManifest.java) reads.
 *
 *   node packages/os/scripts/android/channel-manifest.mjs --channel stable|beta --version VERSION \
 *     --sequence N --base-url URL --out NEW_FILE [--rollout-percent 0-100] FULL_OTA.zip [INCREMENTAL_OTA.zip ...]
 *
 * It reads each ota_from_target_files package and records what an update_engine client needs to
 * stream it: the URL (base URL plus the file name), the payload.bin offset and size inside the zip
 * (ota-streaming-property-files in META-INF/com/android/metadata, checked against the payload
 * magic and payload_properties.txt FILE_SIZE), the four payload_properties.txt lines passed as
 * update_engine headers, and the zip's SHA-256 and size. Every package must update to the same
 * build; exactly one is full and each incremental starts from a different build. Any URL must be
 * HTTPS, except a loopback http URL for adb reverse. An incremental cannot start from an `eng.`
 * build: those fingerprints repeat across builds, so a device cannot tell which build it runs.
 * rolloutPercent 0 halts the channel (kill switch). sequence orders the channel's signed manifests:
 * the updater keeps the highest it has accepted and refuses any lower one, so a replayed earlier
 * manifest cannot undo a later halt.
 *
 * The manifest is written unsigned; signing it (a detached Ed25519 signature over the exact bytes,
 * published beside it as <url>.sig) is the release owner's offline step. Nothing is uploaded, signed
 * or applied here.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  entries,
  entry,
  fileSha256,
  parseProperties,
} from "./aosp-release-record.mjs";

export const CHANNELS = Object.freeze(["stable", "beta"]);
/** payload_properties.txt keys, in the order update_engine headers carry them. */
const PAYLOAD_PROPERTIES = Object.freeze([
  "FILE_HASH",
  "FILE_SIZE",
  "METADATA_HASH",
  "METADATA_SIZE",
]);
const METADATA = "META-INF/com/android/metadata";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const ENG_BUILD = /\/eng\.[^/:]*:[^/]*\/[^/]*$/;

/** True when the four bytes at `offset` are the update_engine payload magic. */
function payloadAt(file, offset) {
  const fd = fs.openSync(file, "r");
  try {
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, offset);
    return magic.toString("latin1") === "CrAU";
  } finally {
    fs.closeSync(fd);
  }
}

/** One package's build identity and update entry; its problems name the file. */
async function describe(file, baseUrl) {
  const name = path.basename(file);
  const names = new Set(entries(file));
  const missing = [METADATA, "payload.bin", "payload_properties.txt"].filter(
    (required) => !names.has(required),
  );
  if (missing.length)
    return {
      problems: missing.map((required) => `${name}: ${required} is missing`),
    };
  const metadata = parseProperties(entry(file, METADATA).toString("utf8"));
  const properties = parseProperties(
    entry(file, "payload_properties.txt").toString("utf8"),
  );
  const sizeBytes = fs.statSync(file).size;
  const range = /(?:^|,)payload\.bin:(\d+):(\d+)(?:,|$)/.exec(
    metadata["ota-streaming-property-files"] ?? "",
  );
  const [offset, size] = range ? [Number(range[1]), Number(range[2])] : [];
  const problems = [
    ...(metadata["ota-type"] === "AB" ? [] : [`${name}: not an A/B package`]),
    ...["post-build", "post-timestamp", "pre-device"]
      .filter((key) => !metadata[key])
      .map((key) => `${name}: the metadata has no ${key}`),
    ...PAYLOAD_PROPERTIES.filter((key) => !properties[key]).map(
      (key) => `${name}: payload_properties.txt has no ${key}`,
    ),
  ];
  if (!range)
    problems.push(`${name}: the metadata has no payload.bin streaming range`);
  else if (offset + size > sizeBytes || !payloadAt(file, offset))
    problems.push(`${name}: payload.bin is not at its recorded offset`);
  else if (String(size) !== properties.FILE_SIZE)
    problems.push(
      `${name}: payload_properties.txt FILE_SIZE is not the payload.bin size`,
    );
  if (problems.length) return { problems };
  return {
    problems,
    build: {
      fingerprint: metadata["post-build"],
      dateUtc: Number(metadata["post-timestamp"]),
      device: metadata["pre-device"],
      securityPatch: metadata["post-security-patch-level"] ?? null,
    },
    update: {
      from: metadata["pre-build"] ?? null,
      url: new URL(encodeURIComponent(name), baseUrl).href,
      sha256: await fileSha256(file),
      sizeBytes,
      payload: {
        offset,
        size,
        properties: PAYLOAD_PROPERTIES.map(
          (key) => `${key}=${properties[key]}`,
        ),
      },
    },
  };
}

/** The channel manifest for `otas`; throws with every problem found. */
export async function channelManifest({
  channel,
  version,
  sequence,
  baseUrl,
  rolloutPercent = 100,
  otas,
}) {
  const problems = [];
  if (!CHANNELS.includes(channel))
    problems.push(`channel must be one of ${CHANNELS.join(", ")}`);
  if (!VERSION.test(version ?? ""))
    problems.push(
      "version must be a plain token such as 0.1.0 or lab-20261102",
    );
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    problems.push("sequence must be a positive integer");
  if (
    !Number.isInteger(rolloutPercent) ||
    rolloutPercent < 0 ||
    rolloutPercent > 100
  )
    problems.push("rollout percent must be an integer from 0 to 100");
  if (!otas?.length) problems.push("at least one OTA package is required");
  const base = URL.canParse(baseUrl)
    ? new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`)
    : null;
  const loopback = base?.protocol === "http:" && LOOPBACK.has(base.hostname);
  if (!base || (base.protocol !== "https:" && !loopback))
    problems.push(
      "the base URL must be https, or http on a loopback address for adb reverse",
    );
  else if (base.username || base.password || base.search || base.hash)
    problems.push(
      "the base URL must not carry credentials, a query or a fragment",
    );
  if (problems.length) throw new Error(problems.join("\n"));

  const described = [];
  for (const file of otas) described.push(await describe(file, base));
  problems.push(...described.flatMap((item) => item.problems));
  if (problems.length) throw new Error(problems.join("\n"));
  const [{ build }] = described;
  if (
    described.some(
      (item) => JSON.stringify(item.build) !== JSON.stringify(build),
    )
  )
    problems.push("every package must update to the same build");
  const updates = described
    .map((item) => item.update)
    .sort((a, b) => (a.from ?? "").localeCompare(b.from ?? ""));
  if (updates.filter((update) => update.from === null).length !== 1)
    problems.push("exactly one package must be a full OTA");
  const sources = updates.map((update) => update.from).filter(Boolean);
  if (new Set(sources).size !== sources.length)
    problems.push("two incremental packages start from the same build");
  if (sources.includes(build.fingerprint))
    problems.push("an incremental package starts from the build it updates to");
  if (sources.some((source) => ENG_BUILD.test(source)))
    problems.push(
      "an incremental package starts from an eng. build, whose fingerprint repeats across builds",
    );
  if (problems.length) throw new Error(problems.join("\n"));
  return {
    schema: 1,
    channel,
    device: build.device,
    version,
    sequence,
    buildFingerprint: build.fingerprint,
    buildDateUtc: build.dateUtc,
    securityPatch: build.securityPatch,
    rolloutPercent,
    updates,
  };
}

const USAGE =
  "Usage: node packages/os/scripts/android/channel-manifest.mjs --channel stable|beta --version VERSION --sequence N --base-url URL --out NEW_FILE [--rollout-percent N] FULL_OTA.zip [INCREMENTAL_OTA.zip ...]";

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      channel: { type: "string" },
      version: { type: "string" },
      sequence: { type: "string" },
      "base-url": { type: "string" },
      out: { type: "string" },
      "rollout-percent": { type: "string", default: "100" },
    },
  });
  if (!values.out || !values["base-url"]) throw new Error(USAGE);
  const manifest = await channelManifest({
    channel: values.channel,
    version: values.version,
    sequence: /^\d+$/.test(values.sequence ?? "")
      ? Number(values.sequence)
      : NaN,
    baseUrl: values["base-url"],
    rolloutPercent: /^\d+$/.test(values["rollout-percent"])
      ? Number(values["rollout-percent"])
      : NaN,
    otas: positionals,
  });
  fs.writeFileSync(values.out, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(values.out);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
