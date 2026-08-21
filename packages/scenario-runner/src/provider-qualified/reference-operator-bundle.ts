/**
 * Assembles the canonical provider-canary controller bridge from a protected,
 * data-only deployment inventory. Module evaluation is inert: configuration
 * and service credentials are read only when the authorization-first CLI calls
 * the exported factory after its signed manifest preflight.
 */

import { createHash, createPublicKey, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  PROVIDER_CANARY_SCENARIO_IDS,
  type ProviderCanaryScenarioId,
} from "./canary-catalog.ts";
import {
  createProviderControllerOrchestratorBridge,
  type DeployedProviderControllerClient,
  type IndependentProviderObserverClient,
  type IndependentSemanticJudgeClient,
  type ProviderControllerOrchestratorBridge,
  type RemoteProviderCleanupClient,
  type SignedProviderCleanupProof,
} from "./controller-orchestrator-bridge.ts";
import {
  type ProviderControllerFamily,
  providerCanaryControllerContract,
} from "./controller-registry.ts";
import type { ExternalProviderCapabilityFactoryInput } from "./external-canary-cli.ts";
import { canonicalJson, canonicalJsonValue } from "./manifest.ts";
import type { ProviderOperationKind } from "./operation-binding.ts";
import { providerObserverKeyId } from "./qualification.ts";
import {
  createProviderObserverSignerClient,
  createSemanticJudgeSignerClient,
  type RemoteEvidenceSignerPin,
  remoteEvidenceSignerIdentitySha256,
} from "./remote-evidence-signer-client.ts";

export const REFERENCE_OPERATOR_CONFIG_SCHEMA =
  "eliza.provider-canary-reference-operator-config.v1" as const;
export const REFERENCE_OPERATOR_SECRET_REQUEST_SCHEMA =
  "eliza.provider-canary-secret-request.v1" as const;
export const REFERENCE_OPERATOR_SECRET_RESPONSE_SCHEMA =
  "eliza.provider-canary-secret-response.v1" as const;
export const REFERENCE_OPERATOR_SERVICE_REQUEST_SCHEMA =
  "eliza.provider-canary-service-request.v1" as const;
export const REFERENCE_OPERATOR_SERVICE_RESPONSE_SCHEMA =
  "eliza.provider-canary-service-response.v1" as const;
export const REFERENCE_OPERATOR_CONFIG_ENV =
  "ELIZA_PROVIDER_OPERATOR_CONFIG_FILE" as const;
export const REFERENCE_OPERATOR_SECRET_TOKEN_ENV =
  "ELIZA_PROVIDER_OPERATOR_SECRET_BROKER_TOKEN" as const;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS = 30_000;

interface AuthenticatedServiceConfig {
  endpoint: string;
  administrativeDomain: string;
  bearerSecretRef: string;
}

interface EvidenceSignerConfig extends AuthenticatedServiceConfig {
  organizationId: string;
  publicKeyPem: string;
  keyId: string;
  serviceIdentitySha256: string;
}

interface CleanupServiceConfig extends AuthenticatedServiceConfig {
  publicKeyPem: string;
  keyId: string;
}

interface ScenarioDeploymentConfig {
  scenarioId: ProviderCanaryScenarioId;
  operationKind: ProviderOperationKind;
  controllerFamily: ProviderControllerFamily;
  controller: AuthenticatedServiceConfig;
  observer: EvidenceSignerConfig;
  semanticJudge: EvidenceSignerConfig;
  cleanup: CleanupServiceConfig;
  pinnedObserverPublicKeysPem: readonly [string, ...string[]];
  pinnedSemanticJudgePublicKeysPem: readonly [string, ...string[]];
}

export interface ReferenceOperatorConfig {
  schema: typeof REFERENCE_OPERATOR_CONFIG_SCHEMA;
  manifestAuthorityOrganizationId: string;
  secretBrokerEndpoint: string;
  deployments: Readonly<
    Record<ProviderCanaryScenarioId, ScenarioDeploymentConfig>
  >;
}

