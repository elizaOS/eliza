/**
 * Exercises the 13-canary matrix producer against private temporary inputs and
 * a deterministic command seam. The test proves all verifiers precede the
 * catalog and that only portable public capsules reach the producer root.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_PROVIDER_SCENARIO_IDS,
  parseProviderQualificationProducerConfig,
  produceProviderQualificationSummaries,
} from "./provider-qualification-producer.mjs";

const REPO_ROOT = path.resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
);

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function verifyConfig(index) {
  return {
    schema: "eliza.provider-qualification-verify-config.v2",
    scenarioFile: `scenario-${index}.ts`,
    authorizationFile: `authorization-${index}.json`,
    operationKind: "gmail.email-send",
    providerTargetFile: `target-${index}.json`,
    operationInputFile: `input-${index}.json`,
    failureProbesFile: `probes-${index}.json`,
    manifestAuthorityPublicKeyFiles: [`manifest-${index}.pem`],
    runDir: `run-${index}`,
    observerEvidenceFile: `observer-${index}.json`,
    observerPublicKeyFiles: [`observer-${index}.pem`],
    semanticEvidenceFile: `semantic-${index}.json`,
    semanticJudgePublicKeyFiles: [`judge-${index}.pem`],
    runnerReportFile: `runner-${index}.json`,
    outputDir: `unused-${index}`,
  };
}

function makeFixture() {
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "provider-qualification-producer-test-"),
  );
  const verifyConfigFiles = [];
  for (const [index] of EXPECTED_PROVIDER_SCENARIO_IDS.entries()) {
    const file = path.join(fixture, `verify-${index}.json`);
    writeJson(file, verifyConfig(index));
    verifyConfigFiles.push(file);
  }
  const catalogConfigFile = path.join(fixture, "catalog.json");
  writeJson(catalogConfigFile, {
    schema: "eliza.provider-qualification-catalog-config.v2",
    expectedRepositorySha: "a".repeat(40),
    artifactFiles: ["unused.json"],
    outputDir: "unused-catalog",
  });
  const runLeaf = `producer-test-${process.pid}-${Date.now()}`;
  const publicationOutputDir = path.join(
    REPO_ROOT,
    "reports",
    "provider-qualification",
    runLeaf,
  );
  const producerConfig = path.join(fixture, "producer.json");
  writeJson(producerConfig, {
    schema: "eliza.provider-qualification-matrix-producer-config.v1",
    verifyConfigFiles,
    catalogConfigFile,
    publicationOutputDir,
  });
  return { fixture, producerConfig, publicationOutputDir };
}

function successfulCommandSeam({ failAt = null } = {}) {
  const calls = [];
  const run = (_command, args) => {
    const mode = args.at(-2);
    const configFile = args.at(-1);
    calls.push(mode);
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    if (mode === "verify") {
      const index = calls.filter((entry) => entry === "verify").length - 1;
      if (index === failAt) {
        return { status: 1, stdout: "", stderr: "fixture refusal" };
      }
      fs.mkdirSync(config.outputDir, { mode: 0o700 });
      writeJson(path.join(config.outputDir, "qualification.json"), {
        schema: "eliza.provider-qualification-artifact.v4",
        scenarioId: EXPECTED_PROVIDER_SCENARIO_IDS[index],
        decision: {
          qualification: { status: "qualified", publishable: true },
        },
        reverification: {
          verifierTranscript: {
            sourcePrivacy: {
              privateProviderTargetsRetained: false,
              privateKeysRetained: false,
              credentialsRetained: false,
              rawRunnerTranscriptRetained: false,
              runDirectoryPathRetained: false,
            },
          },
        },
      });
      fs.writeFileSync(
        path.join(config.outputDir, "qualification.md"),
        `## ${EXPECTED_PROVIDER_SCENARIO_IDS[index]}\n\nHash only.\n`,
      );
      return { status: 0, stdout: "safe markdown", stderr: "" };
    }
    assert.equal(mode, "catalog");
    assert.equal(config.artifactFiles.length, 13);
    fs.mkdirSync(config.outputDir, { mode: 0o700 });
    writeJson(path.join(config.outputDir, "catalog.json"), {
      schema: "eliza.provider-qualification-catalog.v1",
      scenarioCount: 13,
    });
    fs.writeFileSync(
      path.join(config.outputDir, "catalog.md"),
      "## Provider qualification catalog\n\n13 qualified.\n",
    );
    return { status: 0, stdout: "safe catalog", stderr: "" };
  };
  return { calls, run };
}

test("runs all 13 verifiers and the catalog before publishing capsules", () => {
  const fixture = makeFixture();
  try {
    const seam = successfulCommandSeam();
    const result = produceProviderQualificationSummaries(
      fixture.producerConfig,
      { run: seam.run },
    );
    assert.equal(result.scenarioCount, 13);
    assert.deepEqual(seam.calls, [...Array(13).fill("verify"), "catalog"]);
    const published = fs
      .readdirSync(fixture.publicationOutputDir, { recursive: true })
      .map(String)
      .sort();
    assert.equal(
      published.filter((entry) => entry.endsWith("qualification.md")).length,
      13,
    );
    assert.equal(
      published.filter((entry) => entry.endsWith("qualification.json")).length,
      13,
    );
    assert.ok(published.includes(path.join("catalog", "catalog.md")));
    assert.ok(published.includes(path.join("catalog", "catalog.json")));
    const firstCapsule = JSON.parse(
      fs.readFileSync(
        path.join(
          fixture.publicationOutputDir,
          "bluebubbles-imessage-confirmed-send",
          "qualification.json",
        ),
        "utf8",
      ),
    );
    assert.equal(
      firstCapsule.schema,
      "eliza.provider-qualification-artifact.v4",
    );
    assert.equal(
      firstCapsule.reverification.verifierTranscript.sourcePrivacy
        .privateProviderTargetsRetained,
      false,
    );
  } finally {
    fs.rmSync(fixture.fixture, { recursive: true, force: true });
    fs.rmSync(fixture.publicationOutputDir, {
      recursive: true,
      force: true,
    });
  }
});

test("a verifier refusal leaves no partial canonical producer output", () => {
  const fixture = makeFixture();
  try {
    const seam = successfulCommandSeam({ failAt: 7 });
    assert.throws(
      () =>
        produceProviderQualificationSummaries(fixture.producerConfig, {
          run: seam.run,
        }),
      /verify failed with exit 1/,
    );
    assert.equal(fs.existsSync(fixture.publicationOutputDir), false);
    assert.equal(seam.calls.includes("catalog"), false);
  } finally {
    fs.rmSync(fixture.fixture, { recursive: true, force: true });
    fs.rmSync(fixture.publicationOutputDir, {
      recursive: true,
      force: true,
    });
  }
});

test("the producer config is closed and requires exactly 13 unique verifiers", () => {
  const fixture = makeFixture();
  try {
    const config = JSON.parse(fs.readFileSync(fixture.producerConfig, "utf8"));
    writeJson(fixture.producerConfig, {
      ...config,
      verifyConfigFiles: config.verifyConfigFiles.slice(0, 12),
    });
    assert.throws(
      () => parseProviderQualificationProducerConfig(fixture.producerConfig),
      /exactly 13/,
    );
    writeJson(fixture.producerConfig, { ...config, unexpected: true });
    assert.throws(
      () => parseProviderQualificationProducerConfig(fixture.producerConfig),
      /closed shape/,
    );
  } finally {
    fs.rmSync(fixture.fixture, { recursive: true, force: true });
  }
});
