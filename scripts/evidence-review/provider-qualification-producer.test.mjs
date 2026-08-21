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

function publication(index) {
  return {
    schema: "eliza.provider-qualification-publication.v2",
    scenarioId: EXPECTED_PROVIDER_SCENARIO_IDS[index],
    qualificationArtifact: {
      schema: "eliza.provider-qualification-artifact.v5",
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
    },
  };
}

function makeFixture() {
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "provider-qualification-producer-test-"),
  );
  const publicationFiles = [];
  for (const [index] of EXPECTED_PROVIDER_SCENARIO_IDS.entries()) {
    const file = path.join(fixture, `publication-${index}.json`);
    writeJson(file, publication(index));
    publicationFiles.push(file);
  }
  const catalogConfigFile = path.join(fixture, "catalog.json");
  const releaseTrustPolicyFile = path.join(fixture, "trust-policy.json");
  writeJson(releaseTrustPolicyFile, { schema: "fixture-policy" });
  writeJson(catalogConfigFile, {
    schema: "eliza.provider-qualification-catalog-config.v4",
    expectedRepositorySha: "a".repeat(40),
    publicationFiles: ["unused.json"],
    outputDir: "unused-catalog",
    releaseTrustPolicyFile,
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
    schema: "eliza.provider-qualification-matrix-producer-config.v3",
    publicationFiles,
    catalogConfigFile,
    publicationOutputDir,
    releaseTrustPolicyFile,
  });
  return {
    fixture,
    producerConfig,
    publicationOutputDir,
    releaseTrustPolicyFile,
  };
}

function successfulCommandSeam({ failAt = null } = {}) {
  const calls = [];
  const run = (_command, args) => {
    const separator = args.indexOf("--");
    const mode = args[separator + 1];
    const configFile = args[separator + 2];
    const releaseTrustPolicyFile = args[separator + 3];
    calls.push(mode);
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    if (mode === "reverify-publication") {
      assert.equal(typeof releaseTrustPolicyFile, "string");
      assert.equal(
        JSON.parse(fs.readFileSync(releaseTrustPolicyFile, "utf8")).schema,
        "fixture-policy",
      );
      const index =
        (calls.filter((entry) => entry === "reverify-publication").length - 1) %
        EXPECTED_PROVIDER_SCENARIO_IDS.length;
      if (index === failAt) {
        return { status: 1, stdout: "", stderr: "fixture refusal" };
      }
      return {
        status: 0,
        stdout: `## ${EXPECTED_PROVIDER_SCENARIO_IDS[index]}\n\nCleanup verified.\n`,
        stderr: "",
      };
    }
    assert.equal(mode, "catalog");
    assert.equal(config.publicationFiles.length, 13);
    assert.equal(
      JSON.parse(fs.readFileSync(config.releaseTrustPolicyFile, "utf8")).schema,
      "fixture-policy",
    );
    fs.mkdirSync(config.outputDir, { mode: 0o700 });
    writeJson(path.join(config.outputDir, "catalog.json"), {
      schema: "eliza.provider-qualification-catalog.v2",
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
    assert.deepEqual(seam.calls, [
      ...Array(13).fill("reverify-publication"),
      "catalog",
      ...Array(13).fill("reverify-publication"),
      "catalog",
    ]);
    const published = fs
      .readdirSync(fixture.publicationOutputDir, { recursive: true })
      .map(String)
      .sort();
    assert.equal(
      published.filter((entry) => entry.endsWith("publication.md")).length,
      13,
    );
    assert.equal(
      published.filter((entry) => entry.endsWith("publication.json")).length,
      13,
    );
    assert.ok(published.includes(path.join("catalog", "catalog.md")));
    assert.ok(published.includes(path.join("catalog", "catalog.json")));
    assert.ok(published.includes("trust-policy.json"));
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(fixture.publicationOutputDir, "trust-policy.json"),
          "utf8",
        ),
      ),
      JSON.parse(fs.readFileSync(fixture.releaseTrustPolicyFile, "utf8")),
    );
    const firstCapsule = JSON.parse(
      fs.readFileSync(
        path.join(
          fixture.publicationOutputDir,
          "bluebubbles-imessage-confirmed-send",
          "publication.json",
        ),
        "utf8",
      ),
    );
    assert.equal(
      firstCapsule.schema,
      "eliza.provider-qualification-publication.v2",
    );
    assert.equal(
      firstCapsule.qualificationArtifact.reverification.verifierTranscript
        .sourcePrivacy.privateProviderTargetsRetained,
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

test("publishes the descriptor-captured bytes when an input path is replaced", () => {
  const fixture = makeFixture();
  try {
    const seam = successfulCommandSeam();
    const originalRun = seam.run;
    let replaced = false;
    const firstInput = JSON.parse(
      fs.readFileSync(
        JSON.parse(fs.readFileSync(fixture.producerConfig, "utf8"))
          .publicationFiles[0],
        "utf8",
      ),
    );
    const firstPolicy = JSON.parse(
      fs.readFileSync(fixture.releaseTrustPolicyFile, "utf8"),
    );
    const run = (command, args) => {
      const separator = args.indexOf("--");
      if (!replaced && args[separator + 1] === "reverify-publication") {
        replaced = true;
        const producer = JSON.parse(
          fs.readFileSync(fixture.producerConfig, "utf8"),
        );
        writeJson(producer.publicationFiles[0], publication(1));
        writeJson(fixture.releaseTrustPolicyFile, {
          schema: "fixture-policy-replaced-after-capture",
        });
      }
      return originalRun(command, args);
    };
    produceProviderQualificationSummaries(fixture.producerConfig, { run });
    const published = JSON.parse(
      fs.readFileSync(
        path.join(
          fixture.publicationOutputDir,
          "bluebubbles-imessage-confirmed-send",
          "publication.json",
        ),
        "utf8",
      ),
    );
    assert.deepEqual(published, firstInput);
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(fixture.publicationOutputDir, "trust-policy.json"),
          "utf8",
        ),
      ),
      firstPolicy,
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
      /reverify-publication failed with exit 1/,
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

test("rejects symlinked publication inputs before verification", () => {
  const fixture = makeFixture();
  try {
    const producer = JSON.parse(
      fs.readFileSync(fixture.producerConfig, "utf8"),
    );
    fs.rmSync(producer.publicationFiles[0]);
    fs.symlinkSync(producer.publicationFiles[1], producer.publicationFiles[0]);
    const seam = successfulCommandSeam();
    assert.throws(
      () =>
        produceProviderQualificationSummaries(fixture.producerConfig, {
          run: seam.run,
        }),
      /single-link regular file/,
    );
    assert.deepEqual(seam.calls, []);
    assert.equal(fs.existsSync(fixture.publicationOutputDir), false);
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
      publicationFiles: config.publicationFiles.slice(0, 12),
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