export interface ReferenceOperatorSecretResolver {
  resolve(input: {
    endpoint: string;
    secretRefs: readonly string[];
  }): Promise<Readonly<Record<string, string>>>;
}

export interface ReferenceOperatorFactoryDependencies {
  config?: unknown;
  configFile?: string;
  secretResolver?: ReferenceOperatorSecretResolver;
  fetchImpl?: typeof fetch;
}

interface ServiceRequest {
  schema: typeof REFERENCE_OPERATOR_SERVICE_REQUEST_SCHEMA;
  role: string;
  requestNonce: string;
  manifestSha256: string;
  runId: string;
  scenarioId: ProviderCanaryScenarioId;
  operationKind: ProviderOperationKind;
  payload: unknown;
}

interface ServiceResponse {
  schema: typeof REFERENCE_OPERATOR_SERVICE_RESPONSE_SCHEMA;
  role: string;
  requestNonce: string;
  requestSha256: string;
  result: unknown;
}

function fail(message: string): never {
  throw new Error(`reference provider operator refused: ${message}`);
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail(`${path} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor) || !descriptor.enumerable) {
      fail(`${path}.${key} must be an enumerable data property`);
    }
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (
    actual.length !== sorted.length ||
    actual.some((key, index) => key !== sorted[index])
  ) {
    fail(`${path} has an unsupported shape`);
  }
}

function assertDataTree(
  value: unknown,
  path: string,
  seen = new WeakSet<object>(),
): void {
  if (value === null || ["string", "number", "boolean"].includes(typeof value))
    return;
  if (typeof value !== "object") fail(`${path} must contain only JSON data`);
  if (seen.has(value)) fail(`${path} must not contain a cycle`);
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    const expected = new Set([
      "length",
      ...Array.from({ length: value.length }, (_, index) => String(index)),
    ]);
    if (Object.keys(descriptors).some((key) => !expected.has(key)))
      fail(`${path} array has unsupported properties`);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        fail(`${path}[${index}] must be an enumerable data property`);
      }
      assertDataTree(descriptor.value, `${path}[${index}]`, seen);
    }
    seen.delete(value);
    return;
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor) || !descriptor.enumerable)
      fail(`${path}.${key} must be an enumerable data property`);
    assertDataTree(descriptor.value, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function boundedString(value: unknown, path: string, max = 8_192): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    fail(`${path} must be a bounded non-empty string`);
  }
  return value;
}

function requireHash(value: unknown, path: string): string {
  const candidate = boundedString(value, path);
  if (!HASH_PATTERN.test(candidate)) fail(`${path} must be lowercase SHA-256`);
  return candidate;
}

function requireSecretRef(value: unknown, path: string): string {
  const candidate = boundedString(value, path, 256);
  if (!REF_PATTERN.test(candidate)) fail(`${path} is not a valid secret ref`);
  return candidate;
}

function httpsEndpoint(value: unknown, path: string): string {
  const candidate = boundedString(value, path, 2_048);
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return fail(`${path} must be an absolute HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname === "/"
  ) {
    fail(`${path} must be credential-free HTTPS with an explicit path`);
  }
  return url.href;
}

function ed25519PublicKey(value: unknown, path: string): string {
  const pem = boundedString(value, path, 16_384);
  if (pem.includes("PRIVATE KEY"))
    fail(`${path} contains private key material`);
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(pem);
  } catch {
    return fail(`${path} must be a valid public key`);
  }
  if (key.asymmetricKeyType !== "ed25519") fail(`${path} must be Ed25519`);
  return pem;
}

function endpointOrigin(endpoint: string): string {
  return new URL(endpoint).origin;
}

