/**
 * Loads one content-pinned production adapter bundle and constructs a
 * least-privilege provider-canary service process. Configuration contains
 * public identities and hash-only authorization policy; TLS and HSM private
 * material remain inside deployment-owned adapters.
 */

import { createHash, createPublicKey } from "node:crypto";
import { realpathSync } from "node:fs";
import type { Server, ServerOptions } from "node:https";
import path from "node:path";
import {
  PROVIDER_CONTROLLER_FAMILIES,
  type ProviderControllerFamily,
  providerCanaryControllerContract,
} from "./controller-registry.ts";
import {
  inspectPinnedSelfContainedModuleBytes,
  readStableOperatorFile,
} from "./operator-file-security.ts";
import {
  createFileProviderServiceStateStore,
  createProviderCanaryHttpsServer,
  createProviderCanaryServiceHost,
  createStaticProviderServiceRoleAuthorizer,
  DEFAULT_PROVIDER_SECRET_PATH,
  DEFAULT_PROVIDER_SERVICE_PATH,
  type ProviderCanaryServiceHost,
  type ProviderCleanupServiceAdapter,
  type ProviderControllerServiceAdapter,
  type ProviderObserverServiceAdapter,
  type ProviderSecretBrokerAdapter,
  type ProviderSemanticJudgeServiceAdapter,
  type ProviderServiceEd25519Signer,
  type ProviderServiceRole,
  type StaticProviderServiceAuthorization,
} from "./provider-service-host.ts";
import { providerObserverKeyId } from "./qualification.ts";

export const PROVIDER_SERVICE_DEPLOYMENT_CONFIG_SCHEMA =
  "eliza.provider-canary-service-deployment.v1" as const;
export const PROVIDER_SERVICE_DEPLOYMENT_FACTORY_EXPORT =
  "createProviderCanaryServiceDeployment" as const;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const ALLOWED_ROLES = {
  controller: ["controller-execute"],
  observer: [
    "observer-begin",
    "observer-complete",
    "observer-sign",
    "observer-cleanup-sign",
  ],
  "semantic-judge": ["semantic-judge-evaluate", "semantic-judge-sign"],
  cleanup: ["cleanup-execute"],
  "secret-broker": ["secret-resolve"],
} as const satisfies Record<
  ProviderServiceDeploymentRole,
  readonly ProviderServiceRole[]
>;

export type ProviderServiceDeploymentRole =
  | "controller"
  | "observer"
  | "semantic-judge"
  | "cleanup"
  | "secret-broker";

export interface ProviderServicePublicIdentity {
  organizationId: string;
  administrativeDomain: string;
  publicKeyPem: string;
  keyId: string;
}

export interface ProviderServiceDeploymentConfig {
  schema: typeof PROVIDER_SERVICE_DEPLOYMENT_CONFIG_SCHEMA;
  role: ProviderServiceDeploymentRole;
  adapterModuleFile: string;
  adapterModuleSha256: string;
  stateDirectory: string;
  listen: { hostname: string; port: number };
  servicePath: string;
  secretPath: string;
  responseIdentity: ProviderServicePublicIdentity;
  authorization: readonly StaticProviderServiceAuthorization[];
  roleConfig:
    | {
        role: "controller";
        controllerFamilies: readonly ProviderControllerFamily[];
      }
    | {
        role: "observer";
        endpoint: string;
        evidenceIdentity: ProviderServicePublicIdentity;
      }
    | {
        role: "semantic-judge";
        endpoint: string;
        evidenceIdentity: ProviderServicePublicIdentity;
      }
    | { role: "cleanup" }
    | { role: "secret-broker" };
}

export interface ProviderServiceDeploymentFactoryInput {
  role: ProviderServiceDeploymentRole;
  roleConfig: ProviderServiceDeploymentConfig["roleConfig"];
  responseIdentity: ProviderServicePublicIdentity;
  servicePath: string;
  secretPath: string;
}

export type ProviderServiceAudit = NonNullable<
  Parameters<typeof createProviderCanaryServiceHost>[0]["audit"]
>;

interface ProviderServiceDeploymentBase {
  tls: ServerOptions;
  responseSigner: ProviderServiceEd25519Signer;
  audit: ProviderServiceAudit;
}

