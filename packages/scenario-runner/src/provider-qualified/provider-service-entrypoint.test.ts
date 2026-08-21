/**
 * Exercises the deployment entrypoint with protected real files and a real
 * service host while replacing only the network listener. Provider effects
 * remain deterministic adapters; the tests make no provider-evidence claim.
 */

import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:https";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDER_CONTROLLER_FAMILIES,
  providerCanaryControllerContract,
} from "./controller-registry.ts";
import {
  createProviderCanaryServiceProcess,
  loadProviderServiceDeploymentModule,
  PROVIDER_SERVICE_DEPLOYMENT_CONFIG_SCHEMA,
  type ProviderServiceDeploymentAdapters,
  parseProviderServiceDeploymentConfig,
  providerServiceDeploymentConfigTemplate,
  readProviderServiceDeploymentConfig,
  runProviderServiceDeploymentCli,
} from "./provider-service-entrypoint.ts";
import type { ProviderServiceEd25519Signer } from "./provider-service-host.ts";
import { providerObserverKeyId } from "./qualification.ts";
import { REFERENCE_OPERATOR_SERVICE_REQUEST_SCHEMA } from "./reference-operator-bundle.ts";

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const keyId = providerObserverKeyId(publicKeyPem);
  const signer: ProviderServiceEd25519Signer = {
    keyId,
    publicKeyPem,
    async sign(input) {
      return signBytes(null, input.bytes, privateKey).toString("base64url");
    },
  };
  return {
    public: {
      organizationId: "controller.example",
      administrativeDomain: "controller.example",
      publicKeyPem,
      keyId,
    },
    signer,
  };
}

function authorization(token: string) {
  const scenarioId = "provider.discord.confirmed-send";
  const operationKind =
    providerCanaryControllerContract(scenarioId).operationKind;
  const now = Date.now();
  return {
    bearerTokenSha256: createHash("sha256").update(token).digest("hex"),
    policy: {
      role: "controller-execute",
      manifestSha256: "a".repeat(64),
      repositorySha: "b".repeat(40),
      deploymentSha: "c".repeat(40),
      runId: "deployment-entrypoint-test",
      scenarioId,
      operationKind,
      notBeforeIso: new Date(now - 1_000).toISOString(),
      expiresAtIso: new Date(now + 60_000).toISOString(),
    },
  };
}

function config(token = "a-real-bearer-token") {
  const signer = identity();
  return {
    signer,
    value: {
      schema: PROVIDER_SERVICE_DEPLOYMENT_CONFIG_SCHEMA,
      role: "controller",
      adapterModuleFile: "/deployment/controller-adapter.mjs",
      adapterModuleSha256: "d".repeat(64),
      stateDirectory: "/deployment/state",
      listen: { hostname: "127.0.0.1", port: 8443 },
      servicePath: "/provider-canary/v1/service",
      secretPath: "/provider-canary/v1/secrets",
      responseIdentity: signer.public,
      authorization: [authorization(token)],
      roleConfig: {
        role: "controller",
        controllerFamilies: [...PROVIDER_CONTROLLER_FAMILIES],
      },
    },
  };
}

