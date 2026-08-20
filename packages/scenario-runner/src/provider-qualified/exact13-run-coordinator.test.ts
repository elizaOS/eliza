/**
 * Exercises exact-13 coordination with filesystem-backed journals and mocked
 * external effects. The system under test owns ordering, resumption, and
 * fail-closed behavior; no test represents mocked receipts as live evidence.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_CANARY_SCENARIO_IDS } from "./canary-catalog.ts";
import {
  EXACT13_PROVIDER_RUN_CONFIG_SCHEMA,
  type PreflightedExact13Canary,
  parseExact13ProviderRunConfig,
  runExact13ProviderCanaries,
  runExact13ProviderCanaryCli,
  validatePinnedOperatorModuleWithoutExecution,
} from "./exact13-run-coordinator.ts";
import { canonicalSha256 } from "./manifest.ts";
import type { ProviderQualificationPublicationCapsule } from "./publication-capsule.ts";
import * as publicationCapsule from "./publication-capsule.ts";
import {
  PROVIDER_QUALIFICATION_ARTIFACT_SCHEMA,
  type ProviderQualificationArtifact,
} from "./qualification-artifact.ts";

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
        semanticJudges: [{}],
      },
      signedObserverEvidence: { payload: { runnerResultSha256: HASH } },
      signedSemanticJudgeEvidence: {},
      trajectoryInventory: { setSha256: HASH },
      runnerResult,
      verifierTranscript: {
        schema: "eliza.provider-qualification-verifier-transcript.v1",
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
    schema: "eliza.provider-qualification-publication.v1",
    publicationSha256: digest(`publication:${item.scenarioId}`),
    createdAtIso: "2026-08-20T00:00:01.000Z",
    scenarioId: item.scenarioId,
    runId: item.runId,
    runNonce: `nonce-${item.runId}`,
    manifestSha256: item.manifestSha256,
    artifactSha256: qualificationArtifact.artifactSha256,
    cleanupScopeSha256: digest(`cleanup:${item.scenarioId}`),
    rawControllerMaterialSha256: digest(`raw:${item.scenarioId}`),
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
  return { plan, configFile, byConfig, publications, stateDir };
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
    expect(
      events.slice(13).every((event) => event.startsWith("execute:")),
    ).toBe(true);
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

  it("does not accept a raw qualification artifact without its cleanup publication", async () => {
    const test = fixture();
    let executions = 0;
    await expect(
      runExact13ProviderCanaries(test.configFile, {
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

  it("rejects repository or deployment drift across signed manifests before ingress", async () => {
    const test = fixture();
    let executions = 0;
    await expect(
      runExact13ProviderCanaries(test.configFile, {
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
