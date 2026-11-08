import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  fetchCloudflareInventory,
  fetchWorkerBindings,
  StateBackendInventoryError,
} from "./worker-state-backend-vars.mjs";

const API = "eliza-cloud-api-staging";
const TARGET = "eliza-cloud-speech-staging";
const CLASS = "SpeechRelayCoordinator";
const HEX32 = /^[0-9a-f]{32}$/;
const MAX_AGE_MS = 15 * 60 * 1000;
const fail = (code) => {
  throw new StateBackendInventoryError(`speech_cutover:${code}`);
};

function uniqueBinding(bindings, name) {
  const names = new Set();
  for (const binding of bindings) {
    if (!binding || typeof binding.name !== "string" || names.has(binding.name))
      fail("ambiguous_bindings");
    names.add(binding.name);
  }
  const binding = bindings.find((item) => item.name === name);
  if (!binding) fail("missing_binding");
  return binding;
}

// Read every page. A missing/inconsistent pagination receipt cannot establish
// that a matching namespace is unique, so it is an admission failure.
export async function fetchSpeechNamespaces(environment, fetchImpl = fetch) {
  const namespaces = [];
  const ids = new Set();
  let expectedPages;
  let expectedCount;
  for (let page = 1; page <= 100; page++) {
    const payload = await fetchCloudflareInventory(
      environment,
      `/workers/durable_objects/namespaces?page=${page}&per_page=1000`,
      fetchImpl,
    );
    const info = payload.result_info;
    if (
      !Array.isArray(payload.result) ||
      !info ||
      info.page !== page ||
      !Number.isInteger(info.total_pages) ||
      info.total_pages < 1 ||
      info.total_pages > 100 ||
      !Number.isInteger(info.total_count) ||
      info.total_count < 0 ||
      !Number.isInteger(info.per_page) ||
      info.per_page < 1 ||
      info.per_page > 1000 ||
      info.count !== payload.result.length ||
      payload.result.length > info.per_page ||
      (expectedPages !== undefined && info.total_pages !== expectedPages) ||
      (expectedCount !== undefined && info.total_count !== expectedCount)
    )
      fail("incomplete_namespace_inventory");
    expectedPages = info.total_pages;
    expectedCount = info.total_count;
    for (const namespace of payload.result) {
      if (
        !namespace ||
        !HEX32.test(namespace.id ?? "") ||
        ids.has(namespace.id)
      )
        fail("ambiguous_namespace_inventory");
      ids.add(namespace.id);
      namespaces.push(namespace);
    }
    if (page === expectedPages) {
      if (namespaces.length !== expectedCount)
        fail("incomplete_namespace_inventory");
      return namespaces;
    }
  }
  fail("incomplete_namespace_inventory");
}

function namespaceFor(binding, localWorker, namespaces) {
  if (
    binding.type !== "durable_object_namespace" ||
    (binding.class_name !== undefined && binding.class_name !== CLASS) ||
    (binding.environment !== undefined && binding.environment !== "") ||
    binding.dispatch_namespace !== undefined
  )
    fail("unexpected_speech_binding");
  const worker = binding.script_name ?? localWorker;
  if (worker !== API && worker !== TARGET) fail("unexpected_speech_owner");
  const matches = namespaces.filter((item) =>
    binding.namespace_id !== undefined
      ? item.id === binding.namespace_id
      : item.script === worker && item.class === CLASS,
  );
  if (
    matches.length !== 1 ||
    ![API, TARGET].includes(matches[0].script) ||
    (binding.script_name !== undefined &&
      matches[0].script !== binding.script_name) ||
    (binding.namespace_id === undefined && matches[0].script !== worker) ||
    matches[0].class !== CLASS
  )
    fail("ambiguous_speech_namespace");
  return matches[0];
}

