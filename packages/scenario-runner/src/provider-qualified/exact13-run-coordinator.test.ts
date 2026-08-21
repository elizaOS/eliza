/**
 * Exercises exact-13 coordination with filesystem-backed journals and mocked
 * external effects. The system under test owns ordering, resumption, and
 * fail-closed behavior; no test represents mocked receipts as live evidence.
 */

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_CANARY_SCENARIO_IDS } from "./canary-catalog.ts";
import {
  EXACT13_PROVIDER_RUN_CONFIG_SCHEMA,
  inspectExact13Recovery,
  type PreflightedExact13Canary,
  parseExact13ProviderRunConfig,
  reconcileExact13Recovery,
  resolvePhysicalContainedPreparedFile,
  runExact13ProviderCanaries,
  runExact13ProviderCanaryCli,
  validatePinnedOperatorModuleWithoutExecution,
} from "./exact13-run-coordinator.ts";
import { canonicalJsonValue, canonicalSha256 } from "./manifest.ts";
import {
  createProviderRunReconciliationPayload,
  providerRunReconciliationSigningBytes,
} from "./provider-run-reconciliation.ts";
import type { ProviderQualificationPublicationCapsule } from "./publication-capsule.ts";
import * as publicationCapsule from "./publication-capsule.ts";
import { providerObserverKeyId } from "./qualification.ts";
import {
  PROVIDER_QUALIFICATION_ARTIFACT_SCHEMA,
  type ProviderQualificationArtifact,
} from "./qualification-artifact.ts";
import type { ProviderQualificationReleaseTrustPolicy } from "./release-trust-policy.ts";

const REPOSITORY_SHA = "a".repeat(40);
const DEPLOYMENT_SHA = "b".repeat(64);
const HASH = "c".repeat(64);
let root: string;
let reverifyPublication: ReturnType<typeof vi.spyOn>;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredMapValue<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error("test fixture lookup failed");
  return value;
}

function artifact(
  item: PreflightedExact13Canary,
): ProviderQualificationArtifact {
  const runnerResult = {
    scenarioStatus: "passed" as const,
    finalChecks: [],
    runnerResultSha256: HASH,
  };
  const core = {
    schema: PROVIDER_QUALIFICATION_ARTIFACT_SCHEMA,
    createdAtIso: "2026-08-20T00:00:00.000Z",
    scenarioId: item.scenarioId,
    runId: item.runId,
    repositorySha: REPOSITORY_SHA,
    deploymentSha: DEPLOYMENT_SHA,
    manifestSha256: item.manifestSha256,
    trajectorySetSha256: HASH,
    runnerResultSha256: HASH,
    observerEvidenceSha256: HASH,
    semanticEvidenceSha256: HASH,
    decision: {
      manifestSha256: item.manifestSha256,
      qualification: {
        status: "qualified" as const,
        publishable: true as const,
        reasons: [] as const,
      },
      matchedObservationContracts: [],
      guarantees: {
        providerAuthorizationVerified: true,
        providerFailurePathsVerified: true,
        providerAcceptanceVerified: true,
        providerReadbackVerified: true,
        providerIdempotencyVerified: true,
        exactlyOnce: false as const,
      },
    },
    reverification: {
      scenarioDefinition: {},
      manifest: { manifestSha256: item.manifestSha256 },
      manifestSignature: {},
      publicKeyPins: {
        manifestAuthorities: [{}],
        providerObservers: [{}],
        deploymentAttestationIssuers: [{}],
        semanticJudges: [{}],
      },
      signedObserverEvidence: { payload: { runnerResultSha256: HASH } },
      signedSemanticJudgeEvidence: {},
      trajectoryInventory: { setSha256: HASH },
      runnerResult,
      verifierTranscript: {
        schema: "eliza.provider-qualification-verifier-transcript.v2",
        implementation: "@elizaos/scenario-runner/provider-qualification",
        verifiedAtIso: "2026-08-20T00:00:00.000Z",
        verificationOptions: {},
        sourcePrivacy: {},
        inventory: {},
        proofDigests: {},
      },
    },
    qualifiedReport: { scenarioId: item.scenarioId },
  };
  return {
    ...core,
    artifactSha256: canonicalSha256(core, "providerQualificationArtifact"),
  } as unknown as ProviderQualificationArtifact;
}

