import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildConsumerMobileDns,
  verifyConsumerMobileDns,
} from "./consumer-mobile-dns.mjs";

test("immutable DNS bundle loads outside the workspace and rejects byte/source tampering", () => {
  const sourceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );
  const sourceCommit = execFileSync(
    "git",
    ["-C", sourceRoot, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "mobile-dns-consumer-"),
  );
  try {
    const file = path.join(temporary, "resolver.mjs"),
      options = { sourceRoot, sourceCommit };
    buildConsumerMobileDns(file, options);
    verifyConsumerMobileDns(file, options);
    const probe = path.join(temporary, "probe.mjs");
    fs.writeFileSync(
      probe,
      `import assert from 'node:assert/strict';import {configureMobileDnsIfNeeded} from ${JSON.stringify(pathToFileURL(file).href)};const original=globalThis.fetch;configureMobileDnsIfNeeded();assert.equal(globalThis.fetch,original);console.log('desktop resolver unchanged');`,
    );
    const env = Object.fromEntries(
      ["PATH", "HOME", "TMPDIR"]
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]]),
    );
    assert.match(
      execFileSync("bun", ["--no-env-file", "--no-install", probe], {
        cwd: temporary,
        env,
        encoding: "utf8",
      }),
      /desktop resolver unchanged/,
    );
    const bytes = fs.readFileSync(file);
    fs.appendFileSync(file, "modified");
    assert.throws(() => verifyConsumerMobileDns(file, options), /provenance/);
    fs.writeFileSync(file, bytes);
    assert.throws(
      () =>
        verifyConsumerMobileDns(file, {
          ...options,
          sourceCommit: "0".repeat(40),
        }),
      /provenance/,
    );
    const metadata = JSON.parse(fs.readFileSync(`${file}.json`));
    metadata.sourceHashes[Object.keys(metadata.sourceHashes)[0]] = "0".repeat(
      64,
    );
    fs.writeFileSync(`${file}.json`, JSON.stringify(metadata));
    assert.throws(
      () => verifyConsumerMobileDns(file, options),
      /source mismatch/,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