function serviceConfig(
  value: unknown,
  path: string,
): AuthenticatedServiceConfig {
  const record = plainRecord(value, path);
  exactKeys(
    record,
    ["endpoint", "administrativeDomain", "bearerSecretRef"],
    path,
  );
  return Object.freeze({
    endpoint: httpsEndpoint(record.endpoint, `${path}.endpoint`),
    administrativeDomain: boundedString(
      record.administrativeDomain,
      `${path}.administrativeDomain`,
      256,
    ),
    bearerSecretRef: requireSecretRef(
      record.bearerSecretRef,
      `${path}.bearerSecretRef`,
    ),
  });
}

function signerConfig(
  value: unknown,
  path: string,
  role: "observer" | "semantic-judge",
): EvidenceSignerConfig {
  const record = plainRecord(value, path);
  exactKeys(
    record,
    [
      "endpoint",
      "administrativeDomain",
      "bearerSecretRef",
      "organizationId",
      "publicKeyPem",
      "keyId",
      "serviceIdentitySha256",
    ],
    path,
  );
  const base = serviceConfig(
    {
      endpoint: record.endpoint,
      administrativeDomain: record.administrativeDomain,
      bearerSecretRef: record.bearerSecretRef,
    },
    path,
  );
  const publicKeyPem = ed25519PublicKey(
    record.publicKeyPem,
    `${path}.publicKeyPem`,
  );
  const config = Object.freeze({
    ...base,
    organizationId: boundedString(
      record.organizationId,
      `${path}.organizationId`,
      256,
    ),
    publicKeyPem,
    keyId: requireHash(record.keyId, `${path}.keyId`),
    serviceIdentitySha256: requireHash(
      record.serviceIdentitySha256,
      `${path}.serviceIdentitySha256`,
    ),
  });
  if (providerObserverKeyId(publicKeyPem) !== config.keyId)
    fail(`${path}.keyId does not match publicKeyPem`);
  const expected = remoteEvidenceSignerIdentitySha256({
    role,
    endpoint: config.endpoint,
    organizationId: config.organizationId,
    keyId: config.keyId,
  });
  if (config.serviceIdentitySha256 !== expected)
    fail(`${path} service identity does not match its exact endpoint`);
  return config;
}

function cleanupConfig(value: unknown, path: string): CleanupServiceConfig {
  const record = plainRecord(value, path);
  exactKeys(
    record,
    [
      "endpoint",
      "administrativeDomain",
      "bearerSecretRef",
      "publicKeyPem",
      "keyId",
    ],
    path,
  );
  const base = serviceConfig(
    {
      endpoint: record.endpoint,
      administrativeDomain: record.administrativeDomain,
      bearerSecretRef: record.bearerSecretRef,
    },
    path,
  );
  const publicKeyPem = ed25519PublicKey(
    record.publicKeyPem,
    `${path}.publicKeyPem`,
  );
  const keyId = requireHash(record.keyId, `${path}.keyId`);
  if (providerObserverKeyId(publicKeyPem) !== keyId)
    fail(`${path}.keyId does not match publicKeyPem`);
  return Object.freeze({
    ...base,
    publicKeyPem,
    keyId,
  });
}

function publicKeys(
  value: unknown,
  path: string,
): readonly [string, ...string[]] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    fail(`${path} must contain between one and sixteen public keys`);
  }
  const result = value.map((item, index) => {
    return ed25519PublicKey(item, `${path}[${index}]`);
  });
  return Object.freeze(result) as readonly [string, ...string[]];
}

