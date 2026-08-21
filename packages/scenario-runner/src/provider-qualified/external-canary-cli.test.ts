/**
 * Exercises the executable canary boundary without contacting a provider.
 * Adversarial cases prove canonical data loading, freshness caps, protected
 * journaling, replay refusal, atomic publication, and secret-safe failures.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import providerCanaryDefinitionCatalog from "../../schema/provider-canary-definitions.json" with {
  type: "json",
};
import {
  commitExternalCanaryPublication,
  consumeThenPublishExternalCanary,
  EXTERNAL_CANARY_MAX_CLOCK_SKEW_MS,
  EXTERNAL_CANARY_MAX_SIGNATURE_AGE_MS,
  EXTERNAL_PROVIDER_CANARY_CONFIG_SCHEMA,
  EXTERNAL_PROVIDER_CANARY_HELP,
  loadPinnedExternalProviderCapabilityModule,
  parseExternalProviderCanaryConfig,
  readCanonicalProviderScenarioDefinition,
  renderSecretSafeExternalCanaryFatal,
  reserveExternalCanaryRun,
  runExternalProviderCanaryCli,
  stageExternalCanaryDirectory,
  transitionExternalCanaryJournal,
  transitionExternalCanaryRun,
  validateExternalProviderCapabilityBundle,
  validateOperatorOwnedProviderCapabilities,
  validateProtectedOperatorStateDirectory,
} from "./external-canary-cli.ts";
import { createProviderCanaryScenarioSnapshot } from "./scenario-snapshot.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(
    path.join(tmpdir(), "eliza-provider-canary-cli-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function validConfig(): Record<string, unknown> {
  return {
    schema: EXTERNAL_PROVIDER_CANARY_CONFIG_SCHEMA,
    scenarioDefinitionFile: "scenario.json",
    authorizationFile: "authorization.json",
    operationKind: "discord.message-send",
    providerTargetFile: "target.json",
    operationInputFile: "input.json",
    failureProbesFile: "failure-probes.json",
    manifestAuthorityPublicKeyFiles: ["manifest.pub.pem"],
    observerPublicKeyFiles: ["observer.pub.pem"],
    deploymentAttestationIssuerPublicKeyFiles: [
      "deployment-attestation-issuer.pub.pem",
    ],
    semanticJudgePublicKeyFiles: ["judge.pub.pem"],
    releaseTrustPolicyFile: "release-trust-policy.json",
    operatorModuleFile: "operator.mjs",
    operatorModuleSha256: "a".repeat(64),
    operatorStateDir: "operator-state",
    outputDir: "qualification-output",
  };
}

function scenarioDefinition() {
  const definition = providerCanaryDefinitionCatalog.scenarios.find(
    ({ id }) => id === "provider.discord.confirmed-send",
  );
  if (definition === undefined) throw new Error("Discord canary is missing");
  return structuredClone(definition) as ScenarioDefinition;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("external provider-canary CLI", () => {
  it("accepts only v2's closed data-only config and bounded freshness", () => {
    expect(parseExternalProviderCanaryConfig(validConfig())).toMatchObject({
      schema: EXTERNAL_PROVIDER_CANARY_CONFIG_SCHEMA,
      scenarioDefinitionFile: "scenario.json",
      operatorStateDir: "operator-state",
    });
    expect(() =>
      parseExternalProviderCanaryConfig({
        ...validConfig(),
        scenarioFile: "evil.ts",
      }),
    ).toThrow(/unknown=scenarioFile/);
    expect(() =>
      parseExternalProviderCanaryConfig({
        ...validConfig(),
        maxSignatureAgeMs: EXTERNAL_CANARY_MAX_SIGNATURE_AGE_MS + 1,
      }),
    ).toThrow(/may only tighten/);
    expect(() =>
      parseExternalProviderCanaryConfig({
        ...validConfig(),
        maxClockSkewMs: EXTERNAL_CANARY_MAX_CLOCK_SKEW_MS + 1,
      }),
    ).toThrow(/may only tighten/);
  });

  it("accepts only canonical JSON for the matching 13-ID operation", () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, "scenario.json");
    writeFileSync(
      file,
      createProviderCanaryScenarioSnapshot({
        definition: scenarioDefinition(),
        operationKind: "discord.message-send",
      }),
    );
    expect(
      readCanonicalProviderScenarioDefinition(file, "discord.message-send").id,
    ).toBe("provider.discord.confirmed-send");
    expect(() =>
      readCanonicalProviderScenarioDefinition(file, "slack.message-send"),
    ).toThrow(/canonical operation kind/);

    writeFileSync(
      file,
      `${JSON.stringify({ ...scenarioDefinition(), executableScenarioFile: "attack.ts" })}\n`,
    );
    expect(() =>
      readCanonicalProviderScenarioDefinition(file, "discord.message-send"),
    ).toThrow(/unknown fields/);

    writeFileSync(
      file,
      `${JSON.stringify({ ...scenarioDefinition(), id: "provider.fake" })}\n`,
    );
    expect(() =>
      readCanonicalProviderScenarioDefinition(file, "discord.message-send"),
    ).toThrow(/non-canonical scenario/);

    writeFileSync(file, `${JSON.stringify(scenarioDefinition(), null, 2)}\n`);
    expect(() =>
      readCanonicalProviderScenarioDefinition(file, "discord.message-send"),
    ).toThrow(/canonical JSON with one trailing newline/);
    writeFileSync(
      file,
      "export default { id: 'provider.discord.confirmed-send' };\n",
    );
    expect(() =>
      readCanonicalProviderScenarioDefinition(file, "discord.message-send"),
    ).toThrow(/invalid JSON/);
  });

  it("does not follow a symlinked scenario or operator module", async () => {
    const directory = temporaryDirectory();
    const scenarioTarget = path.join(directory, "scenario-target.json");
    const scenarioLink = path.join(directory, "scenario-link.json");
    writeFileSync(
      scenarioTarget,
      createProviderCanaryScenarioSnapshot({
        definition: scenarioDefinition(),
        operationKind: "discord.message-send",
      }),
    );
    symlinkSync(scenarioTarget, scenarioLink);
    expect(() =>
      readCanonicalProviderScenarioDefinition(
        scenarioLink,
        "discord.message-send",
      ),
    ).toThrow();

    const moduleTarget = path.join(directory, "operator-target.mjs");
    const moduleLink = path.join(directory, "operator-link.mjs");
    const source =
      "export function createExternalProviderCanaryCapabilities() {}\n";
    writeFileSync(moduleTarget, source);
    symlinkSync(moduleTarget, moduleLink);
    const digest = createHash("sha256").update(source).digest("hex");
    await expect(
      loadPinnedExternalProviderCapabilityModule(moduleLink, digest),
    ).rejects.toThrow();
  });

  it("requires protected real operator state", () => {
    const directory = temporaryDirectory();
    const state = path.join(directory, "state");
    mkdirSync(state, { mode: 0o700 });
    expect(validateProtectedOperatorStateDirectory(state)).toBe(
      realpathSync(state),
    );
    chmodSync(state, 0o755);
    expect(() => validateProtectedOperatorStateDirectory(state)).toThrow(
      /0700/,
    );
    chmodSync(state, 0o700);
    const link = path.join(directory, "state-link");
    symlinkSync(state, link);
    expect(() => validateProtectedOperatorStateDirectory(link)).toThrow(
      /real directory/,
    );
  });

  it.each(["in-progress", "consumed", "reconciliation-required"] as const)(
    "refuses replay when the manifest journal is %s",
    (status) => {
      const directory = temporaryDirectory();
      const state = path.join(directory, "state");
      mkdirSync(state, { mode: 0o700 });
      const request = {
        operatorStateDir: state,
        manifestSha256: "b".repeat(64),
        scenarioId: "provider.discord.confirmed-send",
        runId: "run-1",
        now: new Date("2026-08-20T00:00:00.000Z"),
      };
      const reservation = reserveExternalCanaryRun(request);
      if (status !== "in-progress")
        transitionExternalCanaryRun(reservation, status);
      expect(() => reserveExternalCanaryRun(request)).toThrow(/cannot replay/);
      expect(JSON.parse(readFileSync(reservation.file, "utf8"))).toMatchObject({
        status,
        manifestSha256: "b".repeat(64),
      });
    },
  );

  it("records proven pre-ingress state before crossing the operator boundary", () => {
    const directory = temporaryDirectory();
    const state = path.join(directory, "state");
    mkdirSync(state, { mode: 0o700 });
    const reservation = reserveExternalCanaryRun({
      operatorStateDir: state,
      manifestSha256: "9".repeat(64),
      scenarioId: "provider.discord.confirmed-send",
      runId: "run-stage-aware",
      now: new Date("2026-08-20T00:00:00.000Z"),
    });
    expect(JSON.parse(readFileSync(reservation.file, "utf8"))).toMatchObject({
      phase: "reserved",
      effectDisposition: "proven-pre-ingress",
      transitions: [{ phase: "reserved" }],
    });
    transitionExternalCanaryJournal(reservation, {
      phase: "operator-boundary-entered",
      effectDisposition: "ambiguous-effect",
      now: new Date("2026-08-20T00:00:01.000Z"),
    });
    expect(JSON.parse(readFileSync(reservation.file, "utf8"))).toMatchObject({
      phase: "operator-boundary-entered",
      effectDisposition: "ambiguous-effect",
      transitions: [
        { phase: "reserved" },
        { phase: "operator-boundary-entered" },
      ],
    });
  });

  it("publishes a complete directory atomically and cleans failed staging", () => {
    const directory = temporaryDirectory();
    const output = path.join(directory, "result");
    const staged = stageExternalCanaryDirectory(
      output,
      "c".repeat(64),
      (staging) => {
        expect(existsSync(output)).toBe(false);
        writeFileSync(path.join(staging, "qualification.json"), "{}\n", {
          mode: 0o600,
        });
      },
    );
    expect(existsSync(output)).toBe(false);
    commitExternalCanaryPublication(staged);
    expect(readFileSync(path.join(output, "qualification.json"), "utf8")).toBe(
      "{}\n",
    );
    expect(() =>
      stageExternalCanaryDirectory(output, "c".repeat(64), () => {}),
    ).toThrow(/already exists/);

    const failed = path.join(directory, "failed");
    expect(() =>
      stageExternalCanaryDirectory(failed, "d".repeat(64), () => {
        throw new Error("crash");
      }),
    ).toThrow("crash");
    expect(existsSync(failed)).toBe(false);
    expect(
      readdirSync(directory).some((entry) => entry.includes(".staging")),
    ).toBe(false);
  });

  it("rejects an output parent writable by another principal", () => {
    const directory = temporaryDirectory();
    chmodSync(directory, 0o777);
    expect(() =>
      stageExternalCanaryDirectory(
        path.join(directory, "result"),
        "c".repeat(64),
        () => {},
      ),
    ).toThrow(/not group\/world writable/);
    expect(existsSync(path.join(directory, "result"))).toBe(false);
  });

  it("never exposes staged output when durable consumption fails", () => {
    const directory = temporaryDirectory();
    const output = path.join(directory, "result");
    const publication = stageExternalCanaryDirectory(
      output,
      "e".repeat(64),
      (staging) =>
        writeFileSync(path.join(staging, "qualification.json"), "{}\n"),
    );
    const journal = {
      file: path.join(directory, "journal.json"),
      value: {
        schema: "eliza.external-provider-canary-run-journal.v1" as const,
        manifestSha256: "e".repeat(64),
        scenarioId: "provider.discord.confirmed-send",
        runId: "run-1",
        status: "in-progress" as const,
        phase: "reserved" as const,
        effectDisposition: "proven-pre-ingress" as const,
        updatedAtIso: "2026-08-20T00:00:00.000Z",
        transitions: [
          {
            status: "in-progress" as const,
            phase: "reserved" as const,
            effectDisposition: "proven-pre-ingress" as const,
            atIso: "2026-08-20T00:00:00.000Z",
          },
        ] as const,
      },
    };
    expect(() =>
      consumeThenPublishExternalCanary(journal, publication, () => {
        throw new Error("injected fsync failure");
      }),
    ).toThrow(/injected fsync failure/);
    expect(existsSync(output)).toBe(false);
    expect(existsSync(publication.staging)).toBe(false);
    expect(existsSync(publication.lock)).toBe(false);
  });

  it("retains a fully staged publication after consumption if exposure crashes", () => {
    const directory = temporaryDirectory();
    const state = path.join(directory, "state");
    mkdirSync(state, { mode: 0o700 });
    const manifestSha256 = "8".repeat(64);
    const journal = reserveExternalCanaryRun({
      operatorStateDir: state,
      manifestSha256,
      scenarioId: "provider.discord.confirmed-send",
      runId: "run-consumed-crash",
    });
    const output = path.join(directory, "recoverable");
    const publication = stageExternalCanaryDirectory(
      output,
      manifestSha256,
      (staging) =>
        writeFileSync(path.join(staging, "publication.json"), "{}\n", {
          mode: 0o600,
        }),
    );
    expect(() =>
      consumeThenPublishExternalCanary(journal, publication, undefined, () => {
        throw new Error("simulated crash after durable consumption");
      }),
    ).toThrow(/simulated crash/);
    expect(existsSync(output)).toBe(false);
    expect(existsSync(publication.staging)).toBe(true);
    expect(JSON.parse(readFileSync(journal.file, "utf8"))).toMatchObject({
      status: "consumed",
      phase: "manifest-consumed",
      effectDisposition: "publication-recoverable",
    });
    commitExternalCanaryPublication(publication);
    transitionExternalCanaryJournal(journal, {
      status: "recovered",
      phase: "publication-committed",
      effectDisposition: "complete",
    });
    expect(existsSync(path.join(output, "publication.json"))).toBe(true);
  });

  it("loads only exact pinned operator bytes", async () => {
    const directory = temporaryDirectory();
    const moduleFile = path.join(directory, "operator.mjs");
    const source =
      "export function createExternalProviderCanaryCapabilities() { return {}; }\n";
    writeFileSync(moduleFile, source);
    const digest = createHash("sha256").update(source).digest("hex");
    expect(
      typeof (
        await loadPinnedExternalProviderCapabilityModule(moduleFile, digest)
      ).createExternalProviderCanaryCapabilities,
    ).toBe("function");
    await expect(
      loadPinnedExternalProviderCapabilityModule(moduleFile, "0".repeat(64)),
    ).rejects.toThrow(/digest mismatch/);
  });

  it.each([
    [
      "dynamic import",
      'export function createExternalProviderCanaryCapabilities() { return import("node:fs"); }\n',
    ],
    [
      "createRequire",
      'import { createRequire } from "node:module";\nexport function createExternalProviderCanaryCapabilities() { return createRequire(import.meta.url); }\n',
    ],
    [
      "require",
      'export function createExternalProviderCanaryCapabilities() { return require("node:fs"); }\n',
    ],
    [
      "runtime loader",
      'export function createExternalProviderCanaryCapabilities() { return process.getBuiltinModule("fs"); }\n',
    ],
  ])("refuses a pinned module containing %s", async (_name, source) => {
    const directory = temporaryDirectory();
    const moduleFile = path.join(directory, "operator.mjs");
    writeFileSync(moduleFile, source);
    const digest = createHash("sha256").update(source).digest("hex");
    await expect(
      loadPinnedExternalProviderCapabilityModule(moduleFile, digest),
    ).rejects.toThrow(/forbidden/);
  });

  it("accepts only closed data-function capability objects without invoking accessors", () => {
    const capabilities = {
      observer: { begin() {} },
      ingress: { execute() {} },
      trajectories: { verify() {} },
      semanticJudge: { judge() {} },
      cleanup: { cleanup() {} },
    };
    expect(validateOperatorOwnedProviderCapabilities(capabilities)).toBe(
      capabilities,
    );

    const accessor = vi.fn(() => ({ begin() {} }));
    const forged = {
      get observer() {
        return accessor();
      },
      ingress: { execute() {} },
      trajectories: { verify() {} },
      semanticJudge: { judge() {} },
      cleanup: { cleanup() {} },
    };
    expect(() => validateOperatorOwnedProviderCapabilities(forged)).toThrow(
      /observer must be an enumerable data property/,
    );
    expect(accessor).not.toHaveBeenCalled();
    expect(() =>
      validateOperatorOwnedProviderCapabilities({
        ...capabilities,
        publisher: { publish() {} },
      }),
    ).toThrow(/unknown=publisher/);
  });

  it("requires the cleanup-proof bridge wrapper without invoking accessors", () => {
    const capabilities = {
      observer: { begin() {} },
      ingress: { execute() {} },
      trajectories: { verify() {} },
      semanticJudge: { judge() {} },
      cleanup: { cleanup() {} },
    };
    const takeVerifiedCleanupProof = vi.fn();
    expect(
      validateExternalProviderCapabilityBundle({
        capabilities,
        cleanupPublicKeyPem:
          "-----BEGIN PUBLIC KEY-----\nunused\n-----END PUBLIC KEY-----\n",
        takeVerifiedCleanupProof,
      }),
    ).toMatchObject({ capabilities });
    expect(takeVerifiedCleanupProof).not.toHaveBeenCalled();

    const accessor = vi.fn(() => capabilities);
    expect(() =>
      validateExternalProviderCapabilityBundle({
        get capabilities() {
          return accessor();
        },
        cleanupPublicKeyPem:
          "-----BEGIN PUBLIC KEY-----\nunused\n-----END PUBLIC KEY-----\n",
        takeVerifiedCleanupProof() {},
      }),
    ).toThrow(/capabilities must be an enumerable data property/);
    expect(accessor).not.toHaveBeenCalled();
    expect(() =>
      validateExternalProviderCapabilityBundle(capabilities),
    ).toThrow(
      /missing=capabilities,cleanupPublicKeyPem,takeVerifiedCleanupProof/,
    );
  });

  it("never reflects operator secrets in fatal output", () => {
    const secret = "TWILIO_AUTH_TOKEN=super-secret";
    const rendered = renderSecretSafeExternalCanaryFatal();
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain("stack");
    expect(rendered).toContain("execution refused");
  });

  it("returns usage status before touching config", async () => {
    await expect(runExternalProviderCanaryCli([])).resolves.toBe(2);
    await expect(runExternalProviderCanaryCli(["one", "two"])).resolves.toBe(2);
  });

  it("prints help without treating the flag as a config path", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await expect(runExternalProviderCanaryCli(["--help"])).resolves.toBe(0);
    expect(write).toHaveBeenCalledWith(EXTERNAL_PROVIDER_CANARY_HELP);
    write.mockRestore();
  });
});
