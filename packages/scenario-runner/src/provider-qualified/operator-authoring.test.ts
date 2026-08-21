/**
 * Exercises the offline operator authoring boundary against real private files
 * and the statically parsed 13-canary corpus, without provider execution.
 */

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PROVIDER_CANARY_SCENARIOS } from "../../../test/scenarios/provider-qualified/_provider-canary-catalog.ts";
import { providerCanaryControllerContract } from "./controller-registry.ts";
import {
  canonicalProviderCanaryDefinition,
  exportProviderManifestSigningRequest,
  importProviderManifestSignature,
  initializeProviderOperatorDirectory,
  PROVIDER_OPERATOR_INPUT_JSON_SCHEMA,
  PROVIDER_OPERATOR_PLAN_JSON_SCHEMA,
  PROVIDER_OPERATOR_PROBES_JSON_SCHEMA,
  PROVIDER_OPERATOR_TARGET_JSON_SCHEMA,
  preflightProviderCanaryInventory,
  preflightProviderOperatorDirectory,
  prepareProviderCanaryRunDirectory,
} from "./operator-authoring.ts";
import { runProviderOperatorCli } from "./operator-authoring-cli.ts";
import {
  createProviderCanaryTargetBinding,
  createProviderFailureProbeHashBinding,
} from "./operator-authorization.ts";
import { providerObserverKeyId } from "./qualification.ts";
import { createProviderCanaryScenarioSnapshot } from "./scenario-snapshot.ts";

const SCENARIO_DIRECTORY = fileURLToPath(
  new URL("../../../test/scenarios/provider-qualified/", import.meta.url),
);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "eliza-provider-operator-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function gmailBindings(input: {
  authorityKeyId: string;
  providerTarget: unknown;
  operationInput: unknown;
  probes: Array<{
    probeId: string;
    requestPayload: unknown;
    expectedErrorCode: unknown;
    scope: unknown;
    authorizationGrant: unknown;
  }>;
}) {
  const accountRefSha256 = hash("operator-gmail-canary-account");
  const connectionRefSha256 = hash("operator-gmail-connection");
  const principalRefSha256 = hash("operator-principal");
  const roomRefSha256 = hash("operator-room");
  const probeHashes = input.probes.map(createProviderFailureProbeHashBinding);
  const observerKeyId = hash("observer-key");
  return {
    runId: "gmail-operator-run-001",
    runNonce: "n".repeat(64),
    repositorySha: "a".repeat(40),
    deploymentSha: "b".repeat(64),
    trust: {
      manifestAuthorityKeyId: input.authorityKeyId,
      observerSigners: [
        { observerId: "gmail-provider-observer", keyId: observerKeyId },
      ],
    },
    target: {
      principalRefSha256,
      roomRefSha256,
      operation: createProviderCanaryTargetBinding({
        kind: "gmail.email-send",
        providerTarget: input.providerTarget,
        operationInput: input.operationInput,
      }),
    },
    models: {
      actingAdapter: "eliza-runtime",
      actingProvider: "acting-provider",
      actingModel: "acting-model",
      judgeProvider: "independent-judge-provider",
      judgeModel: "independent-judge-model",
      judgeKeyId: hash("judge-key"),
    },
    connectors: [
      {
        provider: "google",
        accountRefSha256,
        connectionRefSha256,
        environment: "operator-canary",
      },
    ],
    ingress: {
      kind: "provider-api",
      provider: "google",
      channel: "gmail",
      accountRefSha256,
      connectionRefSha256,
      authenticatedPrincipalRefSha256: principalRefSha256,
      roomRefSha256,
      endpointOriginSha256: hash("https://canary.example.test"),
    },
    capabilities: [
      {
        provider: "google",
        accountRefSha256,
        connectionRefSha256,
        capability: "email-send",
        authorizationGrantSha256: hash("gmail-send-grant"),
      },
    ],
    observationContracts: [
      {
        contractId: "gmail-canary-email-send",
        kind: "provider-effect",
        observerId: "gmail-provider-observer",
        sourceKind: "provider-api",
        system: "gmail",
        environment: "operator-canary",
        connectorProvider: "google",
        accountRefSha256,
        connectionRefSha256,
        requiredCount: 1,
        maxObservationAgeMs: 60_000,
        provider: "gmail",
        operation: "email-send",
        providerAcceptanceRequired: true,
        readbackRequired: true,
        idempotencyRequired: true,
      },
    ],
    failureProbes: probeHashes.map((probe, index) => ({
      ...probe,
      observerId: "gmail-provider-observer",
      sourceKind: "provider-api",
      system: "gmail",
      environment: "operator-canary",
      provider: "gmail",
      connectorProvider: "google",
      accountRefSha256,
      connectionRefSha256,
      operation: "email-send",
      failureClass: index === 0 ? "authorization-denied" : "provider-rejected",
      expectedStatusCode: index === 0 ? 403 : 400,
      maxObservationAgeMs: 60_000,
    })),
  };
}