function deploymentConfig(
  value: unknown,
  scenarioId: ProviderCanaryScenarioId,
  manifestAuthorityOrganizationId: string,
): ScenarioDeploymentConfig {
  const path = `config.deployments.${scenarioId}`;
  const record = plainRecord(value, path);
  exactKeys(
    record,
    [
      "scenarioId",
      "operationKind",
      "controllerFamily",
      "controller",
      "observer",
      "semanticJudge",
      "cleanup",
      "pinnedObserverPublicKeysPem",
      "pinnedSemanticJudgePublicKeysPem",
    ],
    path,
  );
  const contract = providerCanaryControllerContract(scenarioId);
  if (
    record.scenarioId !== scenarioId ||
    record.operationKind !== contract.operationKind ||
    record.controllerFamily !== contract.controllerFamily
  ) {
    fail(`${path} does not match the canonical controller registry`);
  }
  const controller = serviceConfig(record.controller, `${path}.controller`);
  const observer = signerConfig(
    record.observer,
    `${path}.observer`,
    "observer",
  );
  const semanticJudge = signerConfig(
    record.semanticJudge,
    `${path}.semanticJudge`,
    "semantic-judge",
  );
  const cleanup = cleanupConfig(record.cleanup, `${path}.cleanup`);
  if (
    cleanup.keyId !== observer.keyId ||
    cleanup.publicKeyPem !== observer.publicKeyPem
  ) {
    fail(
      `${path} cleanup proof key must be the authorized observer signer key`,
    );
  }
  if (observer.administrativeDomain !== observer.organizationId)
    fail(`${path} observer organization must own its administrative domain`);
  if (semanticJudge.administrativeDomain !== semanticJudge.organizationId)
    fail(
      `${path} semantic judge organization must own its administrative domain`,
    );
  const origins = [controller, observer, semanticJudge, cleanup].map(
    (service) => endpointOrigin(service.endpoint),
  );
  if (new Set(origins).size !== origins.length)
    fail(
      `${path} controller, observer, judge, and cleanup origins must be distinct`,
    );
  if (observer.keyId === semanticJudge.keyId)
    fail(`${path} observer and semantic judge signing keys must be distinct`);
  const domains = [
    controller.administrativeDomain,
    observer.administrativeDomain,
    semanticJudge.administrativeDomain,
    cleanup.administrativeDomain,
    manifestAuthorityOrganizationId,
  ];
  if (new Set(domains).size !== domains.length)
    fail(`${path} operational organizations must be administratively distinct`);
  const pinnedObserverPublicKeysPem = publicKeys(
    record.pinnedObserverPublicKeysPem,
    `${path}.pinnedObserverPublicKeysPem`,
  );
  const pinnedSemanticJudgePublicKeysPem = publicKeys(
    record.pinnedSemanticJudgePublicKeysPem,
    `${path}.pinnedSemanticJudgePublicKeysPem`,
  );
  if (
    !pinnedObserverPublicKeysPem.some(
      (key) => providerObserverKeyId(key) === observer.keyId,
    )
  ) {
    fail(`${path} observer signer is absent from observer trust pins`);
  }
  if (
    !pinnedSemanticJudgePublicKeysPem.some(
      (key) => providerObserverKeyId(key) === semanticJudge.keyId,
    )
  ) {
    fail(`${path} semantic judge signer is absent from judge trust pins`);
  }
  return Object.freeze({
    scenarioId,
    operationKind: contract.operationKind,
    controllerFamily: contract.controllerFamily,
    controller,
    observer,
    semanticJudge,
    cleanup,
    pinnedObserverPublicKeysPem,
    pinnedSemanticJudgePublicKeysPem,
  });
}