export type ProviderServiceDeploymentAdapters =
  | (ProviderServiceDeploymentBase & {
      role: "controller";
      controllerAdapters: Readonly<
        Partial<
          Record<ProviderControllerFamily, ProviderControllerServiceAdapter>
        >
      >;
    })
  | (ProviderServiceDeploymentBase & {
      role: "observer";
      observerAdapter: ProviderObserverServiceAdapter;
      evidenceSigner: ProviderServiceEd25519Signer;
    })
  | (ProviderServiceDeploymentBase & {
      role: "semantic-judge";
      semanticJudgeAdapter: ProviderSemanticJudgeServiceAdapter;
      evidenceSigner: ProviderServiceEd25519Signer;
    })
  | (ProviderServiceDeploymentBase & {
      role: "cleanup";
      cleanupAdapter: ProviderCleanupServiceAdapter;
    })
  | (ProviderServiceDeploymentBase & {
      role: "secret-broker";
      secretBrokerAdapter: ProviderSecretBrokerAdapter;
    });

export interface ProviderServiceDeploymentModule {
  createProviderCanaryServiceDeployment(
    input: ProviderServiceDeploymentFactoryInput,
  ):
    | Promise<ProviderServiceDeploymentAdapters>
    | ProviderServiceDeploymentAdapters;
}

export interface ProviderCanaryServiceProcess {
  config: ProviderServiceDeploymentConfig;
  host: ProviderCanaryServiceHost;
  server: Server;
}

function fail(message: string): never {
  throw new Error(`provider service deployment refused: ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    fail(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) => !("value" in descriptor) || !descriptor.enumerable,
    )
  )
    fail(`${label} must contain only enumerable data properties`);
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, i) => key !== expected[i])
  )
    fail(`${label} has an unsupported shape`);
}

function string(value: unknown, label: string, max = 8_192): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    fail(`${label} must be a bounded non-empty string`);
  return value;
}

function hash(value: unknown, label: string): string {
  const result = string(value, label, 64);
  if (!HASH_PATTERN.test(result)) fail(`${label} must be lowercase SHA-256`);
  return result;
}

function sourceSha(value: unknown, label: string): string {
  const result = string(value, label, 64);
  if (!SOURCE_SHA_PATTERN.test(result))
    fail(`${label} must be a source digest`);
  return result;
}

function iso(value: unknown, label: string): string {
  const result = string(value, label, 64);
  const time = Date.parse(result);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== result)
    fail(`${label} must be a canonical ISO timestamp`);
  return result;
}

function publicIdentity(
  value: unknown,
  label: string,
): ProviderServicePublicIdentity {
  const input = record(value, label);
  exact(
    input,
    ["organizationId", "administrativeDomain", "publicKeyPem", "keyId"],
    label,
  );
  const organizationId = string(
    input.organizationId,
    `${label}.organizationId`,
    256,
  );
  const administrativeDomain = string(
    input.administrativeDomain,
    `${label}.administrativeDomain`,
    256,
  );
  if (organizationId !== administrativeDomain)
    fail(`${label} organization must own its administrative domain`);
  const publicKeyPem = string(
    input.publicKeyPem,
    `${label}.publicKeyPem`,
    16_384,
  );
  if (/PRIVATE KEY/u.test(publicKeyPem))
    fail(`${label} contains private key material`);
  try {
    if (createPublicKey(publicKeyPem).asymmetricKeyType !== "ed25519")
      fail(`${label} must use Ed25519`);
  } catch {
    // error-policy:J3 deployment configuration is untrusted input.
    fail(`${label}.publicKeyPem must be a valid Ed25519 public key`);
  }
  const keyId = hash(input.keyId, `${label}.keyId`);
  if (providerObserverKeyId(publicKeyPem) !== keyId)
    fail(`${label}.keyId does not match its public key`);
  return Object.freeze({
    organizationId,
    administrativeDomain,
    publicKeyPem,
    keyId,
  });
}

function endpoint(value: unknown, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(string(value, label, 2_048));
  } catch {
    return fail(`${label} must be an absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname === "/"
  )
    fail(`${label} must be credential-free HTTPS with an explicit path`);
  return parsed.href;
}

function servicePath(value: unknown, label: string): string {
  const result = string(value, label, 1_024);
  if (!result.startsWith("/") || result.includes("?") || result.includes("#"))
    fail(`${label} must be an absolute URL path`);
  return result;
}