async function configureGmailAuthoring(input: {
  directory: string;
  authorityKeyId: string;
  authorizationFile?: string;
  publicKeyFile?: string;
}): Promise<void> {
  const providerTarget = {
    recipientEmail: "operator-recipient@example.test",
  };
  const operationInput = {
    subject: "elizaOS provider canary",
    bodyText: "Gmail provider canary delivery",
    cc: [],
    bcc: [],
  };
  const probes = [
    {
      probeId: "gmail-auth-denied",
      requestPayload: { subject: "denied" },
      expectedErrorCode: "insufficient-scope",
      scope: { account: "operator-canary" },
      authorizationGrant: { grant: "denied" },
    },
    {
      probeId: "gmail-provider-rejected",
      requestPayload: { recipient: "invalid" },
      expectedErrorCode: "invalid-recipient",
      scope: { account: "operator-canary" },
      authorizationGrant: { grant: "send" },
    },
  ];
  await writeJson(path.join(input.directory, "target.json"), {
    schema: "eliza.provider-canary-operator-target.v1",
    scenarioId: "provider.gmail.confirmed-send",
    kind: "gmail.email-send",
    providerTarget,
  });
  await writeJson(path.join(input.directory, "input.json"), {
    schema: "eliza.provider-canary-operator-input.v1",
    scenarioId: "provider.gmail.confirmed-send",
    kind: "gmail.email-send",
    operationInput,
  });
  await writeJson(path.join(input.directory, "probes.json"), {
    schema: "eliza.provider-canary-operator-probes.v1",
    scenarioId: "provider.gmail.confirmed-send",
    probes,
  });
  await writeJson(
    path.join(input.directory, "bindings.json"),
    gmailBindings({
      authorityKeyId: input.authorityKeyId,
      providerTarget,
      operationInput,
      probes,
    }),
  );
  const plan = JSON.parse(
    await readFile(path.join(input.directory, "plan.json"), "utf8"),
  ) as Record<string, unknown> & { authorization: unknown; execution: unknown };
  plan.authorization = {
    manifestAuthorityKeyId: input.authorityKeyId,
    signerProvider: "offline-ed25519",
  };
  plan.execution = {
    authorizationFile: input.authorizationFile ?? "../authorization.json",
    manifestAuthorityPublicKeyFiles: [
      input.publicKeyFile ?? "../authority.pem",
    ],
    observerPublicKeyFiles: ["../observer.pem"],
    deploymentAttestationIssuerPublicKeyFiles: [
      "../deployment-attestation-issuer.pem",
    ],
    semanticJudgePublicKeyFiles: ["../semantic.pem"],
    releaseTrustPolicyFile: "../release-trust-policy.json",
    operatorModuleFile: "../operator.mjs",
    operatorModuleSha256: hash("operator-module"),
    operatorStateDir: "../state",
    outputDir: "../output",
  };
  await writeJson(path.join(input.directory, "plan.json"), plan);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("provider operator authoring", () => {
  it("publishes four closed JSON schemas, including nested operation objects", () => {
    expect(Array.isArray(PROVIDER_OPERATOR_TARGET_JSON_SCHEMA.oneOf)).toBe(
      true,
    );
    expect(Array.isArray(PROVIDER_OPERATOR_INPUT_JSON_SCHEMA.oneOf)).toBe(true);
    const targetAlternatives =
      PROVIDER_OPERATOR_TARGET_JSON_SCHEMA.oneOf as Array<{
        additionalProperties: boolean;
        properties: { providerTarget: { additionalProperties: boolean } };
      }>;
    expect(targetAlternatives).toHaveLength(13);
    expect(
      targetAlternatives.every((entry) => entry.additionalProperties === false),
    ).toBe(true);
    expect(
      targetAlternatives.every(
        (entry) =>
          entry.properties.providerTarget.additionalProperties === false,
      ),
    ).toBe(true);
    expect(PROVIDER_OPERATOR_PROBES_JSON_SCHEMA).toMatchObject({
      additionalProperties: false,
      properties: { probes: { minItems: 2, maxItems: 2 } },
    });
    expect(PROVIDER_OPERATOR_PLAN_JSON_SCHEMA).toMatchObject({
      additionalProperties: false,
      properties: { authorization: { additionalProperties: false } },
    });
  });

  it("creates private, deliberately non-runnable material and refuses overwrite", async () => {
    const parent = await temporaryDirectory();
    const directory = path.join(parent, "gmail");
    await initializeProviderOperatorDirectory({
      directory,
      scenarioId: "provider.gmail.confirmed-send",
      scenarioDirectory: SCENARIO_DIRECTORY,
    });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const name of [
      "bindings.json",
      "target.json",
      "input.json",
      "probes.json",
      "scenario.json",
      "plan.json",
    ]) {
      const file = path.join(directory, name);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      if (name !== "scenario.json") {
        expect(await readFile(file, "utf8")).toContain("__REPLACE_WITH_");
      }
    }
    await expect(preflightProviderOperatorDirectory(directory)).rejects.toThrow(
      "non-runnable operator placeholder",
    );
    await expect(
      initializeProviderOperatorDirectory({
        directory,
        scenarioId: "provider.gmail.confirmed-send",
        scenarioDirectory: SCENARIO_DIRECTORY,
      }),
    ).rejects.toThrow();
  });

  it("preflights one concrete operation, two probes, and all 13 static snapshots", async () => {
    const parent = await temporaryDirectory();
    const directory = path.join(parent, "gmail");
    await initializeProviderOperatorDirectory({
      directory,
      scenarioId: "provider.gmail.confirmed-send",
      scenarioDirectory: SCENARIO_DIRECTORY,
    });
    const providerTarget = {
      recipientEmail: "operator-recipient@example.test",
    };
    const operationInput = {
      subject: "elizaOS provider canary",
      bodyText: "Gmail provider canary delivery",
      cc: [],
      bcc: [],
    };
    const probes = [
      {
        probeId: "gmail-auth-denied",
        requestPayload: { subject: "denied" },
        expectedErrorCode: "insufficient-scope",
        scope: { account: "operator-canary" },
        authorizationGrant: { grant: "denied" },
      },
      {
        probeId: "gmail-provider-rejected",
        requestPayload: { recipient: "invalid" },
        expectedErrorCode: "invalid-recipient",
        scope: { account: "operator-canary" },
        authorizationGrant: { grant: "send" },
      },
    ];
    await writeJson(path.join(directory, "target.json"), {
      schema: "eliza.provider-canary-operator-target.v1",
      scenarioId: "provider.gmail.confirmed-send",
      kind: "gmail.email-send",
      providerTarget,
    });
    await writeJson(path.join(directory, "input.json"), {
      schema: "eliza.provider-canary-operator-input.v1",
      scenarioId: "provider.gmail.confirmed-send",
      kind: "gmail.email-send",
      operationInput,
    });
    await writeJson(path.join(directory, "probes.json"), {
      schema: "eliza.provider-canary-operator-probes.v1",
      scenarioId: "provider.gmail.confirmed-send",
      probes,
    });
    await writeJson(
      path.join(directory, "bindings.json"),
      gmailBindings({
        authorityKeyId: "a".repeat(64),
        providerTarget,
        operationInput,
        probes,
      }),
    );
    await writeJson(path.join(parent, "authorization.json"), {
      signed: "authorization-placeholder-for-file-shape-test",
    });
    await Promise.all(
      [
        "authority.pem",
        "observer.pem",
        "deployment-attestation-issuer.pem",
        "semantic.pem",
      ].map((name) => writeFile(path.join(parent, name), `public-${name}\n`)),
    );
    await writeJson(path.join(parent, "release-trust-policy.json"), {});
    const operatorModule = Buffer.from(
      "export async function createExternalProviderCanaryCapabilities() { throw new Error('not executed'); }\n",
    );
    await writeFile(path.join(parent, "operator.mjs"), operatorModule);
    await mkdir(path.join(parent, "state"), { mode: 0o700 });
    const operatorModuleSha256 = createHash("sha256")
      .update(operatorModule)
      .digest("hex");
    await writeJson(path.join(directory, "plan.json"), {
      schema: "eliza.provider-canary-operator-plan.v3",
      scenarioId: "provider.gmail.confirmed-send",
      operationKind: "gmail.email-send",
      targetFile: "target.json",
      inputFile: "input.json",
      probesFile: "probes.json",
      bindingsFile: "bindings.json",
      scenarioDefinitionFile: "scenario.json",
      scenarioDirectory: SCENARIO_DIRECTORY,
      authorization: {
        manifestAuthorityKeyId: "a".repeat(64),
        signerProvider: "protected-hsm",
      },
      execution: {
        authorizationFile: "../authorization.json",
        manifestAuthorityPublicKeyFiles: ["../authority.pem"],
        observerPublicKeyFiles: ["../observer.pem"],
        deploymentAttestationIssuerPublicKeyFiles: [
          "../deployment-attestation-issuer.pem",
        ],
        semanticJudgePublicKeyFiles: ["../semantic.pem"],
        releaseTrustPolicyFile: "../release-trust-policy.json",
        operatorModuleFile: "../operator.mjs",
        operatorModuleSha256,
        operatorStateDir: "../state",
        outputDir: "../output",
      },
    });
    const result = await preflightProviderOperatorDirectory(directory);
    expect(result).toMatchObject({
      status: "operator-material-preflight-passed",
      scenarioId: "provider.gmail.confirmed-send",
      operation: { kind: "gmail.email-send" },
    });
    expect(result.probeBindings).toHaveLength(2);
    expect(result.inventory).toHaveLength(13);
    const runDirectory = path.join(parent, "prepared");
    const config = await prepareProviderCanaryRunDirectory({
      authoringDirectory: directory,
      runDirectory,
    });
    expect(config).toMatchObject({
      schema: "eliza.external-provider-canary-config.v3",
      scenarioDefinitionFile: "scenario.json",
      providerTargetFile: "target.json",
      operationInputFile: "input.json",
      failureProbesFile: "probes.json",
    });
    expect(
      JSON.parse(
        await readFile(path.join(runDirectory, "target.json"), "utf8"),
      ),
    ).toEqual({
      recipientEmail: "operator-recipient@example.test",
    });
    expect((await stat(runDirectory)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(runDirectory)) {
      expect((await stat(path.join(runDirectory, name))).mode & 0o777).toBe(
        0o600,
      );
    }
    const plan = JSON.parse(
      await readFile(path.join(directory, "plan.json"), "utf8"),
    ) as { execution: { observerPublicKeyFiles: string[] } };
    plan.execution.observerPublicKeyFiles = ["../missing-observer.pem"];
    await writeJson(path.join(directory, "plan.json"), plan);
    const refusedDirectory = path.join(parent, "refused");
    await expect(
      prepareProviderCanaryRunDirectory({
        authoringDirectory: directory,
        runDirectory: refusedDirectory,
      }),
    ).rejects.toThrow();
    await expect(stat(refusedDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(path.join(parent, ".refused.staging")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await chmod(parent, 0o777);
    await expect(
      prepareProviderCanaryRunDirectory({
        authoringDirectory: directory,
        runDirectory: path.join(parent, "unsafe-parent-run"),
      }),
    ).rejects.toThrow("must not be group- or world-writable");
    await chmod(parent, 0o700);
  });

  it("detects inventory drift without importing scenario modules", async () => {
    const snapshots =
      await preflightProviderCanaryInventory(SCENARIO_DIRECTORY);
    expect(snapshots.map(({ scenarioId }) => scenarioId)).toHaveLength(13);
    expect(
      new Set(snapshots.map(({ operationKind }) => operationKind)).size,
    ).toBe(13);
  });

  it("ratchets all 13 checked-in definitions against the executable catalog", async () => {
    for (const definition of PROVIDER_CANARY_SCENARIOS) {
      const canonical = await canonicalProviderCanaryDefinition(
        definition.id as never,
      );
      const operationKind = providerCanaryControllerContract(
        definition.id,
      ).operationKind;
      expect(
        createProviderCanaryScenarioSnapshot({
          definition: canonical,
          operationKind,
        }),
      ).toEqual(
        createProviderCanaryScenarioSnapshot({ definition, operationKind }),
      );
    }
  });

  it("refuses symlinked private material", async () => {
    const parent = await temporaryDirectory();
    const directory = path.join(parent, "gmail");
    await initializeProviderOperatorDirectory({
      directory,
      scenarioId: "provider.gmail.confirmed-send",
      scenarioDirectory: SCENARIO_DIRECTORY,
    });
    const target = path.join(directory, "target.json");
    const outside = path.join(parent, "outside.json");
    await writeJson(outside, {});
    await unlink(target);
    await symlink(outside, target);
    await expect(preflightProviderOperatorDirectory(directory)).rejects.toThrow(
      "must not use symbolic links",
    );
  });

  it("round-trips exact offline signing bytes and refuses substitution, replay, wrong keys, and symlinks", async () => {
    const parent = await temporaryDirectory();
    const directory = path.join(parent, "gmail");
    const authority = generateKeyPairSync("ed25519");
    const publicKeyPem = authority.publicKey.export({
      type: "spki",
      format: "pem",
    });
    const authorityKeyId = providerObserverKeyId(publicKeyPem);
    await initializeProviderOperatorDirectory({
      directory,
      scenarioId: "provider.gmail.confirmed-send",
      scenarioDirectory: SCENARIO_DIRECTORY,
    });
    await configureGmailAuthoring({ directory, authorityKeyId });
    const publicKeyFile = path.join(parent, "authority.pem");
    await writeFile(publicKeyFile, publicKeyPem, { mode: 0o600 });
    const requestFile = path.join(parent, "signing-request.json");
    const request = await exportProviderManifestSigningRequest({
      authoringDirectory: directory,
      requestFile,
    });
    expect(request.keyId).toBe(authorityKeyId);
    expect((await stat(requestFile)).mode & 0o777).toBe(0o600);
    await expect(
      exportProviderManifestSigningRequest({
        authoringDirectory: directory,
        requestFile,
      }),
    ).rejects.toThrow("already exists");

    const signatureFile = path.join(parent, "signature.bin");
    await writeFile(
      signatureFile,
      sign(
        null,
        Buffer.from(request.signingBytesBase64url, "base64url"),
        authority.privateKey,
      ),
      { mode: 0o600 },
    );
    const authorizationFile = path.join(parent, "authorization.json");

    const substitutedRequestFile = path.join(parent, "substituted.json");
    await writeJson(substitutedRequestFile, {
      ...request,
      manifestSha256: "f".repeat(64),
    });
    await expect(
      importProviderManifestSignature({
        authoringDirectory: directory,
        requestFile: substitutedRequestFile,
        signatureFile,
        publicKeyFile,
        authorizationFile,
      }),
    ).rejects.toThrow();

    const wrongAuthority = generateKeyPairSync("ed25519");
    const wrongPublicKeyFile = path.join(parent, "wrong-authority.pem");
    await writeFile(
      wrongPublicKeyFile,
      wrongAuthority.publicKey.export({ type: "spki", format: "pem" }),
      { mode: 0o600 },
    );
    await expect(
      importProviderManifestSignature({
        authoringDirectory: directory,
        requestFile,
        signatureFile,
        publicKeyFile: wrongPublicKeyFile,
        authorizationFile,
      }),
    ).rejects.toThrow();

    const signatureTarget = path.join(parent, "signature-target.bin");
    await writeFile(signatureTarget, await readFile(signatureFile), {
      mode: 0o600,
    });
    const signatureLink = path.join(parent, "signature-link.bin");
    await symlink(signatureTarget, signatureLink);
    await expect(
      importProviderManifestSignature({
        authoringDirectory: directory,
        requestFile,
        signatureFile: signatureLink,
        publicKeyFile,
        authorizationFile,
      }),
    ).rejects.toThrow("detached signature is unreadable or invalid");

    const bindings = JSON.parse(
      await readFile(path.join(directory, "bindings.json"), "utf8"),
    ) as { runId: string };
    bindings.runId = "replayed-against-another-run";
    await writeJson(path.join(directory, "bindings.json"), bindings);
    await expect(
      importProviderManifestSignature({
        authoringDirectory: directory,
        requestFile,
        signatureFile,
        publicKeyFile,
        authorizationFile,
      }),
    ).rejects.toThrow("does not match current preflighted material");
    bindings.runId = "gmail-operator-run-001";
    await writeJson(path.join(directory, "bindings.json"), bindings);

    let output = "";
    await expect(
      runProviderOperatorCli(
        [
          "import-signature",
          directory,
          requestFile,
          signatureFile,
          publicKeyFile,
          authorizationFile,
        ],
        { stdout: (message) => (output += message) },
      ),
    ).resolves.toBe(0);
    expect(output).toContain("authorization-imported");
    expect((await stat(authorizationFile)).mode & 0o777).toBe(0o600);
    const authorization = JSON.parse(
      await readFile(authorizationFile, "utf8"),
    ) as { manifest: { manifestSha256: string } };
    expect(authorization.manifest.manifestSha256).toBe(request.manifestSha256);
    await expect(
      importProviderManifestSignature({
        authoringDirectory: directory,
        requestFile,
        signatureFile,
        publicKeyFile,
        authorizationFile,
      }),
    ).rejects.toThrow("already exists");
  });

  it("sanitizes invalid private JSON without echoing its path or content", async () => {
    const parent = await temporaryDirectory();
    const directory = path.join(parent, "gmail");
    await initializeProviderOperatorDirectory({
      directory,
      scenarioId: "provider.gmail.confirmed-send",
      scenarioDirectory: SCENARIO_DIRECTORY,
    });
    await writeFile(
      path.join(directory, "target.json"),
      '{"privateToken":"must-not-escape"',
    );
    let message = "";
    try {
      await preflightProviderOperatorDirectory(directory);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("private JSON document is unreadable or invalid");
    expect(message).not.toContain("must-not-escape");
    expect(message).not.toContain(directory);
  });

  it("shows explicit help and rejects credential-shaped CLI flags", async () => {
    let output = "";
    await expect(
      runProviderOperatorCli(["help"], {
        stdout: (message) => {
          output += message;
        },
      }),
    ).resolves.toBe(0);
    expect(output).toContain("init <directory>");
    expect(output).toContain("preflight <directory>");
    expect(output).toContain("never accepts private PEM");
    await expect(
      runProviderOperatorCli([
        "init",
        "private",
        "--scenario",
        "provider.gmail.confirmed-send",
        "--scenarios",
        SCENARIO_DIRECTORY,
        "--private-key",
        "secret.pem",
      ]),
    ).rejects.toThrow("unsupported flag --private-key");
  });
});