/** Validate the complete 13-scenario deployment inventory before any network call. */
export function parseReferenceOperatorConfig(
  value: unknown,
): ReferenceOperatorConfig {
  assertDataTree(value, "config");
  const snapshot = canonicalJsonValue(
    value,
    "referenceOperatorConfig",
  ) as unknown;
  const record = plainRecord(snapshot, "config");
  exactKeys(
    record,
    [
      "schema",
      "manifestAuthorityOrganizationId",
      "secretBrokerEndpoint",
      "deployments",
    ],
    "config",
  );
  if (record.schema !== REFERENCE_OPERATOR_CONFIG_SCHEMA)
    fail("config schema is unsupported");
  const deployments = plainRecord(record.deployments, "config.deployments");
  exactKeys(deployments, PROVIDER_CANARY_SCENARIO_IDS, "config.deployments");
  const manifestAuthorityOrganizationId = boundedString(
    record.manifestAuthorityOrganizationId,
    "config.manifestAuthorityOrganizationId",
    256,
  );
  const parsed = Object.fromEntries(
    PROVIDER_CANARY_SCENARIO_IDS.map((scenarioId) => [
      scenarioId,
      deploymentConfig(
        deployments[scenarioId],
        scenarioId,
        manifestAuthorityOrganizationId,
      ),
    ]),
  ) as Record<ProviderCanaryScenarioId, ScenarioDeploymentConfig>;
  return Object.freeze({
    schema: REFERENCE_OPERATOR_CONFIG_SCHEMA,
    manifestAuthorityOrganizationId,
    secretBrokerEndpoint: httpsEndpoint(
      record.secretBrokerEndpoint,
      "config.secretBrokerEndpoint",
    ),
    deployments: Object.freeze(parsed),
  });
}

function readProtectedConfig(file: string): unknown {
  if (file.length === 0) fail(`${REFERENCE_OPERATOR_CONFIG_ENV} is required`);
  if (!path.isAbsolute(file)) fail("config path must be absolute");
  let descriptor: number;
  try {
    descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    // error-policy:J1 Protected configuration open failures are secret-safe.
    return fail("config could not be opened without following links");
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) fail("config must be a regular file");
    if (typeof process.getuid === "function" && stats.uid !== process.getuid())
      fail("config must be owned by the current user");
    if ((stats.mode & 0o077) !== 0) fail("config permissions must be 0600");
    if (stats.size <= 0 || stats.size > MAX_CONFIG_BYTES)
      fail("config exceeds the bounded file size");
    const bytes = readFileSync(descriptor, "utf8");
    try {
      return JSON.parse(bytes);
    } catch {
      // error-policy:J3 Protected operator configuration is untrusted input.
      return fail("config is not valid JSON");
    }
  } finally {
    closeSync(descriptor);
  }
}

async function boundedJsonResponse(
  response: Response,
  label: string,
): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)
  )
    fail(`${label} response exceeds the byte limit`);
  if (!response.body) fail(`${label} returned an empty response`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      fail(`${label} response exceeds the byte limit`);
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    // error-policy:J3 Remote operator output is untrusted input.
    return fail(`${label} response is not valid bounded JSON`);
  }
}