function parseAuthorization(
  value: unknown,
  deploymentRole: ProviderServiceDeploymentRole,
  controllerFamilies: readonly ProviderControllerFamily[],
): readonly StaticProviderServiceAuthorization[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 512)
    fail("authorization must contain between one and 512 grants");
  const seen = new Set<string>();
  return Object.freeze(
    value.map((entry, index) => {
      const item = record(entry, `authorization[${index}]`);
      exact(item, ["bearerTokenSha256", "policy"], `authorization[${index}]`);
      const bearerTokenSha256 = hash(
        item.bearerTokenSha256,
        `authorization[${index}].bearerTokenSha256`,
      );
      const policy = record(item.policy, `authorization[${index}].policy`);
      const role = string(
        policy.role,
        `authorization[${index}].policy.role`,
        64,
      ) as ProviderServiceRole;
      if (!(ALLOWED_ROLES[deploymentRole] as readonly string[]).includes(role))
        fail(`authorization[${index}] grants a role outside this process`);
      let parsedPolicy: StaticProviderServiceAuthorization["policy"];
      if (role === "secret-resolve") {
        exact(
          policy,
          ["role", "allowedSecretRefs", "notBeforeIso", "expiresAtIso"],
          `authorization[${index}].policy`,
        );
        if (
          !Array.isArray(policy.allowedSecretRefs) ||
          policy.allowedSecretRefs.length === 0
        )
          fail(`authorization[${index}] must bind at least one secret ref`);
        const refs = policy.allowedSecretRefs.map((ref, refIndex) => {
          const result = string(
            ref,
            `authorization[${index}].allowedSecretRefs[${refIndex}]`,
            256,
          );
          if (!REF_PATTERN.test(result))
            fail(`authorization[${index}] has an invalid secret ref`);
          return result;
        });
        if (
          new Set(refs).size !== refs.length ||
          [...refs].sort().some((ref, i) => ref !== refs[i])
        )
          fail(`authorization[${index}] secret refs must be unique and sorted`);
        parsedPolicy = {
          role,
          allowedSecretRefs: Object.freeze(refs),
          notBeforeIso: iso(
            policy.notBeforeIso,
            `authorization[${index}].notBeforeIso`,
          ),
          expiresAtIso: iso(
            policy.expiresAtIso,
            `authorization[${index}].expiresAtIso`,
          ),
        };
      } else {
        exact(
          policy,
          [
            "role",
            "manifestSha256",
            "repositorySha",
            "deploymentSha",
            "runId",
            "scenarioId",
            "operationKind",
            "notBeforeIso",
            "expiresAtIso",
          ],
          `authorization[${index}].policy`,
        );
        const scenarioId = string(
          policy.scenarioId,
          `authorization[${index}].scenarioId`,
          256,
        );
        const contract = providerCanaryControllerContract(scenarioId);
        const operationKind = string(
          policy.operationKind,
          `authorization[${index}].operationKind`,
          256,
        );
        if (operationKind !== contract.operationKind)
          fail(
            `authorization[${index}] operation disagrees with the canonical registry`,
          );
        if (
          deploymentRole === "controller" &&
          !controllerFamilies.includes(contract.controllerFamily)
        )
          fail(`authorization[${index}] controller family is not enabled`);
        parsedPolicy = {
          role,
          manifestSha256: hash(
            policy.manifestSha256,
            `authorization[${index}].manifestSha256`,
          ),
          repositorySha: sourceSha(
            policy.repositorySha,
            `authorization[${index}].repositorySha`,
          ),
          deploymentSha: sourceSha(
            policy.deploymentSha,
            `authorization[${index}].deploymentSha`,
          ),
          runId: string(policy.runId, `authorization[${index}].runId`, 256),
          scenarioId,
          operationKind,
          notBeforeIso: iso(
            policy.notBeforeIso,
            `authorization[${index}].notBeforeIso`,
          ),
          expiresAtIso: iso(
            policy.expiresAtIso,
            `authorization[${index}].expiresAtIso`,
          ),
        };
      }
      const starts = Date.parse(parsedPolicy.notBeforeIso);
      const expires = Date.parse(parsedPolicy.expiresAtIso);
      if (expires <= starts || expires - starts > 5 * 60_000)
        fail(
          `authorization[${index}] window must be positive and at most five minutes`,
        );
      const uniqueness = createHash("sha256")
        .update(JSON.stringify({ bearerTokenSha256, policy: parsedPolicy }))
        .digest("hex");
      if (seen.has(uniqueness))
        fail(`authorization[${index}] duplicates an earlier grant`);
      seen.add(uniqueness);
      return Object.freeze({
        bearerTokenSha256,
        policy: Object.freeze(parsedPolicy),
      });
    }),
  );
}

