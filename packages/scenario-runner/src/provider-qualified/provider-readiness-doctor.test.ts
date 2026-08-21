/**
 * Exercises the offline readiness doctor with missing, malformed, and
 * secret-looking operator inputs; no provider or signer service is contacted.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROVIDER_CANARY_SCENARIO_IDS } from "./canary-catalog.ts";
import { EXACT13_PROVIDER_RUN_CONFIG_SCHEMA } from "./exact13-run-coordinator.ts";
import { EXTERNAL_PROVIDER_CANARY_CONFIG_SCHEMA } from "./external-canary-cli.ts";
import { runProviderReadinessCli } from "./provider-readiness-cli.ts";
import {
  inspectExact13ProviderReadiness,
  providerReadinessReportSha256,
  releasePolicyAuthorizesPreparedObserverAttestation,
  renderProviderReadinessMarkdown,
  writeProviderReadinessReport,
} from "./provider-readiness-doctor.ts";
import { providerDeploymentWorkloadSha256 } from "./qualification.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "provider-readiness-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function missingMaterialFixture(): Promise<{
  root: string;
  exact13: string;
  reference: string;
}> {
  const root = await temporaryDirectory();
  const exact13 = path.join(root, "exact13.json");
  const reference = path.join(root, "private-reference-config.json");
  await writeFile(
    exact13,
    `${JSON.stringify({
      schema: EXACT13_PROVIDER_RUN_CONFIG_SCHEMA,
      preparedConfigFiles: PROVIDER_CANARY_SCENARIO_IDS.map(
        (scenarioId) => `prepared/${scenarioId}/config.json`,
      ),
      coordinatorStateDir: path.join(root, "coordinator-state"),
      expectedRepositorySha: "a".repeat(40),
      referenceOperatorConfigFile: reference,
      releaseTrustPolicyFile: path.join(root, "release-trust-policy.json"),
      catalogOutputDir: path.join(root, "catalog"),
    })}\n`,
    { mode: 0o600 },
  );
  return { root, exact13, reference };
}

describe("provider readiness doctor", () => {
  it("requires the exact workload and reviewed attestation statement before ingress", () => {
    const repositorySha = "a".repeat(40);
    const deploymentSha = "b".repeat(64);
    const statementSha256 = "c".repeat(64);
    const workloadSha256 = providerDeploymentWorkloadSha256({
      repositorySha,
      deploymentSha,
    });
    const base = {
      repositorySha,
      deploymentSha,
      expectedStatementSha256: statementSha256,
      allowedWorkloadSha256s: [workloadSha256],
      allowedStatementSha256s: [statementSha256],
    };
    expect(releasePolicyAuthorizesPreparedObserverAttestation(base)).toBe(true);
    expect(
      releasePolicyAuthorizesPreparedObserverAttestation({
        ...base,
        allowedWorkloadSha256s: ["d".repeat(64)],
      }),
    ).toBe(false);
    expect(
      releasePolicyAuthorizesPreparedObserverAttestation({
        ...base,
        allowedStatementSha256s: ["e".repeat(64)],
      }),
    ).toBe(false);
  });

  it("reports all missing prerequisites without provider contact or healthy placeholders", async () => {
    const fixture = await missingMaterialFixture();
    const report = await inspectExact13ProviderReadiness({
      exact13ConfigFile: fixture.exact13,
      referenceOperatorConfigFile: fixture.reference,
      now: new Date("2026-08-20T12:00:00.000Z"),
    });
    expect(report).toMatchObject({
      status: "missing",
      evidenceClaimed: false,
      providerContacted: false,
      secretValuesLoaded: false,
      summary: { ready: 0, missing: 13, invalid: 0 },
    });
    expect(report.canaries).toHaveLength(13);
    expect(
      report.canaries.every(
        (row) =>
          row.status === "missing" &&
          row.checks.some(
            ({ code, status }) =>
              code === "prepared-authorization" && status === "missing",
          ) &&
          row.checks.some(
            ({ code, status }) =>
              code === "deployment-inventory" && status === "missing",
          ),
      ),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain(fixture.reference);
    expect(JSON.stringify(report)).not.toContain("__REPLACE_WITH_");
  });

  it("fails the top-level plan closed instead of manufacturing 13 empty rows", async () => {
    const root = await temporaryDirectory();
    const file = path.join(root, "invalid.json");
    await writeFile(file, '{"schema":"wrong","preparedConfigFiles":[]}\n', {
      mode: 0o600,
    });
    await expect(
      inspectExact13ProviderReadiness({
        exact13ConfigFile: file,
        referenceOperatorConfigFile: path.join(root, "missing.json"),
      }),
    ).rejects.toThrow("could not validate the exact-13 plan");
  });

  it("writes canonical private reports atomically and refuses overwrite", async () => {
    const fixture = await missingMaterialFixture();
    const report = await inspectExact13ProviderReadiness({
      exact13ConfigFile: fixture.exact13,
      referenceOperatorConfigFile: fixture.reference,
      now: new Date("2026-08-20T12:00:00.000Z"),
    });
    const output = path.join(fixture.root, "readiness-output");
    writeProviderReadinessReport({ report, outputDirectory: output });
    const json = await readFile(path.join(output, "readiness.json"), "utf8");
    const markdown = await readFile(path.join(output, "readiness.md"), "utf8");
    expect(JSON.parse(json)).toEqual(report);
    expect(markdown).toBe(renderProviderReadinessMarkdown(report));
    expect(markdown).toContain("claims no qualification evidence");
    expect(providerReadinessReportSha256(report)).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      writeProviderReadinessReport({ report, outputDirectory: output }),
    ).toThrow("must be absent");
  });

  it("returns exit 1 for a complete audit with blockers and keeps stdout secret-safe", async () => {
    const fixture = await missingMaterialFixture();
    const output = path.join(fixture.root, "cli-output");
    const stdout: string[] = [];
    const code = await runProviderReadinessCli(
      [
        fixture.exact13,
        "--operator-config",
        fixture.reference,
        "--output",
        output,
      ],
      { stdout: (value) => stdout.push(value) },
    );
    expect(code).toBe(1);
    expect(stdout.join("")).toContain('"missing":13');
    expect(stdout.join("")).not.toContain(fixture.reference);
  });

  it("does not follow a symlinked top-level plan", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "target.json");
    const link = path.join(root, "link.json");
    await writeFile(target, "{}\n", { mode: 0o600 });
    await import("node:fs/promises").then(({ symlink }) =>
      symlink(target, link),
    );
    await expect(
      inspectExact13ProviderReadiness({
        exact13ConfigFile: link,
        referenceOperatorConfigFile: path.join(root, "missing.json"),
      }),
    ).rejects.toThrow("could not validate the exact-13 plan");
  });

  it("binds even invalid release-policy bytes so substitution changes readiness", async () => {
    const fixture = await missingMaterialFixture();
    const policyFile = path.join(fixture.root, "release-trust-policy.json");
    await writeFile(policyFile, '{"schema":"invalid-a"}\n', { mode: 0o600 });
    const first = await inspectExact13ProviderReadiness({
      exact13ConfigFile: fixture.exact13,
      referenceOperatorConfigFile: fixture.reference,
    });
    await writeFile(policyFile, '{"schema":"invalid-b"}\n', { mode: 0o600 });
    const second = await inspectExact13ProviderReadiness({
      exact13ConfigFile: fixture.exact13,
      referenceOperatorConfigFile: fixture.reference,
    });
    expect(first.releaseTrustPolicyFileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.releaseTrustPolicySha256).toBeNull();
    expect(second.releaseTrustPolicyFileSha256).not.toBe(
      first.releaseTrustPolicyFileSha256,
    );
    expect(second.readinessInputSha256).not.toBe(first.readinessInputSha256);
  });

  it("refuses prepared file references that escape the isolated directory", async () => {
    const fixture = await missingMaterialFixture();
    const prepared = path.join(
      fixture.root,
      "prepared",
      PROVIDER_CANARY_SCENARIO_IDS[0],
    );
    await mkdir(prepared, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(prepared, "config.json"),
      `${JSON.stringify({
        schema: EXTERNAL_PROVIDER_CANARY_CONFIG_SCHEMA,
        scenarioDefinitionFile: path.join(
          fixture.root,
          "outside-scenario.json",
        ),
        authorizationFile: "authorization.json",
        operationKind: "bluebubbles.message-send",
        providerTargetFile: "provider-target.json",
        operationInputFile: "operation-input.json",
        failureProbesFile: "failure-probes.json",
        manifestAuthorityPublicKeyFiles: ["authority.pem"],
        observerPublicKeyFiles: ["observer.pem"],
        deploymentAttestationIssuerPublicKeyFiles: [
          "deployment-attestation-issuer.pem",
        ],
        semanticJudgePublicKeyFiles: ["judge.pem"],
        operatorModuleFile: "operator.mjs",
        operatorModuleSha256: "b".repeat(64),
        operatorStateDir: "state",
        outputDir: "output",
      })}\n`,
      { mode: 0o600 },
    );
    const report = await inspectExact13ProviderReadiness({
      exact13ConfigFile: fixture.exact13,
      referenceOperatorConfigFile: fixture.reference,
    });
    expect(report.canaries[0]).toMatchObject({
      scenarioId: PROVIDER_CANARY_SCENARIO_IDS[0],
      status: "invalid",
    });
    expect(
      report.canaries[0].checks.find(
        ({ code }) => code === "prepared-authorization",
      ),
    ).toMatchObject({ status: "invalid" });
  });
});
