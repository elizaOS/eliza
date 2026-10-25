import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  GatewayArtifactError,
  stageGatewayArtifact,
  verifyGatewayArtifact,
} from "../../native-host/gateway-artifact.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-artifact-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const productDirectory = path.join(root, "product/scripts"),
    sourceDirectory = path.join(root, "source"),
    gatewayDirectory = path.join(root, "assets/agent/gateway");
  const write = (base, name, bytes) => {
    const file = path.join(base, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  };
  write(
    productDirectory,
    "local-agent-gateway.mjs",
    "export const fixture=true;",
  );
  write(productDirectory, "../apps/policy.mjs", "export const policy=true;");
  write(sourceDirectory, "native/port.mjs", "export const port=true;");
  write(
    sourceDirectory,
    "packages/agent/src/runtime/mobile-dns.ts",
    "export function configureMobileDnsIfNeeded(): void {}",
  );
  write(
    sourceDirectory,
    "packages/agent/src/runtime/mobile-dns-decode-budget.ts",
    "export const budget=1;",
  );
  write(
    sourceDirectory,
    "core/environment.ts",
    "export const environment=true;",
  );
  const sourceCommit = "a".repeat(40);
  const options = {
    productDirectory,
    sourceDirectory,
    gatewayDirectory,
    sourceCommit,
    productFiles: ["local-agent-gateway.mjs", "../apps/policy.mjs"],
    upstreamFiles: ["native/port.mjs"],
    dnsDependencies: ["core/environment.ts"],
    environment: Object.fromEntries(
      ["HOME", "PATH", "TMPDIR", "LANG"]
        .filter((k) => process.env[k])
        .map((k) => [k, process.env[k]]),
    ),
    buildTaskRuntime(file) {
      write(path.dirname(file), path.basename(file), "export const task=true;");
      write(
        path.dirname(file),
        `${path.basename(file)}.json`,
        JSON.stringify({ schemaVersion: 2, sourceCommit }),
      );
    },
  };
  return {
    options,
    write,
    provenance: (hashes) => ({ commit: sourceCommit, gatewayHashes: hashes }),
  };
}

test("stages a real filesystem layout and Bun DNS bundle with host source selections", (t) => {
  const { options, provenance } = fixture(t);
  const hashes = stageGatewayArtifact(options);
  assert.deepEqual(
    verifyGatewayArtifact({ ...options, provenance: provenance(hashes) }),
    { verifiedProductFiles: 2 },
  );
  assert.equal(
    fs.readFileSync(
      path.join(options.gatewayDirectory, "../apps/policy.mjs"),
      "utf8",
    ),
    "export const policy=true;",
  );
  assert.equal(
    fs.readFileSync(
      path.join(options.gatewayDirectory, "../vendor/eliza/native/port.mjs"),
      "utf8",
    ),
    "export const port=true;",
  );
  assert.match(
    fs.readFileSync(
      path.join(options.gatewayDirectory, "mobile-dns.mjs"),
      "utf8",
    ),
    /configureMobileDnsIfNeeded/,
  );
  assert.match(
    fs.readFileSync(
      path.join(options.gatewayDirectory, "bootstrap.mjs"),
      "utf8",
    ),
    /local-agent-gateway\.mjs/,
  );
});

test("rejects stale source identity, changed inputs and tampered generated outputs", (t) => {
  const { options, write, provenance } = fixture(t);
  const hashes = stageGatewayArtifact(options);
  const check = () =>
    verifyGatewayArtifact({ ...options, provenance: provenance(hashes) });
  assert.throws(
    () =>
      verifyGatewayArtifact({
        ...options,
        sourceCommit: "b".repeat(40),
        provenance: provenance(hashes),
      }),
    GatewayArtifactError,
  );
  for (const [base, name, pattern] of [
    [options.productDirectory, "../apps/policy.mjs", /Stale Android gateway/],
    [options.sourceDirectory, "native/port.mjs", /shared gateway dependency/],
    [options.sourceDirectory, "core/environment.ts", /DNS dependency/],
    [
      options.sourceDirectory,
      "packages/agent/src/runtime/mobile-dns.ts",
      /DNS source/,
    ],
    [options.gatewayDirectory, "bootstrap.mjs", /integrity mismatch/],
    [
      options.gatewayDirectory,
      "../vendor/eliza/native/port.mjs",
      /shared gateway dependency/,
    ],
  ]) {
    const file = path.join(base, name),
      original = fs.readFileSync(file);
    write(base, name, "changed");
    assert.throws(check, pattern);
    write(base, name, original);
    check();
  }
  write(
    options.gatewayDirectory,
    "task-runtime.mjs.json",
    JSON.stringify({ schemaVersion: 2, sourceCommit: "b".repeat(40) }),
  );
  assert.throws(check, /task runtime source/);
});