async function authenticatedPost(input: {
  endpoint: string;
  bearerToken: string;
  body: unknown;
  fetchImpl: typeof fetch;
  label: string;
}): Promise<unknown> {
  if (/\r|\n/.test(input.bearerToken) || input.bearerToken.length > 8_192)
    fail(`${input.label} credential is invalid`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAX_TIMEOUT_MS);
  let response: Response;
  try {
    response = await input.fetchImpl(input.endpoint, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.bearerToken}`,
        "Content-Type": "application/json",
      },
      body: canonicalJson(
        canonicalJsonValue(input.body, `${input.label}Request`),
      ),
    });
  } catch {
    clearTimeout(timeout);
    // error-policy:J1 Credential-bearing transport emits a fixed refusal.
    return fail(`${input.label} request failed`);
  }
  try {
    if (response.status >= 300 && response.status < 400)
      fail(`${input.label} redirects are forbidden`);
    if (!response.ok) fail(`${input.label} returned HTTP ${response.status}`);
    if (
      response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    ) {
      fail(`${input.label} response must be application/json`);
    }
    return await boundedJsonResponse(response, input.label);
  } finally {
    clearTimeout(timeout);
  }
}

function defaultSecretResolver(
  fetchImpl: typeof fetch,
): ReferenceOperatorSecretResolver {
  return Object.freeze({
    async resolve({
      endpoint,
      secretRefs,
    }: {
      endpoint: string;
      secretRefs: readonly string[];
    }) {
      const accessToken = process.env[REFERENCE_OPERATOR_SECRET_TOKEN_ENV];
      if (!accessToken)
        fail(`${REFERENCE_OPERATOR_SECRET_TOKEN_ENV} is required`);
      const nonce = randomBytes(32).toString("base64url");
      const decoded = await authenticatedPost({
        endpoint,
        bearerToken: accessToken,
        fetchImpl,
        label: "secret broker",
        body: {
          schema: REFERENCE_OPERATOR_SECRET_REQUEST_SCHEMA,
          requestNonce: nonce,
          secretRefs,
        },
      });
      const response = plainRecord(decoded, "secretBrokerResponse");
      exactKeys(
        response,
        ["schema", "requestNonce", "values"],
        "secretBrokerResponse",
      );
      if (
        response.schema !== REFERENCE_OPERATOR_SECRET_RESPONSE_SCHEMA ||
        response.requestNonce !== nonce
      ) {
        fail("secret broker correlation failed");
      }
      const values = plainRecord(
        response.values,
        "secretBrokerResponse.values",
      );
      exactKeys(values, secretRefs, "secretBrokerResponse.values");
      const result: Record<string, string> = {};
      for (const ref of secretRefs) {
        const secret = boundedString(values[ref], `resolved secret ${ref}`);
        if (secret.includes("PRIVATE KEY"))
          fail("secret broker returned forbidden private signing material");
        result[ref] = secret;
      }
      return Object.freeze(result);
    },
  });
}

function validateFactoryInput(
  value: ExternalProviderCapabilityFactoryInput,
): ExternalProviderCapabilityFactoryInput & {
  scenarioId: ProviderCanaryScenarioId;
} {
  const record = plainRecord(value, "factoryInput");
  exactKeys(
    record,
    ["scenarioId", "operationKind", "runId", "manifestSha256"],
    "factoryInput",
  );
  const scenarioId = boundedString(
    record.scenarioId,
    "factoryInput.scenarioId",
  );
  if (!(PROVIDER_CANARY_SCENARIO_IDS as readonly string[]).includes(scenarioId))
    fail("factoryInput scenario is not canonical");
  const contract = providerCanaryControllerContract(scenarioId);
  if (record.operationKind !== contract.operationKind)
    fail("factoryInput operation does not match the canonical scenario");
  return Object.freeze({
    scenarioId: scenarioId as ProviderCanaryScenarioId,
    operationKind: contract.operationKind,
    runId: boundedString(record.runId, "factoryInput.runId", 256),
    manifestSha256: requireHash(
      record.manifestSha256,
      "factoryInput.manifestSha256",
    ),
  });
}

function serviceCaller(input: {
  factory: ReturnType<typeof validateFactoryInput>;
  config: AuthenticatedServiceConfig;
  bearerToken: string;
  fetchImpl: typeof fetch;
  role: string;
}): (payload: unknown) => Promise<unknown> {
  return async (payload) => {
    const request: ServiceRequest = {
      schema: REFERENCE_OPERATOR_SERVICE_REQUEST_SCHEMA,
      role: input.role,
      requestNonce: randomBytes(32).toString("base64url"),
      manifestSha256: input.factory.manifestSha256,
      runId: input.factory.runId,
      scenarioId: input.factory.scenarioId,
      operationKind: input.factory.operationKind,
      payload,
    };
    const requestSha256 = createHash("sha256")
      .update(canonicalJson(canonicalJsonValue(request, "serviceRequest")))
      .digest("hex");
    const decoded = await authenticatedPost({
      endpoint: input.config.endpoint,
      bearerToken: input.bearerToken,
      body: request,
      fetchImpl: input.fetchImpl,
      label: input.role,
    });
    const response = plainRecord(
      decoded,
      `${input.role}Response`,
    ) as unknown as ServiceResponse;
    exactKeys(
      response as unknown as Record<string, unknown>,
      ["schema", "role", "requestNonce", "requestSha256", "result"],
      `${input.role}Response`,
    );
    if (
      response.schema !== REFERENCE_OPERATOR_SERVICE_RESPONSE_SCHEMA ||
      response.role !== input.role ||
      response.requestNonce !== request.requestNonce ||
      response.requestSha256 !== requestSha256
    ) {
      fail(`${input.role} response correlation failed`);
    }
    return response.result;
  };
}

function token(
  secrets: Readonly<Record<string, string>>,
  config: AuthenticatedServiceConfig,
): string {
  const value = secrets[config.bearerSecretRef];
  if (!value) fail(`secret broker omitted ${config.bearerSecretRef}`);
  return value;
}

/**
 * Assemble one exact canary after validating the entire deployment inventory.
 * This overload permits hermetic tests and alternative protected secret stores.
 */
export async function createReferenceExternalProviderCanaryCapabilities(
  factoryValue: ExternalProviderCapabilityFactoryInput,
  dependencies: ReferenceOperatorFactoryDependencies = {},
): Promise<ProviderControllerOrchestratorBridge> {
  const factory = validateFactoryInput(factoryValue);
  const rawConfig =
    dependencies.config ??
    readProtectedConfig(
      dependencies.configFile ??
        process.env[REFERENCE_OPERATOR_CONFIG_ENV] ??
        "",
    );
  const config = parseReferenceOperatorConfig(rawConfig);
  const deployment = config.deployments[factory.scenarioId];
  if (
    deployment.operationKind !== factory.operationKind ||
    deployment.scenarioId !== factory.scenarioId
  ) {
    fail("selected deployment does not match the authorized factory input");
  }
  const selectedServices = [
    deployment.controller,
    deployment.observer,
    deployment.semanticJudge,
    deployment.cleanup,
  ] as const;
  const secretRefs = [
    ...new Set(selectedServices.map((service) => service.bearerSecretRef)),
  ].sort();
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const resolvedSecrets = await (
    dependencies.secretResolver ?? defaultSecretResolver(fetchImpl)
  ).resolve({
    endpoint: config.secretBrokerEndpoint,
    secretRefs,
  });
  const secretsRecord = plainRecord(resolvedSecrets, "resolvedSecrets");
  exactKeys(secretsRecord, secretRefs, "resolvedSecrets");
  const secrets = Object.freeze(
    Object.fromEntries(
      secretRefs.map((ref) => {
        const value = boundedString(
          secretsRecord[ref],
          `resolvedSecrets.${ref}`,
        );
        if (value.includes("PRIVATE KEY"))
          fail("secret resolver returned forbidden private signing material");
        return [ref, value];
      }),
    ),
  );
  const controllerCall = serviceCaller({
    factory,
    config: deployment.controller,
    bearerToken: token(secrets, deployment.controller),
    fetchImpl,
    role: "controller-execute",
  });
  const observerBegin = serviceCaller({
    factory,
    config: deployment.observer,
    bearerToken: token(secrets, deployment.observer),
    fetchImpl,
    role: "observer-begin",
  });
  const observerComplete = serviceCaller({
    factory,
    config: deployment.observer,
    bearerToken: token(secrets, deployment.observer),
    fetchImpl,
    role: "observer-complete",
  });
  const judgeCall = serviceCaller({
    factory,
    config: deployment.semanticJudge,
    bearerToken: token(secrets, deployment.semanticJudge),
    fetchImpl,
    role: "semantic-judge-evaluate",
  });
  const cleanupCall = serviceCaller({
    factory,
    config: deployment.cleanup,
    bearerToken: token(secrets, deployment.cleanup),
    fetchImpl,
    role: "cleanup-and-sign",
  });
  const controller: DeployedProviderControllerClient = Object.freeze({
    endpointOrigin: endpointOrigin(deployment.controller.endpoint),
    controllerFamily: deployment.controllerFamily,
    execute: async (
      input: Parameters<DeployedProviderControllerClient["execute"]>[0],
    ) =>
      (await controllerCall(input)) as Awaited<
        ReturnType<DeployedProviderControllerClient["execute"]>
      >,
  });
  const observer: IndependentProviderObserverClient = Object.freeze({
    endpointOrigin: endpointOrigin(deployment.observer.endpoint),
    administrativeDomain: deployment.observer.administrativeDomain,
    beginObservation: async (
      input: Parameters<
        IndependentProviderObserverClient["beginObservation"]
      >[0],
    ) =>
      (await observerBegin(input)) as Awaited<
        ReturnType<IndependentProviderObserverClient["beginObservation"]>
      >,
    complete: async (
      input: Parameters<IndependentProviderObserverClient["complete"]>[0],
    ) =>
      (await observerComplete(input)) as Awaited<
        ReturnType<IndependentProviderObserverClient["complete"]>
      >,
  });
  const semanticJudge: IndependentSemanticJudgeClient = Object.freeze({
    evaluate: async (
      input: Parameters<IndependentSemanticJudgeClient["evaluate"]>[0],
    ) =>
      (await judgeCall(input)) as Awaited<
        ReturnType<IndependentSemanticJudgeClient["evaluate"]>
      >,
  });
  const cleanup: RemoteProviderCleanupClient = Object.freeze({
    endpointOrigin: endpointOrigin(deployment.cleanup.endpoint),
    administrativeDomain: deployment.cleanup.administrativeDomain,
    keyId: deployment.cleanup.keyId,
    publicKeyPem: deployment.cleanup.publicKeyPem,
    cleanupAndSign: async (
      input: Parameters<RemoteProviderCleanupClient["cleanupAndSign"]>[0],
    ) => (await cleanupCall(input)) as SignedProviderCleanupProof,
  });
  const observerPin: RemoteEvidenceSignerPin = Object.freeze({
    role: "observer",
    endpoint: deployment.observer.endpoint,
    organizationId: deployment.observer.organizationId,
    publicKeyPem: deployment.observer.publicKeyPem,
    keyId: deployment.observer.keyId,
    serviceIdentitySha256: deployment.observer.serviceIdentitySha256,
  });
  const judgePin: RemoteEvidenceSignerPin = Object.freeze({
    role: "semantic-judge",
    endpoint: deployment.semanticJudge.endpoint,
    organizationId: deployment.semanticJudge.organizationId,
    publicKeyPem: deployment.semanticJudge.publicKeyPem,
    keyId: deployment.semanticJudge.keyId,
    serviceIdentitySha256: deployment.semanticJudge.serviceIdentitySha256,
  });
  const bridge = createProviderControllerOrchestratorBridge({
    scenarioId: factory.scenarioId,
    operationKind: factory.operationKind,
    controller,
    observer,
    semanticJudge,
    observerSigner: createProviderObserverSignerClient({
      pin: observerPin,
      bearerToken: token(secrets, deployment.observer),
      fetchImpl,
    }),
    semanticJudgeSigner: createSemanticJudgeSignerClient({
      pin: judgePin,
      bearerToken: token(secrets, deployment.semanticJudge),
      fetchImpl,
    }),
    cleanup,
    pinnedObserverPublicKeysPem: deployment.pinnedObserverPublicKeysPem,
    pinnedSemanticJudgePublicKeysPem:
      deployment.pinnedSemanticJudgePublicKeysPem,
    pinnedCleanupPublicKeysPem: deployment.pinnedObserverPublicKeysPem,
  });
  return bridge;
}

/** Secure-loader entry point used by `eliza-provider-canary`. */
export async function createExternalProviderCanaryCapabilities(
  input: ExternalProviderCapabilityFactoryInput,
): Promise<ProviderControllerOrchestratorBridge> {
  return createReferenceExternalProviderCanaryCapabilities(input);
}