/** Parse the closed deployment document without evaluating an adapter module. */
export function parseProviderServiceDeploymentConfig(
  value: unknown,
): ProviderServiceDeploymentConfig {
  const input = record(value, "config");
  exact(
    input,
    [
      "schema",
      "role",
      "adapterModuleFile",
      "adapterModuleSha256",
      "stateDirectory",
      "listen",
      "servicePath",
      "secretPath",
      "responseIdentity",
      "authorization",
      "roleConfig",
    ],
    "config",
  );
  if (input.schema !== PROVIDER_SERVICE_DEPLOYMENT_CONFIG_SCHEMA)
    fail("config schema is unsupported");
  const role = string(
    input.role,
    "config.role",
    64,
  ) as ProviderServiceDeploymentRole;
  if (!Object.hasOwn(ALLOWED_ROLES, role)) fail("config.role is unsupported");
  const adapterModuleFile = string(
    input.adapterModuleFile,
    "config.adapterModuleFile",
    4_096,
  );
  const stateDirectory = string(
    input.stateDirectory,
    "config.stateDirectory",
    4_096,
  );
  if (!path.isAbsolute(adapterModuleFile) || !path.isAbsolute(stateDirectory))
    fail("module and state paths must be absolute");
  const listen = record(input.listen, "config.listen");
  exact(listen, ["hostname", "port"], "config.listen");
  const hostname = string(listen.hostname, "config.listen.hostname", 253);
  if (hostname.includes("/") || /\s/u.test(hostname))
    fail("listen hostname is invalid");
  if (
    !Number.isInteger(listen.port) ||
    Number(listen.port) < 1 ||
    Number(listen.port) > 65_535
  )
    fail("listen port must be between 1 and 65535");
  const parsedServicePath = servicePath(
    input.servicePath,
    "config.servicePath",
  );
  const parsedSecretPath = servicePath(input.secretPath, "config.secretPath");
  if (parsedServicePath === parsedSecretPath)
    fail("service and secret paths must differ");
  const roleInput = record(input.roleConfig, "config.roleConfig");
  if (roleInput.role !== role) fail("roleConfig role must match config role");
  let roleConfig: ProviderServiceDeploymentConfig["roleConfig"];
  let controllerFamilies: readonly ProviderControllerFamily[] = [];
  if (role === "controller") {
    exact(roleInput, ["role", "controllerFamilies"], "config.roleConfig");
    if (
      !Array.isArray(roleInput.controllerFamilies) ||
      roleInput.controllerFamilies.length === 0
    )
      fail("controllerFamilies must not be empty");
    controllerFamilies = Object.freeze(
      roleInput.controllerFamilies.map((family) => {
        if (
          !(PROVIDER_CONTROLLER_FAMILIES as readonly unknown[]).includes(family)
        )
          fail("controllerFamilies contains an unsupported family");
        return family as ProviderControllerFamily;
      }),
    );
    if (new Set(controllerFamilies).size !== controllerFamilies.length)
      fail("controllerFamilies must be unique");
    roleConfig = Object.freeze({ role, controllerFamilies });
  } else if (role === "observer" || role === "semantic-judge") {
    exact(
      roleInput,
      ["role", "endpoint", "evidenceIdentity"],
      "config.roleConfig",
    );
    const publicEndpoint = endpoint(
      roleInput.endpoint,
      "config.roleConfig.endpoint",
    );
    if (new URL(publicEndpoint).pathname !== parsedServicePath)
      fail("evidence endpoint path must equal config.servicePath");
    roleConfig = Object.freeze({
      role,
      endpoint: publicEndpoint,
      evidenceIdentity: publicIdentity(
        roleInput.evidenceIdentity,
        "config.roleConfig.evidenceIdentity",
      ),
    });
  } else {
    exact(roleInput, ["role"], "config.roleConfig");
    roleConfig = Object.freeze({ role });
  }
  return Object.freeze({
    schema: PROVIDER_SERVICE_DEPLOYMENT_CONFIG_SCHEMA,
    role,
    adapterModuleFile,
    adapterModuleSha256: hash(
      input.adapterModuleSha256,
      "config.adapterModuleSha256",
    ),
    stateDirectory,
    listen: Object.freeze({ hostname, port: Number(listen.port) }),
    servicePath: parsedServicePath,
    secretPath: parsedSecretPath,
    responseIdentity: publicIdentity(
      input.responseIdentity,
      "config.responseIdentity",
    ),
    authorization: parseAuthorization(
      input.authorization,
      role,
      controllerFamilies,
    ),
    roleConfig,
  });
}