function publication(
  item: PreflightedExact13Canary,
): ProviderQualificationPublicationCapsule {
  const qualificationArtifact = artifact(item);
  return {
    schema: "eliza.provider-qualification-publication.v2",
    publicationSha256: digest(`publication:${item.scenarioId}`),
    createdAtIso: "2026-08-20T00:00:01.000Z",
    scenarioId: item.scenarioId,
    runId: item.runId,
    runNonce: `nonce-${item.runId}`,
    manifestSha256: item.manifestSha256,
    artifactSha256: qualificationArtifact.artifactSha256,
    cleanupScopeSha256: digest(`cleanup:${item.scenarioId}`),
    rawControllerMaterialSha256: digest(`raw:${item.scenarioId}`),
    observerDeploymentAttestationSha256: digest(
      `attestation:${item.scenarioId}`,
    ),
    cleanupProofSha256: digest(`proof:${item.scenarioId}`),
    cleanupSignerPin: {
      keyId: digest(`key:${item.scenarioId}`),
      algorithm: "ed25519",
      spkiPem: "test-only-public-key",
    },
    cleanupProof: {} as ProviderQualificationPublicationCapsule["cleanupProof"],
    qualificationArtifact,
  };
}

function fixture(withMatrixHandoff = false) {
  const stateDir = path.join(root, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const referenceOperatorConfigFile = path.join(root, "reference.json");
  writeFileSync(referenceOperatorConfigFile, '{"test":true}\n', {
    mode: 0o600,
  });
  const plan = PROVIDER_CANARY_SCENARIO_IDS.map((scenarioId, index) => {
    const prepared = path.join(root, `prepared-${index + 1}`);
    mkdirSync(prepared, { mode: 0o700 });
    return {
      scenarioId,
      configFile: path.join(prepared, "config.json"),
      configSha256: digest(`config:${scenarioId}`),
      manifestSha256: digest(`manifest:${scenarioId}`),
      runId: `run-${index + 1}`,
      repositorySha: REPOSITORY_SHA,
      deploymentSha: DEPLOYMENT_SHA,
      accountRefSha256: digest(`account:${scenarioId}`),
      principalRefSha256: digest(`principal:${scenarioId}`),
      roomRefSha256: digest(`room:${scenarioId}`),
      operatorStateDir: path.join(root, `operator-state-${index + 1}`),
      outputDir: path.join(root, `output-${index + 1}`),
    } satisfies PreflightedExact13Canary;
  });
  const configFile = path.join(root, "coordinator.json");
  writeFileSync(
    configFile,
    `${JSON.stringify({
      schema: EXACT13_PROVIDER_RUN_CONFIG_SCHEMA,
      preparedConfigFiles: plan.map(({ configFile: file }) => file),
      coordinatorStateDir: stateDir,
      expectedRepositorySha: REPOSITORY_SHA,
      referenceOperatorConfigFile,
      releaseTrustPolicyFile: path.join(root, "release-trust-policy.json"),
      catalogOutputDir: path.join(root, "catalog"),
      ...(withMatrixHandoff
        ? {
            matrixHandoff: {
              publicationOutputDir: path.join(root, "matrix-publication"),
              outputDir: path.join(root, "matrix-handoff"),
            },
          }
        : {}),
    })}\n`,
    { mode: 0o600 },
  );
  const byConfig = new Map(plan.map((item) => [item.configFile, item]));
  const publications = new Map<
    string,
    ProviderQualificationPublicationCapsule
  >();
  const inspectReadiness = async () => {
    const exact13ConfigSha256 = createHash("sha256")
      .update(readFileSync(configFile))
      .digest("hex");
    const referenceOperatorConfigSha256 = createHash("sha256")
      .update(readFileSync(referenceOperatorConfigFile))
      .digest("hex");
    const releaseTrustPolicySha256 = digest("release-policy");
    const canaries = plan.map((item) => ({
      scenarioId: item.scenarioId,
      operationKind: "test-operation",
      controllerFamily: "messaging",
      status: "ready" as const,
      preparedConfigSha256: item.configSha256,
      manifestSha256: item.manifestSha256,
      accountRefSha256: item.accountRefSha256,
      principalRefSha256: item.principalRefSha256,
      roomRefSha256: item.roomRefSha256,
      checks: [
        {
          code: "test-complete-audit",
          status: "ready" as const,
          detail: "The injected deterministic audit completed.",
        },
      ],
    }));
    const readinessInputSha256 = canonicalSha256(
      canonicalJsonValue(
        {
          exact13ConfigSha256,
          referenceOperatorConfigSha256,
          releaseTrustPolicyFileSha256: releaseTrustPolicySha256,
          releaseTrustPolicySha256,
          expectedRepositorySha: REPOSITORY_SHA,
          canaries: canaries.map(
            ({
              scenarioId,
              preparedConfigSha256,
              manifestSha256,
              accountRefSha256,
              principalRefSha256,
              roomRefSha256,
            }) => ({
              scenarioId,
              preparedConfigSha256,
              manifestSha256,
              accountRefSha256,
              principalRefSha256,
              roomRefSha256,
            }),
          ),
        },
        "providerReadinessInput",
      ),
      "providerReadinessInput",
    );
    return {
      schema: "eliza.provider-canary-readiness-report.v2" as const,
      status: "ready" as const,
      generatedAtIso: "2026-08-20T00:00:00.000Z",
      evidenceClaimed: false as const,
      providerContacted: false as const,
      secretValuesLoaded: false as const,
      expectedRepositorySha: REPOSITORY_SHA,
      deploymentSha: DEPLOYMENT_SHA,
      exact13ConfigSha256,
      referenceOperatorConfigSha256,
      releaseTrustPolicyFileSha256: releaseTrustPolicySha256,
      releaseTrustPolicySha256,
      readinessInputSha256,
      summary: { ready: 13, missing: 0, invalid: 0 },
      canaries,
    };
  };
  const loadReleaseTrustPolicy =
    (): ProviderQualificationReleaseTrustPolicy => {
      const authority = {
        keyId: digest("authority-policy-key"),
        algorithm: "ed25519" as const,
        spkiPem: "test-only-authority-public-key",
      };
      const observer = {
        keyId: digest("observer-policy-key"),
        algorithm: "ed25519" as const,
        spkiPem: "test-only-observer-public-key",
      };
      const judge = {
        keyId: digest("judge-policy-key"),
        algorithm: "ed25519" as const,
        spkiPem: "test-only-judge-public-key",
      };
      const deploymentAttestationIssuer = {
        keyId: digest("deployment-attestation-policy-key"),
        algorithm: "ed25519" as const,
        spkiPem: "test-only-deployment-attestation-public-key",
      };
      return {
        schema: "eliza.provider-qualification-release-trust-policy.v2",
        policySha256: digest("release-policy"),
        releaseId: "test-release",
        repositorySha: REPOSITORY_SHA,
        deploymentSha: DEPLOYMENT_SHA,
        organizations: {
          manifestAuthority: {
            organizationId: "test-authority.example",
            keys: [authority],
          },
          providerObserver: {
            organizationId: "test-observer.example",
            keys: [observer],
            allowedWorkloadSha256s: [digest("test-workload")],
            allowedStatementSha256s: [digest("test-statement")],
          },
          deploymentAttestationIssuer: {
            organizationId: "test-deployment-attestation.example",
            keys: [deploymentAttestationIssuer],
          },
          semanticJudge: {
            organizationId: "test-judge.example",
            keys: [judge],
          },
          cleanup: {
            organizationId: "test-observer.example",
            keys: [observer],
          },
        },
      };
    };
  return {
    plan,
    configFile,
    byConfig,
    publications,
    stateDir,
    inspectReadiness,
    loadReleaseTrustPolicy,
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "exact13-coordinator-"));
  chmodSync(root, 0o700);
  reverifyPublication = vi.spyOn(
    publicationCapsule,
    "reverifyProviderQualificationPublication",
  );
  reverifyPublication.mockImplementation((value: unknown) => {
    if (value === undefined) throw new Error("publication capsule missing");
    return value as ProviderQualificationPublicationCapsule;
  });
});