function assertAttestation(raw, identity, now) {
  let value;
  try {
    value = JSON.parse(raw ?? "");
  } catch {
    fail("missing_or_invalid_attestation");
  }
  const keys = [
    "version",
    "sourceSha",
    "fromWorker",
    "fromNamespaceId",
    "toWorker",
    "toNamespaceId",
    "issuedAt",
    "expiresAt",
    "legacySessionsDrained",
    "legacyAdmissionHeld",
    "evidence",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys.sort().join(",") ||
    value.version !== 1 ||
    value.legacySessionsDrained !== true ||
    value.legacyAdmissionHeld !== true ||
    typeof value.evidence !== "string" ||
    value.evidence.trim().length < 1 ||
    value.evidence.length > 1000 ||
    Object.entries(identity).some(([key, expected]) => value[key] !== expected)
  )
    fail("attestation_identity_or_claim_invalid");
  // Canonical UTC timestamps avoid permissive Date parsing and timezone ambiguity.
  const timestamp = (input) =>
    typeof input === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)
      ? Date.parse(input)
      : NaN;
  const issued = timestamp(value.issuedAt);
  const expires = timestamp(value.expiresAt);
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    new Date(issued).toISOString() !== value.issuedAt ||
    new Date(expires).toISOString() !== value.expiresAt ||
    issued > now ||
    expires <= now ||
    expires <= issued ||
    expires - issued > MAX_AGE_MS
  )
    fail("attestation_expired_or_invalid");
}

/** Read-only release admission. Human truth is trusted, never measured here. */
export async function admitSpeechHostCutover(
  environment,
  fetchImpl = fetch,
  clock = Date.now,
) {
  if (
    environment.DEPLOY_ENVIRONMENT !== "staging" ||
    !/^[0-9a-f]{40}$/.test(environment.GITHUB_SHA ?? "")
  )
    fail("invalid_release_identity");
  const apiBindings = await fetchWorkerBindings(environment, API, fetchImpl);
  let targetBindings;
  try {
    targetBindings = await fetchWorkerBindings(environment, TARGET, fetchImpl);
  } catch (error) {
    throw new StateBackendInventoryError(
      "speech_cutover:target_host_unavailable; complete host-only provisioning before first activation",
      error instanceof StateBackendInventoryError
        ? error.message
        : "read failed",
    );
  }
  const namespaces = await fetchSpeechNamespaces(environment, fetchImpl);
  const current = namespaceFor(
    uniqueBinding(apiBindings, "SPEECH_RELAY_SESSIONS"),
    API,
    namespaces,
  );
  const target = namespaceFor(
    uniqueBinding(targetBindings, "SPEECH_RELAY_SESSIONS"),
    TARGET,
    namespaces,
  );
  if (target.script !== TARGET) fail("unexpected_target_owner");
  const identity = {
    sourceSha: environment.GITHUB_SHA,
    fromWorker: current.script,
    fromNamespaceId: current.id,
    toWorker: target.script,
    toNamespaceId: target.id,
  };
  const alreadyActive = current.id === target.id;
  if (!alreadyActive) {
    if (current.script !== API) fail("unexpected_current_owner");
    const flag = uniqueBinding(apiBindings, "VOICE_SPEECH_RELAY_ENABLED");
    if (flag.type !== "plain_text" || flag.text !== "false")
      fail("legacy_admission_not_frozen");
    assertAttestation(
      environment.STAGING_SPEECH_CUTOVER_ATTESTATION,
      identity,
      clock(),
    );
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  if (
    environment.SPEECH_CUTOVER_EXPECTED_FINGERPRINT !== undefined &&
    environment.SPEECH_CUTOVER_EXPECTED_FINGERPRINT !== fingerprint
  )
    fail("cutover_identity_changed");
  return { fingerprint, alreadyActive };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  admitSpeechHostCutover(process.env)
    .then(({ fingerprint }) => {
      // Only a digest leaves this process. Never print the protected attestation.
      process.stdout.write(`${fingerprint}\n`);
    })
    .catch((error) => {
      console.error(
        `Speech host cutover admission failed: ${error instanceof StateBackendInventoryError ? error.message : "unexpected error"}; refusing deployment`,
      );
      process.exitCode = 1;
    });
}