/** Read one current-user-only, non-symlinked deployment configuration. */
export function readProviderServiceDeploymentConfig(
  file: string,
): ProviderServiceDeploymentConfig {
  const absolute = path.resolve(file);
  if (!path.isAbsolute(file) || realpathSync(absolute) !== absolute)
    fail("config path must be absolute and contain no symlink component");
  const bytes = readStableOperatorFile(absolute, "provider service config", {
    maxBytes: MAX_CONFIG_BYTES,
    requireCurrentUser: true,
    requirePrivateMode: true,
  });
  try {
    return parseProviderServiceDeploymentConfig(
      JSON.parse(bytes.toString("utf8")),
    );
  } catch (error) {
    // error-policy:J3 malformed deployment configuration fails closed.
    if (error instanceof SyntaxError) fail("config is not valid JSON");
    throw error;
  }
}

/** Load exactly the reviewed self-contained adapter bytes. */
export async function loadProviderServiceDeploymentModule(
  file: string,
  expectedSha256: string,
): Promise<ProviderServiceDeploymentModule> {
  if (!path.isAbsolute(file)) fail("adapter module path must be absolute");
  if (realpathSync(file) !== file)
    fail("adapter module path contains a symlink component");
  const bytes = readStableOperatorFile(
    file,
    "provider service adapter module",
    {
      requireCurrentUser: true,
    },
  );
  inspectPinnedSelfContainedModuleBytes(
    bytes,
    expectedSha256,
    PROVIDER_SERVICE_DEPLOYMENT_FACTORY_EXPORT,
  );
  const imported = (await import(
    `data:text/javascript;base64,${bytes.toString("base64")}`
  )) as Partial<ProviderServiceDeploymentModule>;
  if (typeof imported.createProviderCanaryServiceDeployment !== "function")
    fail("adapter module lacks its deployment factory");
  return imported as ProviderServiceDeploymentModule;
}

function verifySigner(
  signer: ProviderServiceEd25519Signer,
  identity: ProviderServicePublicIdentity,
  label: string,
): ProviderServiceEd25519Signer {
  if (
    signer === null ||
    typeof signer !== "object" ||
    typeof signer.sign !== "function"
  )
    fail(`${label} signer is missing`);
  if (
    signer.keyId !== identity.keyId ||
    signer.publicKeyPem !== identity.publicKeyPem
  )
    fail(`${label} signer does not match the configured public identity`);
  return signer;
}

function exactAdapterKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (
    actual.length !== sorted.length ||
    actual.some((key, index) => key !== sorted[index])
  )
    fail(`${label} returned unsupported capabilities`);
}

function hasTlsMaterial(tls: ServerOptions): boolean {
  const value = tls as Record<string, unknown>;
  return (
    value.pfx !== undefined ||
    (value.key !== undefined && value.cert !== undefined)
  );
}

function methods(
  adapter: object,
  names: readonly string[],
  label: string,
): void {
  for (const name of names) {
    if (typeof (adapter as Record<string, unknown>)[name] !== "function")
      fail(`${label} adapter is missing ${name}`);
  }
}

function controllerRouter(
  families: readonly ProviderControllerFamily[],
  adapters: Readonly<
    Partial<Record<ProviderControllerFamily, ProviderControllerServiceAdapter>>
  >,
): ProviderControllerServiceAdapter {
  const expected = [...families].sort();
  if (
    Object.keys(adapters)
      .sort()
      .some((family, index) => family !== expected[index]) ||
    Object.keys(adapters).length !== expected.length
  )
    fail("controller adapter set must exactly match configured families");
  for (const family of families) {
    const adapter = adapters[family];
    if (typeof adapter?.execute !== "function")
      fail(`controller adapter ${family} is missing execute`);
  }
  return Object.freeze({
    async execute(context, payload) {
      const contract = providerCanaryControllerContract(context.scenarioId);
      if (
        contract.operationKind !== context.operationKind ||
        !families.includes(contract.controllerFamily)
      )
        fail("controller request disagrees with the canonical registry");
      const adapter = adapters[contract.controllerFamily];
      if (!adapter) fail("canonical controller adapter is unavailable");
      return adapter.execute(context, payload);
    },
  });
}

