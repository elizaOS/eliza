import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { composeTrustSource } from "./compose-source.mjs";

test("isolates hosts and source revisions, preserves source, and rejects tampered cache", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ota-compose-"));
  try {
    const sharedSource = path.join(root, "shared"),
      testDirectory = path.join(root, "tests"),
      cacheDirectory = path.join(root, "cache");
    fs.mkdirSync(sharedSource);
    fs.mkdirSync(testDirectory);
    fs.writeFileSync(path.join(sharedSource, "go.mod"), "module fixture\n");
    fs.writeFileSync(
      path.join(testDirectory, "consumer_test.go"),
      "package fixture\n",
    );
    const hostPolicy = {
      schema: 2,
      product: "host-one",
      package: "org.fixture.one",
      cohortDomain: "fixture",
      runtimeInventoryHeader: "fixture-v1",
      runtimeExcludedAgentDirectories: ["models"],
    };
    const options = { sharedSource, testDirectory, cacheDirectory, hostPolicy };
    const one = composeTrustSource(options);
    assert.deepEqual(composeTrustSource(options), one);
    assert.equal(
      fs.readFileSync(path.join(one.source, "consumer_test.go"), "utf8"),
      "package fixture\n",
    );
    assert.equal(
      JSON.parse(Buffer.from(one.ldflags.split("=").at(-1), "base64url"))
        .product,
      "host-one",
    );
    assert.notEqual(
      composeTrustSource({
        ...options,
        hostPolicy: { ...hostPolicy, product: "host-two" },
      }).source,
      one.source,
    );
    fs.writeFileSync(path.join(sharedSource, "go.mod"), "module revision\n");
    assert.notEqual(composeTrustSource(options).source, one.source);
    fs.writeFileSync(path.join(sharedSource, "go.mod"), "module fixture\n");
    fs.writeFileSync(path.join(one.source, "go.mod"), "tampered");
    assert.throws(() => composeTrustSource(options), /inventory mismatch/);
    assert.equal(
      fs.readFileSync(path.join(sharedSource, "go.mod"), "utf8"),
      "module fixture\n",
    );
    fs.writeFileSync(path.join(one.source, "go.mod"), "module fixture\n");
    fs.symlinkSync(
      path.join(sharedSource, "go.mod"),
      path.join(one.source, "unexpected"),
    );
    assert.throws(
      () => composeTrustSource(options),
      /Unexpected OTA source entry/,
    );
    assert.throws(
      () =>
        composeTrustSource({
          ...options,
          hostPolicy: { ...hostPolicy, product: "" },
        }),
      /Invalid OTA host/,
    );
    const { runtimeExcludedAgentDirectories: _, ...schemaOne } = hostPolicy;
    for (const invalid of [
      { ...schemaOne, schema: 1 },
      { ...hostPolicy, runtimeExcludedAgentDirectories: ["../models"] },
      { ...hostPolicy, runtimeExcludedAgentDirectories: ["models", "models"] },
      { ...hostPolicy, runtimeExcludedAgentDirectories: "models" },
    ])
      assert.throws(
        () => composeTrustSource({ ...options, hostPolicy: invalid }),
        /Invalid OTA host/,
      );
    fs.writeFileSync(path.join(sharedSource, "consumer_test.go"), "existing");
    assert.throws(() => composeTrustSource(options), /colliding/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
