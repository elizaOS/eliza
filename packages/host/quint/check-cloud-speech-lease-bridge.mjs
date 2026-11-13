/** Replay the owning boundaries and a recorded real Chromium/host/relay flow. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = "packages/host/quint/CloudSpeechLeaseBridge.qnt";
assert.equal(path.resolve(root, process.argv[2] ?? ""), path.join(root, model));
const manifest = model.replace(".qnt", ".cases.json");
const cases = JSON.parse(readFileSync(path.join(root, manifest), "utf8"));
const output = testOutputPath("quint-cloud-speech-lease-bridge");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const suites = [
  {
    owner: "host",
    config: "vitest.config.ts",
    tests: {
      "src/voice/cloud-speech-relay-client.test.ts": [
        "negotiated paid extensions retain the Cloud socket and notify the owning host",
        "an owner change fences a paid extension before its host callback",
      ],
      "src/voice/cloud-speech-retirement-recovery.test.ts": [
        "a lost mint response retains the unknown admission fence",
      ],
      "src/voice/speech-retirement-session.test.ts": [
        "paid renewal retains one STT connection and settles each window once",
        "a lost settlement acknowledgement retries the original per-kind evidence",
      ],
    },
  },
  {
    owner: "ui",
    config: "vitest.config.ts",
    tests: {
      "src/voice/voice-session-cloud-budget-rotation.test.ts": [
        "paid lease renewals preserve one microphone and socket across minute boundaries",
        "foreign, expanded and delayed renewal acknowledgements cannot replace the active deadline",
        "an unnegotiated renewal frame cannot suppress normal Cloud rotation",
      ],
    },
  },
  {
    owner: "app",
    config: "vitest.host.config.ts",
    tests: {
      "src/api/self-hosted-voice.test.ts": [
        "a paid Cloud renewal updates the active host lease without reopening speech",
      ],
    },
  },
];
suites.push({
  owner: "app",
  config: "vitest.voice-renewal.config.ts",
  tests: {
    "test/app/voice-renewal.real.e2e.test.ts": [
      "browser voice crosses a real paid window after one consent reset and retires on Stop",
    ],
  },
});
const identities = [];
for (const suite of suites) {
  const report = path.join(directory, `${suite.owner}-${suite.config}.json`);
  const child = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-with-deadline.ts"),
      "600000",
      "--",
      process.execPath,
      "--conditions=eliza-source",
      path.join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      suite.config,
      ...Object.keys(suite.tests),
      "--maxWorkers=1",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    {
      cwd: path.join(root, "packages", suite.owner),
      env: process.env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  writeFileSync(
    path.join(directory, `${suite.owner}-${suite.config}.log`),
    `${child.stdout ?? ""}\n${child.stderr ?? ""}`,
  );
  if (child.error) throw child.error;
  assert.equal(child.signal, null, `${suite.owner} conformance interrupted`);
  assert.equal(
    child.status,
    0,
    `${suite.owner} conformance failed; see ${directory}`,
  );
  const result = JSON.parse(readFileSync(report, "utf8"));
  for (const [file, names] of Object.entries(suite.tests))
    identities.push(
      ...requireVitestConformance(
        result,
        path.join(root, "packages", suite.owner, file),
        names,
      ),
    );
}
const sources = Object.fromEntries(
  [...new Set([model, manifest, ...cases.sources])].map((file) => [
    file,
    createHash("sha256")
      .update(readFileSync(path.join(root, file)))
      .digest("hex"),
  ]),
);
writeFileSync(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ model, identities, sources, bounds: cases.bounds }, null, 2)}\n`,
);
console.log(
  `Lease bridge conformance passed ${identities.length} named implementation checks: ${directory}`,
);