/** Construct a role-specific host and HTTPS server without listening yet. */
export async function createProviderCanaryServiceProcess(
  configFile: string,
  dependencies: {
    loadModule?: typeof loadProviderServiceDeploymentModule;
    createHttpsServer?: typeof createProviderCanaryHttpsServer;
  } = {},
): Promise<ProviderCanaryServiceProcess> {
  const config = readProviderServiceDeploymentConfig(configFile);
  const module = await (
    dependencies.loadModule ?? loadProviderServiceDeploymentModule
  )(config.adapterModuleFile, config.adapterModuleSha256);
  const adapters = await module.createProviderCanaryServiceDeployment({
    role: config.role,
    roleConfig: config.roleConfig,
    responseIdentity: config.responseIdentity,
    servicePath: config.servicePath,
    secretPath: config.secretPath,
  });
  if (
    !adapters ||
    typeof adapters !== "object" ||
    adapters.role !== config.role
  )
    fail("adapter factory returned the wrong deployment role");
  if (!hasTlsMaterial(adapters.tls))
    fail("adapter factory must supply TLS key and certificate material");
  if (typeof adapters.audit !== "function")
    fail("adapter factory must supply a security audit sink");
  const responseSigner = verifySigner(
    adapters.responseSigner,
    config.responseIdentity,
    "response",
  );
  const base = {
    authorizer: createStaticProviderServiceRoleAuthorizer(config.authorization),
    stateStore: createFileProviderServiceStateStore(config.stateDirectory),
    responseSigner: {
      signer: responseSigner,
      organizationId: config.responseIdentity.organizationId,
      administrativeDomain: config.responseIdentity.administrativeDomain,
    },
    servicePath: config.servicePath,
    secretPath: config.secretPath,
    audit: adapters.audit,
  };
  let host: ProviderCanaryServiceHost;
  if (
    adapters.role === "controller" &&
    config.roleConfig.role === "controller"
  ) {
    exactAdapterKeys(
      adapters,
      ["role", "tls", "responseSigner", "audit", "controllerAdapters"],
      "controller adapter factory",
    );
    host = createProviderCanaryServiceHost({
      ...base,
      controller: controllerRouter(
        config.roleConfig.controllerFamilies,
        adapters.controllerAdapters,
      ),
    });
  } else if (
    adapters.role === "observer" &&
    config.roleConfig.role === "observer"
  ) {
    exactAdapterKeys(
      adapters,
      [
        "role",
        "tls",
        "responseSigner",
        "audit",
        "observerAdapter",
        "evidenceSigner",
      ],
      "observer adapter factory",
    );
    methods(
      adapters.observerAdapter,
      [
        "begin",
        "complete",
        "validateEvidenceForSigning",
        "validateCleanupForSigning",
      ],
      "observer",
    );
    host = createProviderCanaryServiceHost({
      ...base,
      observer: {
        adapter: adapters.observerAdapter,
        signer: verifySigner(
          adapters.evidenceSigner,
          config.roleConfig.evidenceIdentity,
          "observer evidence",
        ),
        endpoint: config.roleConfig.endpoint,
        organizationId: config.roleConfig.evidenceIdentity.organizationId,
      },
    });
  } else if (
    adapters.role === "semantic-judge" &&
    config.roleConfig.role === "semantic-judge"
  ) {
    exactAdapterKeys(
      adapters,
      [
        "role",
        "tls",
        "responseSigner",
        "audit",
        "semanticJudgeAdapter",
        "evidenceSigner",
      ],
      "semantic judge adapter factory",
    );
    methods(
      adapters.semanticJudgeAdapter,
      ["evaluate", "validateEvidenceForSigning"],
      "semantic judge",
    );
    host = createProviderCanaryServiceHost({
      ...base,
      semanticJudge: {
        adapter: adapters.semanticJudgeAdapter,
        signer: verifySigner(
          adapters.evidenceSigner,
          config.roleConfig.evidenceIdentity,
          "semantic judge evidence",
        ),
        endpoint: config.roleConfig.endpoint,
        organizationId: config.roleConfig.evidenceIdentity.organizationId,
      },
    });
  } else if (
    adapters.role === "cleanup" &&
    config.roleConfig.role === "cleanup"
  ) {
    exactAdapterKeys(
      adapters,
      ["role", "tls", "responseSigner", "audit", "cleanupAdapter"],
      "cleanup adapter factory",
    );
    methods(adapters.cleanupAdapter, ["executeCleanup"], "cleanup");
    host = createProviderCanaryServiceHost({
      ...base,
      cleanup: adapters.cleanupAdapter,
    });
  } else if (
    adapters.role === "secret-broker" &&
    config.roleConfig.role === "secret-broker"
  ) {
    exactAdapterKeys(
      adapters,
      ["role", "tls", "responseSigner", "audit", "secretBrokerAdapter"],
      "secret broker adapter factory",
    );
    methods(adapters.secretBrokerAdapter, ["resolve"], "secret broker");
    host = createProviderCanaryServiceHost({
      ...base,
      secretBroker: adapters.secretBrokerAdapter,
    });
  } else {
    return fail("adapter role is inconsistent with configuration");
  }
  const server = (
    dependencies.createHttpsServer ?? createProviderCanaryHttpsServer
  )({
    host,
    tls: adapters.tls,
  });
  return Object.freeze({ config, host, server });
}

