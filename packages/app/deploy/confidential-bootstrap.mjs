/**
 * Authenticates launch variables before importing application code. The image
 * and measured command must fix this script, its configuration path and the
 * allowed environment mapping; this cannot repair an untrusted loader/image.
 * Uses only Node builtins so application dependencies cannot read secrets first.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

function exactObject(value, fields) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")
  )
    throw new Error("Invalid authorization shape");
  return value;
}
function envelope(value, key, domain) {
  exactObject(value, ["payload", "signature"]);
  if (typeof value.payload !== "string" || typeof value.signature !== "string")
    throw new Error("Invalid envelope");
  const bytes = Buffer.from(value.payload, "base64");
  const signature = Buffer.from(value.signature, "base64");
  if (
    bytes.toString("base64") !== value.payload ||
    signature.length !== 64 ||
    signature.toString("base64") !== value.signature ||
    !verify(null, Buffer.concat([Buffer.from(domain), bytes]), key, signature)
  )
    throw new Error("Authorization signature rejected");
  return { bytes, payload: JSON.parse(bytes.toString("utf8")) };
}

function utcTimestamp(value) {
  // Match the release writer's UTC ISO form without loading application dependencies.
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?Z$/.test(
      value,
    ) ||
    !value.endsWith("Z")
  )
    throw new Error("Invalid release timestamp");
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== value.slice(0, 10)
  ) {
    throw new Error("Invalid release calendar date");
  }
  return timestamp;
}

try {
  if (
    process.versions.node !== "24.15.0" ||
    process.argv.length !== 3 ||
    !isAbsolute(process.argv[2]) ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
  )
    throw new Error("Use the measured Node runtime and configuration");
  const config = exactObject(
    JSON.parse(await readFile(process.argv[2], "utf8")),
    ["entry", "publicKey", "environmentNames"],
  );
  if (
    typeof config.entry !== "string" ||
    !isAbsolute(config.entry) ||
    typeof config.publicKey !== "string" ||
    !Array.isArray(config.environmentNames) ||
    config.environmentNames.some(
      (name) =>
        typeof name !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        /^(ELIZA_TEE_|ELIZA_DSTACK_|NODE_|BUN_|LD_|DYLD_|PATH$|SSL_CERT_FILE$|SSL_CERT_DIR$|OPENSSL_)/.test(
          name,
        ),
    ) ||
    new Set(config.environmentNames).size !== config.environmentNames.length
  )
    throw new Error("Invalid measured launch configuration");
  const key = createPublicKey(config.publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Invalid authority");
  const release = envelope(
    JSON.parse(process.env.ELIZA_DSTACK_RELEASE_POLICY_JSON),
    key,
    "eliza-dstack-release-v1\0",
  );
  exactObject(release.payload, [
    "schemaVersion",
    "appId",
    "composeHash",
    "osImageHash",
    "variant",
    "notBefore",
    "expiresAt",
  ]);
  if (
    release.payload.schemaVersion !== 1 ||
    typeof release.payload.appId !== "string" ||
    release.payload.appId.length !== 40 ||
    typeof release.payload.composeHash !== "string" ||
    release.payload.composeHash.length !== 64 ||
    typeof release.payload.osImageHash !== "string" ||
    release.payload.osImageHash.length !== 64 ||
    typeof release.payload.variant !== "string" ||
    !/^[a-f0-9]{40}$/.test(release.payload.appId) ||
    !/^[a-f0-9]{64}$/.test(release.payload.composeHash) ||
    !/^[a-f0-9]{64}$/.test(release.payload.osImageHash) ||
    !["dstack-tdx", "dstack-nitro-enclave"].includes(release.payload.variant)
  )
    throw new Error("Invalid release identity");
  const before = utcTimestamp(release.payload.notBefore);
  const expires = utcTimestamp(release.payload.expiresAt);
  if (
    !Number.isFinite(before) ||
    !Number.isFinite(expires) ||
    before >= expires ||
    before > Date.now() ||
    expires <= Date.now()
  )
    throw new Error("Release authorization expired");
  const launch = envelope(
    JSON.parse(process.env.ELIZA_DSTACK_LAUNCH_AUTHORIZATION_JSON),
    key,
    "eliza-dstack-launch-v1\0",
  );
  exactObject(launch.payload, [
    "schemaVersion",
    "releasePayloadHash",
    "environmentHash",
  ]);
  const records = [
    ...config.environmentNames,
    "ELIZA_DSTACK_RELEASE_POLICY_JSON",
  ]
    .sort()
    .map((name) => {
      const value = process.env[name];
      if (typeof value !== "string")
        throw new Error("Missing authorized launch value");
      return { key: name, value };
    });
  if (
    launch.payload.schemaVersion !== 1 ||
    launch.payload.releasePayloadHash !==
      createHash("sha256").update(release.bytes).digest("hex") ||
    launch.payload.environmentHash !==
      createHash("sha256").update(JSON.stringify(records)).digest("hex")
  )
    throw new Error("Launch variables differ from authorization");
  // The application still performs independent hardware admission. This gate
  // authenticates configuration only; importing it is not proof of readiness.
  process.argv = [process.execPath, config.entry];
  await import(pathToFileURL(config.entry).href);
} catch {
  // error-policy:J1 Never expose launch values or dependency exceptions in startup output.
  process.stderr.write(
    "Confidential bootstrap rejected configuration or application startup.\n",
  );
  process.exitCode = 1;
}