test("failed generation cannot validate partial output using old provenance", (t) => {
  const { options, write, provenance } = fixture(t);
  const hashes = stageGatewayArtifact(options);
  write(
    options.productDirectory,
    "local-agent-gateway.mjs",
    "export const changed=true;",
  );
  assert.throws(
    () =>
      stageGatewayArtifact({
        ...options,
        buildTaskRuntime() {
          throw new Error("generator failed");
        },
      }),
    /generator failed/,
  );
  assert.throws(
    () => verifyGatewayArtifact({ ...options, provenance: provenance(hashes) }),
    /Stale Android gateway/,
  );
  const recovered = stageGatewayArtifact(options);
  verifyGatewayArtifact({ ...options, provenance: provenance(recovered) });
});

test("compiler failure leaves generated output unqualified until restaged", (t) => {
  const { options, write, provenance } = fixture(t);
  const hashes = stageGatewayArtifact(options);
  assert.throws(() =>
    stageGatewayArtifact({
      ...options,
      bunExecutable: process.execPath,
      buildTaskRuntime(file) {
        options.buildTaskRuntime(file);
        write(path.dirname(file), path.basename(file), "export const task=2;");
      },
    }),
  );
  assert.throws(
    () => verifyGatewayArtifact({ ...options, provenance: provenance(hashes) }),
    /integrity mismatch: task-runtime/,
  );
  const recovered = stageGatewayArtifact(options);
  verifyGatewayArtifact({ ...options, provenance: provenance(recovered) });
});

test("host layout and committed DNS callbacks preserve the deployed import tree", async (t) => {
  const { options, write, provenance } = fixture(t);
  options.productFiles = ["apps/app/gateway.mjs"];
  write(
    options.productDirectory,
    "apps/app/gateway.mjs",
    "globalThis.__gatewayArtifactFixture=true;",
  );
  options.productOutputDirectory = path.dirname(options.gatewayDirectory);
  options.gatewayEntrypoint = "../apps/app/gateway.mjs";
  options.extraGeneratedFiles = [
    "mobile-dns.mjs.json",
    "local-agent-gateway.mjs",
  ];
  options.buildMobileDns = (file) => {
    fs.writeFileSync(file, "export function configureMobileDnsIfNeeded() {}");
    fs.writeFileSync(`${file}.json`, '{"verified":true}');
  };
  options.verifyMobileDns = (file) =>
    assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.json`)), {
      verified: true,
    });
  options.stageAdditionalFiles = (gateway) =>
    write(
      gateway,
      "local-agent-gateway.mjs",
      'export * from "../apps/app/gateway.mjs";',
    );
  const hashes = stageGatewayArtifact(options);
  verifyGatewayArtifact({ ...options, provenance: provenance(hashes) });
  const { pathToFileURL } = await import("node:url");
  const argv = process.argv[1];
  try {
    await import(
      pathToFileURL(path.join(options.gatewayDirectory, "bootstrap.mjs")).href
    );
    assert.equal(globalThis.__gatewayArtifactFixture, true);
  } finally {
    process.argv[1] = argv;
    delete globalThis.__gatewayArtifactFixture;
  }
  fs.appendFileSync(
    path.join(options.gatewayDirectory, "local-agent-gateway.mjs"),
    "changed",
  );
  assert.throws(
    () => verifyGatewayArtifact({ ...options, provenance: provenance(hashes) }),
    /integrity mismatch/,
  );
});