async function protectedFiles(value: ReturnType<typeof config>["value"]) {
  const directory = realpathSync(
    await mkdtemp(path.join(os.tmpdir(), "provider-service-entrypoint-")),
  );
  temporary.push(directory);
  chmodSync(directory, 0o700);
  const stateDirectory = path.join(directory, "state");
  mkdirSync(stateDirectory, { mode: 0o700 });
  const moduleFile = path.join(directory, "adapter.mjs");
  writeFileSync(
    moduleFile,
    "export function createProviderCanaryServiceDeployment() {}\n",
    { mode: 0o600 },
  );
  const configFile = path.join(directory, "config.json");
  const document = { ...value, stateDirectory, adapterModuleFile: moduleFile };
  writeFileSync(configFile, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  return { directory, stateDirectory, moduleFile, configFile, document };
}

function fakeServer(): Server {
  return {
    once: vi.fn(),
    off: vi.fn(),
    listen: vi.fn(),
  } as unknown as Server;
}

describe("provider service deployment entrypoint", () => {
  it("uses the canonical registry for all seven controller families", () => {
    const template = providerServiceDeploymentConfigTemplate("controller");
    expect(
      (template.roleConfig as { controllerFamilies: string[] })
        .controllerFamilies,
    ).toEqual(PROVIDER_CONTROLLER_FAMILIES);
    expect(PROVIDER_CONTROLLER_FAMILIES).toHaveLength(7);
  });

  it("parses only the exact authorization surface for every process role", () => {
    const base = config().value;
    const [controllerAuthorization] = base.authorization;
    if (!controllerAuthorization)
      throw new Error("test authorization is missing");
    const correlatedRoles = [
      ["observer", "observer-begin"],
      ["semantic-judge", "semantic-judge-evaluate"],
      ["cleanup", "cleanup-execute"],
    ] as const;
    for (const [deploymentRole, serviceRole] of correlatedRoles) {
      const parsed = parseProviderServiceDeploymentConfig({
        ...base,
        role: deploymentRole,
        authorization: [
          {
            ...controllerAuthorization,
            policy: {
              ...controllerAuthorization.policy,
              role: serviceRole,
            },
          },
        ],
        roleConfig:
          deploymentRole === "observer" || deploymentRole === "semantic-judge"
            ? {
                role: deploymentRole,
                endpoint: `https://${deploymentRole}.example${base.servicePath}`,
                evidenceIdentity: base.responseIdentity,
              }
            : { role: deploymentRole },
      });
      expect(parsed.role).toBe(deploymentRole);
    }
    const parsedSecretBroker = parseProviderServiceDeploymentConfig({
      ...base,
      role: "secret-broker",
      authorization: [
        {
          bearerTokenSha256: controllerAuthorization.bearerTokenSha256,
          policy: {
            role: "secret-resolve",
            allowedSecretRefs: ["provider/controller-token"],
            notBeforeIso: controllerAuthorization.policy.notBeforeIso,
            expiresAtIso: controllerAuthorization.policy.expiresAtIso,
          },
        },
      ],
      roleConfig: { role: "secret-broker" },
    });
    expect(parsedSecretBroker.authorization[0]?.policy.role).toBe(
      "secret-resolve",
    );
  });

  it("rejects private keys, unknown fields, cross-role grants, and noncanonical operations", () => {
    const base = config().value;
    const [baseAuthorization] = base.authorization;
    if (!baseAuthorization) throw new Error("test authorization is missing");
    expect(() =>
      parseProviderServiceDeploymentConfig({
        ...base,
        responseIdentity: {
          ...base.responseIdentity,
          publicKeyPem:
            "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
        },
      }),
    ).toThrow(/private key material/);
    expect(() =>
      parseProviderServiceDeploymentConfig({ ...base, surprise: true }),
    ).toThrow(/unsupported shape/);
    expect(() =>
      parseProviderServiceDeploymentConfig({
        ...base,
        authorization: [
          {
            bearerTokenSha256: "a".repeat(64),
            policy: {
              role: "secret-resolve",
              allowedSecretRefs: ["provider/token"],
              notBeforeIso: new Date().toISOString(),
              expiresAtIso: new Date(Date.now() + 10_000).toISOString(),
            },
          },
        ],
      }),
    ).toThrow(/outside this process/);
    expect(() =>
      parseProviderServiceDeploymentConfig({
        ...base,
        authorization: [
          {
            ...baseAuthorization,
            policy: {
              ...baseAuthorization.policy,
              operationKind: "slack.message-send",
            },
          },
        ],
      }),
    ).toThrow(/canonical registry/);
  });

  it("rejects a config reached through a symlink component", async () => {
    const files = await protectedFiles(config().value);
    const link = `${files.directory}-link`;
    temporary.push(link);
    symlinkSync(files.directory, link);
    expect(() =>
      readProviderServiceDeploymentConfig(path.join(link, "config.json")),
    ).toThrow(/symlink component/);
  });

  it("rejects digest drift and runtime module loaders before evaluation", async () => {
    const files = await protectedFiles(config().value);
    await expect(
      loadProviderServiceDeploymentModule(files.moduleFile, "0".repeat(64)),
    ).rejects.toThrow(/digest mismatch/);
    writeFileSync(
      files.moduleFile,
      'export function createProviderCanaryServiceDeployment() { return import("node:fs"); }\n',
      { mode: 0o600 },
    );
    const digest = createHash("sha256")
      .update(
        await import("node:fs/promises").then(({ readFile }) =>
          readFile(files.moduleFile),
        ),
      )
      .digest("hex");
    await expect(
      loadProviderServiceDeploymentModule(files.moduleFile, digest),
    ).rejects.toThrow(/forbidden dynamic import/);

    writeFileSync(
      files.moduleFile,
      'const key = "-----BEGIN PRIVATE KEY-----"; export function createProviderCanaryServiceDeployment() { return key; }\n',
      { mode: 0o600 },
    );
    const privateKeyDigest = createHash("sha256")
      .update(
        await import("node:fs/promises").then(({ readFile }) =>
          readFile(files.moduleFile),
        ),
      )
      .digest("hex");
    await expect(
      loadProviderServiceDeploymentModule(files.moduleFile, privateKeyDigest),
    ).rejects.toThrow(/must not embed private key material/);
  });

  it("fails startup when the selected role adapter is absent", async () => {
    const setup = config();
    const files = await protectedFiles(setup.value);
    await expect(
      createProviderCanaryServiceProcess(files.configFile, {
        async loadModule() {
          return {
            createProviderCanaryServiceDeployment() {
              return {
                role: "controller",
                tls: { pfx: Buffer.from("not-used-by-injected-listener") },
                responseSigner: setup.signer.signer,
                audit() {},
                controllerAdapters: {},
              } satisfies ProviderServiceDeploymentAdapters;
            },
          };
        },
        createHttpsServer: () => fakeServer(),
      }),
    ).rejects.toThrow(/exactly match configured families/);
  });

  it("authenticates before routing an exact canonical request", async () => {
    const token = "authorization-first-token";
    const setup = config(token);
    const files = await protectedFiles(setup.value);
    const execute = vi.fn(async () => ({ providerReceipt: "unsigned" }));
    const controllerAdapters = Object.fromEntries(
      PROVIDER_CONTROLLER_FAMILIES.map((family) => [family, { execute }]),
    );
    const service = await createProviderCanaryServiceProcess(files.configFile, {
      async loadModule() {
        return {
          createProviderCanaryServiceDeployment() {
            return {
              role: "controller",
              tls: { pfx: Buffer.from("not-used-by-injected-listener") },
              responseSigner: setup.signer.signer,
              audit() {},
              controllerAdapters,
            } as ProviderServiceDeploymentAdapters;
          },
        };
      },
      createHttpsServer: () => fakeServer(),
    });
    const [configuredAuthorization] = setup.value.authorization;
    if (!configuredAuthorization)
      throw new Error("test authorization is missing");
    const policy = configuredAuthorization.policy;
    const requestBody = {
      schema: REFERENCE_OPERATOR_SERVICE_REQUEST_SCHEMA,
      role: "controller-execute",
      requestNonce: "n".repeat(32),
      requestedAtIso: new Date().toISOString(),
      expiresAtIso: new Date(Date.now() + 30_000).toISOString(),
      manifestSha256: policy.manifestSha256,
      repositorySha: policy.repositorySha,
      deploymentSha: policy.deploymentSha,
      runId: policy.runId,
      scenarioId: policy.scenarioId,
      operationKind: policy.operationKind,
      payload: { exact: true },
    };
    const invoke = (bearer: string, nonce: string) =>
      service.host.handle(
        new Request("https://controller.example/provider-canary/v1/service", {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ ...requestBody, requestNonce: nonce }),
        }),
      );
    expect(
      (await invoke("wrong-token-that-is-long-enough", "x".repeat(32))).status,
    ).toBe(403);
    expect(execute).not.toHaveBeenCalled();
    expect((await invoke(token, "y".repeat(32))).status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].scenarioId).toBe(
      "provider.discord.confirmed-send",
    );
  });

  it("keeps CLI diagnostics secret-safe", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    await expect(
      runProviderServiceDeploymentCli([
        "serve",
        "/missing/private-config.json",
      ]),
    ).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      "eliza-provider-service: deployment refused\n",
    );
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(
      "private-config.json",
    );
  });
});
