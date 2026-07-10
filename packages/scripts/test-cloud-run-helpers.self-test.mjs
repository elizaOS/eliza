#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  getBunFailCounts,
  hasBunFailureMarker,
  hasBunPassRecord,
  hasBunRunSummary,
  shouldNormalizeBunStatus99,
} from "./test-cloud-run-helpers.mjs";

const greenOutput = `
 500 pass
 0 fail
 1257 expect() calls
Ran 501 tests across 80 files. [44.97s]
`;
const githubLogOutput = `
2026-07-08T07:22:39.4168779Z  423 pass
2026-07-08T07:22:39.4169064Z  0 fail
2026-07-08T07:22:39.4169799Z Ran 423 tests across 49 files. [10.67s]
`;
const ansiOutput =
  "\u001b[32m 0 fail\u001b[39m\n\u001b[32mRan 1 test across 1 file. [1ms]\u001b[39m\n";
const dirtyGreenOutput = `
(pass) stableSerialize > serializes object keys in deterministic order [1.00ms]
(pass) stableSerialize > rejects circular arrays and objects with a deterministic error [1.00ms]
`;
const importFailureOutput = `
# Unhandled error between tests
-------------------------------
error: Cannot find package 'ioredis' from '/repo/src/redis.ts'
-------------------------------
`;

assert.deepEqual(getBunFailCounts(greenOutput), [0]);
assert.equal(hasBunRunSummary(greenOutput), true);
assert.deepEqual(getBunFailCounts(githubLogOutput), [0]);
assert.equal(hasBunRunSummary(githubLogOutput), true);
assert.deepEqual(getBunFailCounts(ansiOutput), [0]);
assert.equal(hasBunRunSummary(ansiOutput), true);
assert.equal(hasBunPassRecord(dirtyGreenOutput), true);
assert.equal(hasBunFailureMarker(importFailureOutput), true);
assert.equal(
  shouldNormalizeBunStatus99({
    status: 99,
    signal: null,
    output: greenOutput,
  }),
  true,
);

assert.equal(
  shouldNormalizeBunStatus99({
    status: 1,
    signal: null,
    output: dirtyGreenOutput,
  }),
  true,
);

assert.equal(
  shouldNormalizeBunStatus99({
    status: 1,
    signal: null,
    output: importFailureOutput,
  }),
  false,
);

assert.equal(
  shouldNormalizeBunStatus99({
    status: 99,
    signal: null,
    output: greenOutput.replace(" 0 fail", " 1 fail"),
  }),
  false,
);

assert.equal(
  shouldNormalizeBunStatus99({
    status: 2,
    signal: null,
    output: greenOutput,
  }),
  false,
);

assert.equal(
  shouldNormalizeBunStatus99({
    status: 99,
    signal: "SIGTERM",
    output: greenOutput,
  }),
  false,
);

assert.equal(
  shouldNormalizeBunStatus99({
    status: 99,
    signal: null,
    output: " 0 fail\n",
  }),
  false,
);

console.log("[test-cloud-run-helpers] self-test passed");