/** Start one role-specific service and resolve after the socket is listening. */
export async function runProviderCanaryService(
  configFile: string,
): Promise<ProviderCanaryServiceProcess> {
  const process = await createProviderCanaryServiceProcess(configFile);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    process.server.once("error", onError);
    process.server.listen(
      process.config.listen.port,
      process.config.listen.hostname,
      () => {
        process.server.off("error", onError);
        resolve();
      },
    );
  });
  return process;
}

/** Run the deployment CLI. It prints no config, secret, or adapter errors. */
export async function runProviderServiceDeploymentCli(
  argv = process.argv.slice(2),
): Promise<number> {
  const [command, argument] = argv;
  if (
    argv.length === 2 &&
    command === "template" &&
    argument !== undefined &&
    Object.hasOwn(ALLOWED_ROLES, argument)
  ) {
    process.stdout.write(
      `${JSON.stringify(
        providerServiceDeploymentConfigTemplate(
          argument as ProviderServiceDeploymentRole,
        ),
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  if (
    argv.length !== 2 ||
    command !== "serve" ||
    argument === undefined ||
    !path.isAbsolute(argument)
  ) {
    process.stderr.write(
      "usage: eliza-provider-service serve /absolute/path/to/config.json | template <controller|observer|semantic-judge|cleanup|secret-broker>\n",
    );
    return 2;
  }
  try {
    await runProviderCanaryService(argument);
    return 0;
  } catch {
    // error-policy:J1 the process boundary emits one secret-safe failure.
    process.stderr.write("eliza-provider-service: deployment refused\n");
    return 1;
  }
}

/** Deliberately invalid starter data; replace every placeholder before use. */
export function providerServiceDeploymentConfigTemplate(
  role: ProviderServiceDeploymentRole,
): Record<string, unknown> {
  const identity = {
    organizationId: "__REPLACE_WITH_ORGANIZATION_ID__",
    administrativeDomain: "__REPLACE_WITH_ADMINISTRATIVE_DOMAIN__",
    publicKeyPem: "__REPLACE_WITH_ED25519_PUBLIC_KEY_PEM__",
    keyId: "__REPLACE_WITH_ED25519_KEY_SHA256__",
  };
  return {
    schema: PROVIDER_SERVICE_DEPLOYMENT_CONFIG_SCHEMA,
    role,
    adapterModuleFile: "/absolute/path/to/content-pinned-adapter.mjs",
    adapterModuleSha256: "__REPLACE_WITH_ADAPTER_SHA256__",
    stateDirectory: "/absolute/path/to/protected-state",
    listen: { hostname: "127.0.0.1", port: 8443 },
    servicePath: DEFAULT_PROVIDER_SERVICE_PATH,
    secretPath: DEFAULT_PROVIDER_SECRET_PATH,
    responseIdentity: identity,
    authorization: [],
    roleConfig:
      role === "controller"
        ? { role, controllerFamilies: [...PROVIDER_CONTROLLER_FAMILIES] }
        : role === "observer" || role === "semantic-judge"
          ? {
              role,
              endpoint: `https://${role}.example${DEFAULT_PROVIDER_SERVICE_PATH}`,
              evidenceIdentity: identity,
            }
          : { role },
  };
}

if (import.meta.main)
  process.exitCode = await runProviderServiceDeploymentCli();