afterEach(() => {
  reverifyPublication.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

describe("exact-13 provider canary coordinator", () => {
  it("validates the pinned capability export without evaluating module code", () => {
    const valid = path.join(root, "valid-operator.mjs");
    const source =
      'throw new Error("module evaluation is forbidden during preflight");\nexport function createExternalProviderCanaryCapabilities() {}\n';
    writeFileSync(valid, source, { mode: 0o600 });
    expect(() =>
      validatePinnedOperatorModuleWithoutExecution(valid, digest(source)),
    ).not.toThrow();

    const invalid = path.join(root, "invalid-operator.mjs");
    const invalidSource = "export const wrongFactory = true;\n";
    writeFileSync(invalid, invalidSource, { mode: 0o600 });
    expect(() =>
      validatePinnedOperatorModuleWithoutExecution(
        invalid,
        digest(invalidSource),
      ),
    ).toThrow(/non-executing syntax\/export validation/);
  });

  it("rejects an intermediate prepared-file symlink escape", () => {
    const prepared = path.join(root, "prepared");
    const outside = path.join(root, "outside");
    mkdirSync(prepared, { mode: 0o700 });
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(path.join(outside, "authorization.json"), "{}\n", {
      mode: 0o600,
    });
    symlinkSync(outside, path.join(prepared, "nested"));
    expect(() =>
      resolvePhysicalContainedPreparedFile(
        prepared,
        "nested/authorization.json",
        "authorization",
      ),
    ).toThrow(/remain inside/);
  });

  it.each([
    'export function createExternalProviderCanaryCapabilities() { return import("node:fs"); }\n',
    'import { createRequire } from "node:module";\nexport function createExternalProviderCanaryCapabilities() { return createRequire(import.meta.url); }\n',
    'export function createExternalProviderCanaryCapabilities() { return require("node:fs"); }\n',
  ])(
    "rejects runtime loading during non-executing module inspection",
    (source) => {
      const file = path.join(root, `loader-${digest(source)}.mjs`);
      writeFileSync(file, source, { mode: 0o600 });
      expect(() =>
        validatePinnedOperatorModuleWithoutExecution(file, digest(source)),
      ).toThrow(/forbidden/);
    },
  );

  it("exposes help without reading an operator config", async () => {
    const output = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await expect(runExact13ProviderCanaryCli(["--help"])).resolves.toBe(0);
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining("canonical order"),
    );
    output.mockRestore();
  });

  it("accepts only a closed config containing exactly 13 unique prepared runs", () => {
    const value = {
      schema: EXACT13_PROVIDER_RUN_CONFIG_SCHEMA,
      preparedConfigFiles: PROVIDER_CANARY_SCENARIO_IDS.map(
        (id) => `${id}.json`,
      ),
      coordinatorStateDir: "state",
      expectedRepositorySha: REPOSITORY_SHA,
      referenceOperatorConfigFile: "reference.json",
      releaseTrustPolicyFile: "release-trust-policy.json",
      catalogOutputDir: "catalog",
    };
    expect(parseExact13ProviderRunConfig(value)).toEqual(value);
    expect(() =>
      parseExact13ProviderRunConfig({
        ...value,
        preparedConfigFiles: value.preparedConfigFiles.slice(0, -1),
      }),
    ).toThrow(/exactly 13/);
    expect(() =>
      parseExact13ProviderRunConfig({ ...value, autoRetry: true }),
    ).toThrow(/unknown=autoRetry/);
  });

  it("preflights every config before ingress and publishes one canonical catalog", async () => {
    const test = fixture(true);
    const events: string[] = [];
    const dependencies = {
      inspectReadiness: test.inspectReadiness,
      loadReleaseTrustPolicy: test.loadReleaseTrustPolicy,
      async preflightPreparedConfig(file: string) {
        events.push(`preflight:${file}`);
        return requiredMapValue(test.byConfig, file);
      },
      async executeCanary(file: string) {
        events.push(`execute:${file}`);
        const item = requiredMapValue(test.byConfig, file);
        mkdirSync(item.outputDir, { mode: 0o700 });
        test.publications.set(
          path.join(item.outputDir, "publication.json"),
          publication(item),
        );
        return 0;
      },
      readPublication(file: string) {
        return requiredMapValue(test.publications, file);
      },
      now: () => new Date("2026-08-20T00:00:02.000Z"),
    };
    const result = await runExact13ProviderCanaries(
      test.configFile,
      dependencies,
    );
    expect(result).toMatchObject({ status: "complete", qualifiedCount: 13 });
    expect(
      events.slice(0, 13).every((event) => event.startsWith("preflight:")),
    ).toBe(true);
    expect(events.slice(13)).toEqual(
      test.plan.flatMap(({ configFile: file }) => [
        `preflight:${file}`,
        `execute:${file}`,
      ]),
    );
    const catalog = JSON.parse(
      readFileSync(path.join(root, "catalog", "catalog.json"), "utf8"),
    );
    expect(
      catalog.publications.map(
        (entry: { scenarioId: string }) => entry.scenarioId,
      ),
    ).toEqual(PROVIDER_CANARY_SCENARIO_IDS);
    const matrix = JSON.parse(
      readFileSync(
        path.join(root, "matrix-handoff", "matrix-producer.json"),
        "utf8",
      ),
    );
    expect(matrix).toMatchObject({
      schema: "eliza.provider-qualification-matrix-producer-config.v2",
      publicationFiles: test.plan.map(({ outputDir }) =>
        path.join(outputDir, "publication.json"),
      ),
    });
    const executionCount = events.filter((event) =>
      event.startsWith("execute:"),
    ).length;
    await expect(
      runExact13ProviderCanaries(test.configFile, dependencies),
    ).resolves.toMatchObject({ status: "complete", qualifiedCount: 13 });
    expect(events.filter((event) => event.startsWith("execute:")).length).toBe(
      executionCount,
    );
  });

  it("pauses only between canaries and resumes without repeating a qualified effect", async () => {
    const test = fixture();
    const controller = new AbortController();
    const calls: string[] = [];
    const dependencies = {
      inspectReadiness: test.inspectReadiness,
      loadReleaseTrustPolicy: test.loadReleaseTrustPolicy,
      async preflightPreparedConfig(file: string) {
        return requiredMapValue(test.byConfig, file);
      },
      async executeCanary(file: string) {
        calls.push(file);
        const item = requiredMapValue(test.byConfig, file);
        mkdirSync(item.outputDir, { mode: 0o700 });
        test.publications.set(
          path.join(item.outputDir, "publication.json"),
          publication(item),
        );
        if (calls.length === 1) controller.abort();
        return 0;
      },
      readPublication(file: string) {
        return requiredMapValue(test.publications, file);
      },
    };
    await expect(
      runExact13ProviderCanaries(test.configFile, {
        ...dependencies,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ status: "paused", qualifiedCount: 1 });
    await expect(
      runExact13ProviderCanaries(test.configFile, dependencies),
    ).resolves.toMatchObject({ status: "complete", qualifiedCount: 13 });
    expect(calls).toHaveLength(13);
    expect(
      calls.filter((file) => file === test.plan[0].configFile),
    ).toHaveLength(1);
  });

  it("durably stops the entire set on an ambiguous effect and never retries it", async () => {
    const test = fixture();
    const calls: string[] = [];
    const dependencies = {
      inspectReadiness: test.inspectReadiness,
      loadReleaseTrustPolicy: test.loadReleaseTrustPolicy,
      async preflightPreparedConfig(file: string) {
        return requiredMapValue(test.byConfig, file);
      },
      async executeCanary(file: string) {
        calls.push(file);
        const item = requiredMapValue(test.byConfig, file);
        if (item === test.plan[2]) throw new Error("ambiguous provider result");
        mkdirSync(item.outputDir, { mode: 0o700 });
        test.publications.set(
          path.join(item.outputDir, "publication.json"),
          publication(item),
        );
        return 0;
      },
      readPublication(file: string) {
        return requiredMapValue(test.publications, file);
      },
    };
    await expect(
      runExact13ProviderCanaries(test.configFile, dependencies),
    ).rejects.toThrow(/ambiguous provider result/);
    expect(calls).toHaveLength(3);
    await expect(
      runExact13ProviderCanaries(test.configFile, dependencies),
    ).rejects.toThrow(/manual reconciliation/);
    expect(calls).toHaveLength(3);
    const journalFile = readdirSync(test.stateDir).find((name) =>
      name.endsWith(".journal.json"),
    );
    if (!journalFile) throw new Error("test journal was not written");
    const journal = JSON.parse(
      readFileSync(path.join(test.stateDir, journalFile), "utf8"),
    );
    expect(journal.status).toBe("reconciliation-required");
    expect(journal.entries[2].status).toBe("reconciliation-required");
  });

  it("adopts a child publication after a consumed crash without replaying ingress", async () => {
    const test = fixture();
    const calls: string[] = [];
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const spkiPem = publicKey.export({ type: "spki", format: "pem" });
    const keyId = providerObserverKeyId(spkiPem);
    const policy = test.loadReleaseTrustPolicy();
    const recoveryPolicy: ProviderQualificationReleaseTrustPolicy = {
      ...policy,
      organizations: {
        ...policy.organizations,
        manifestAuthority: {
          ...policy.organizations.manifestAuthority,
          keys: [{ keyId, algorithm: "ed25519", spkiPem }],
        },
      },
    };
    const common = {
      inspectReadiness: test.inspectReadiness,
      loadReleaseTrustPolicy: () => recoveryPolicy,
      async preflightPreparedConfig(file: string) {
        return requiredMapValue(test.byConfig, file);
      },
      readPublication(file: string) {
        return requiredMapValue(test.publications, file);
      },
    };
    await expect(
      runExact13ProviderCanaries(test.configFile, {
        ...common,
        async executeCanary(file: string) {
          calls.push(file);
          const item = requiredMapValue(test.byConfig, file);
          mkdirSync(item.outputDir, { mode: 0o700 });
          test.publications.set(
            path.join(item.outputDir, "publication.json"),
            publication(item),
          );
          if (item === test.plan[2]) {
            throw new Error("crash after child publication commit");
          }
          return 0;
        },
      }),
    ).rejects.toThrow(/crash after child publication commit/);
    expect(calls).toHaveLength(3);

    const child = test.plan[2];
    mkdirSync(child.operatorStateDir, { mode: 0o700 });
    writeFileSync(
      path.join(child.operatorStateDir, `${child.manifestSha256}.journal.json`),
      '{"synthetic":"child journal existence proof"}\n',
      { mode: 0o600 },
    );
    const recoveryDependencies = {
      preflightPreparedConfig: common.preflightPreparedConfig,
      loadReleaseTrustPolicy: () => recoveryPolicy,
      readPublication: common.readPublication,
      inspectChildRecovery: () => ({
        journalKind: "external-canary" as const,
        manifestSha256: child.manifestSha256,
        scenarioId: child.scenarioId,
        runId: child.runId,
        status: "recovered" as const,
        phase: "publication-committed" as const,
        effectDisposition: "complete" as const,
        journalSha256: digest("child-journal"),
        requiredAction: "none" as const,
      }),
    };
    const inspection = await inspectExact13Recovery(
      test.configFile,
      recoveryDependencies,
    );
    expect(inspection).toMatchObject({
      scenarioId: child.scenarioId,
      requiredAction: "recover-staged-publication",
      publicationSha256: publication(child).publicationSha256,
      effectDisposition: "ambiguous-effect",
    });
    const reconciliationNow = new Date();
    const issuedAtIso = new Date(
      reconciliationNow.getTime() - 60_000,
    ).toISOString();
    const payload = createProviderRunReconciliationPayload({
      journalKind: "exact13",
      journalSha256: inspection.journalSha256,
      targetSha256: inspection.planSha256,
      action: "recover-staged-publication",
      issuedAtIso,
      expiresAtIso: new Date(
        reconciliationNow.getTime() + 10 * 60_000,
      ).toISOString(),
      nonce: "exact13-adoption-reconciliation-001",
    });
    const signedFile = path.join(root, "signed-reconciliation.json");
    writeFileSync(
      signedFile,
      `${JSON.stringify({
        payload,
        signer: { keyId, algorithm: "ed25519" },
        signature: sign(
          null,
          providerRunReconciliationSigningBytes(payload),
          privateKey,
        ).toString("base64url"),
      })}\n`,
      { mode: 0o600 },
    );
    await expect(
      reconcileExact13Recovery({
        configFile: test.configFile,
        signedReconciliationFile: signedFile,
        now: reconciliationNow,
        dependencies: recoveryDependencies,
      }),
    ).resolves.toMatchObject({
      status: "adopted",
      scenarioId: child.scenarioId,
    });

    const resumedResult = await runExact13ProviderCanaries(test.configFile, {
      ...common,
      async executeCanary(file: string) {
        calls.push(file);
        const item = requiredMapValue(test.byConfig, file);
        mkdirSync(item.outputDir, { mode: 0o700 });
        test.publications.set(
          path.join(item.outputDir, "publication.json"),
          publication(item),
        );
        return 0;
      },
    });
    expect(resumedResult).toMatchObject({
      status: "complete",
      qualifiedCount: 13,
    });
    expect(calls).toHaveLength(13);
    expect(calls.filter((file) => file === child.configFile)).toHaveLength(1);
  });

  it("does not accept a raw qualification artifact without its cleanup publication", async () => {
    const test = fixture();
    let executions = 0;
    await expect(
      runExact13ProviderCanaries(test.configFile, {
        inspectReadiness: test.inspectReadiness,
        loadReleaseTrustPolicy: test.loadReleaseTrustPolicy,
        async preflightPreparedConfig(file) {
          return requiredMapValue(test.byConfig, file);
        },
        async executeCanary() {
          executions += 1;
          return 0;
        },
        readPublication() {
          return undefined;
        },
      }),
    ).rejects.toThrow(/publication capsule missing/);
    expect(executions).toBe(1);
    await expect(
      runExact13ProviderCanaries(test.configFile, {
        inspectReadiness: test.inspectReadiness,
        loadReleaseTrustPolicy: test.loadReleaseTrustPolicy,
        async preflightPreparedConfig(file) {
          return requiredMapValue(test.byConfig, file);
        },
        async executeCanary() {
          executions += 1;
          return 0;
        },
      }),
    ).rejects.toThrow(/manual reconciliation/);
    expect(executions).toBe(1);
  });

  it("does not start ingress when the final prepared config fails preflight", async () => {
    const test = fixture();
    let executions = 0;
    await expect(
      runExact13ProviderCanaries(test.configFile, {
        inspectReadiness: test.inspectReadiness,
        loadReleaseTrustPolicy: test.loadReleaseTrustPolicy,
        async preflightPreparedConfig(file) {
          const item = requiredMapValue(test.byConfig, file);
          if (item === test.plan[12]) throw new Error("invalid final snapshot");
          return item;
        },
        async executeCanary() {
          executions += 1;
          return 0;
        },
      }),
    ).rejects.toThrow(/invalid final snapshot/);
    expect(executions).toBe(0);
  });

  it("rejects a substituted or stale readiness binding before ingress", async () => {
    const test = fixture();
    let executions = 0;
    await expect(
      runExact13ProviderCanaries(test.configFile, {
        loadReleaseTrustPolicy: test.loadReleaseTrustPolicy,
        async preflightPreparedConfig(file) {
          return requiredMapValue(test.byConfig, file);
        },
        async inspectReadiness() {
          const report = await test.inspectReadiness();
          return {
            ...report,
            canaries: report.canaries.map((row, index) =>
              index === 12
                ? { ...row, preparedConfigSha256: "f".repeat(64) }
                : row,
            ),
          };
        },
        async executeCanary() {
          executions += 1;
          return 0;
        },
      }),
    ).rejects.toThrow(/stale|substituted|input files changed/);
    expect(executions).toBe(0);
  });

  it("rejects reference deployment inventory drift after its readiness read", async () => {
    const test = fixture();
    let executions = 0;
    await expect(
      runExact13ProviderCanaries(test.configFile, {
        loadReleaseTrustPolicy: test.loadReleaseTrustPolicy,
        async preflightPreparedConfig(file) {
          return requiredMapValue(test.byConfig, file);
        },
        async inspectReadiness() {
          const report = await test.inspectReadiness();
          writeFileSync(
            path.join(root, "reference.json"),
            '{"changed":true}\n',
            {
              mode: 0o600,
            },
          );
          return report;
        },
        async executeCanary() {
          executions += 1;
          return 0;
        },
      }),
    ).rejects.toThrow(/input files changed/);
    expect(executions).toBe(0);
  });

  it("rejects release-policy substitution after readiness and before ingress", async () => {
    const test = fixture();
    let policyReads = 0;
    let executions = 0;
    await expect(
      runExact13ProviderCanaries(test.configFile, {
        inspectReadiness: test.inspectReadiness,
        loadReleaseTrustPolicy() {
          policyReads += 1;
          const policy = test.loadReleaseTrustPolicy();
          return policyReads === 1
            ? policy
            : { ...policy, policySha256: digest("substituted-policy") };
        },
        async preflightPreparedConfig(file) {
          return requiredMapValue(test.byConfig, file);
        },
        async executeCanary() {
          executions += 1;
          return 0;
        },
      }),
    ).rejects.toThrow(/release trust policy changed/);
    expect(executions).toBe(0);
  });

  it("repreflights the prepared canary immediately before its effect", async () => {
    const test = fixture();
    let preflightReads = 0;
    let executions = 0;
    await expect(
      runExact13ProviderCanaries(test.configFile, {
        inspectReadiness: test.inspectReadiness,
        loadReleaseTrustPolicy: test.loadReleaseTrustPolicy,
        async preflightPreparedConfig(file) {
          preflightReads += 1;
          const item = requiredMapValue(test.byConfig, file);
          return preflightReads === 14
            ? { ...item, configSha256: digest("substituted-config") }
            : item;
        },
        async executeCanary() {
          executions += 1;
          return 0;
        },
      }),
    ).rejects.toThrow(/prepared canary changed/);
    expect(executions).toBe(0);
  });

  it("rejects duplicate provider account, principal, or room bindings before ingress", async () => {
    const test = fixture();
    let executions = 0;
    await expect(
      runExact13ProviderCanaries(test.configFile, {
        inspectReadiness: test.inspectReadiness,
        loadReleaseTrustPolicy: test.loadReleaseTrustPolicy,
        async preflightPreparedConfig(file) {
          const item = requiredMapValue(test.byConfig, file);
          return item === test.plan[12]
            ? { ...item, accountRefSha256: test.plan[0].accountRefSha256 }
            : item;
        },
        async executeCanary() {
          executions += 1;
          return 0;
        },
      }),
    ).rejects.toThrow(/isolated provider account/);
    expect(executions).toBe(0);
  });

  it("rejects a release trust policy for another deployment before ingress", async () => {
    const test = fixture();
    let executions = 0;
    await expect(
      runExact13ProviderCanaries(test.configFile, {
        inspectReadiness: test.inspectReadiness,
        loadReleaseTrustPolicy() {
          return {
            ...test.loadReleaseTrustPolicy(),
            deploymentSha: "e".repeat(64),
          };
        },
        async preflightPreparedConfig(file) {
          return requiredMapValue(test.byConfig, file);
        },
        async executeCanary() {
          executions += 1;
          return 0;
        },
      }),
    ).rejects.toThrow(/release trust policy/);
    expect(executions).toBe(0);
  });

  it("rejects repository or deployment drift across signed manifests before ingress", async () => {
    const test = fixture();
    let executions = 0;
    await expect(
      runExact13ProviderCanaries(test.configFile, {
        inspectReadiness: test.inspectReadiness,
        loadReleaseTrustPolicy: test.loadReleaseTrustPolicy,
        async preflightPreparedConfig(file) {
          const item = requiredMapValue(test.byConfig, file);
          return item === test.plan[12]
            ? { ...item, deploymentSha: "d".repeat(64) }
            : item;
        },
        async executeCanary() {
          executions += 1;
          return 0;
        },
      }),
    ).rejects.toThrow(/one deployment revision/);
    expect(executions).toBe(0);
  });
});
