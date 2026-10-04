import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeAllocator, reservePair } from "../version-allocator.mjs";

const sourceCommit = "a".repeat(40);
const args = (releaseId) => ({ releaseId, sourceCommit, publishedCodes: [1] });
const temporary = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ota-allocator-"));
  try {
    return fn(path.join(dir, "allocator.db"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
test("allocator is durable, global across releases and idempotent across retries", () =>
  temporary((file) => {
    assert.throws(() => reservePair(file, args("first")));
    initializeAllocator(file, 1);
    assert.throws(() => initializeAllocator(file, 1));
    assert.deepEqual(reservePair(file, args("first")), {
      releaseId: "first",
      candidateVersionCode: 2,
      recoveryVersionCode: 3,
    });
    assert.deepEqual(reservePair(file, args("first")), {
      releaseId: "first",
      candidateVersionCode: 2,
      recoveryVersionCode: 3,
    });
    assert.throws(() =>
      reservePair(file, { ...args("first"), sourceCommit: "b".repeat(40) }),
    );
    assert.equal(
      reservePair(file, { ...args("beta"), publishedCodes: [100] })
        .candidateVersionCode,
      101,
    );
    assert.equal(reservePair(file, args("stable")).candidateVersionCode, 103);
  }));
test("allocator rejects exhausted or corrupted state without recreating it", () =>
  temporary((file) => {
    initializeAllocator(file, 2099999999);
    assert.throws(() => reservePair(file, args("exhausted")), /exhausted/);
    fs.writeFileSync(file, "corrupt database");
    assert.throws(() => reservePair(file, args("corrupt")));
    assert.equal(fs.readFileSync(file, "utf8"), "corrupt database");
  }));
const moduleUrl = new URL("../version-allocator.mjs", import.meta.url).href;
test("concurrent release workers get nonoverlapping candidate/recovery codes", {
  timeout: 30000,
}, async () => {
  const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "ota-allocator-concurrent-"),
    ),
    file = path.join(dir, "allocator.db");
  try {
    initializeAllocator(file, 1);
    const results = await Promise.all(
      Array.from(
        { length: 12 },
        (_, i) =>
          new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [
              "--input-type=module",
              "-e",
              `import {reservePair} from ${JSON.stringify(moduleUrl)};console.log(JSON.stringify(reservePair(process.argv[1],JSON.parse(process.argv[2]))));`,
              file,
              JSON.stringify(args(`release-${i}`)),
            ]);
            let out = "",
              err = "";
            child.stdout.on("data", (s) => (out += s));
            child.stderr.on("data", (s) => (err += s));
            child.on("error", reject);
            // "close" fires only after the child's stdio streams are drained;
            // "exit" can precede the final stdout chunk on a loaded runner.
            child.on("close", (code) => {
              if (code !== 0) return reject(Error(err));
              try {
                resolve(JSON.parse(out));
              } catch (error) {
                reject(error);
              }
            });
          }),
      ),
    );
    const codes = results.flatMap((r) => [
      r.candidateVersionCode,
      r.recoveryVersionCode,
    ]);
    assert.equal(new Set(codes).size, 24);
    assert.deepEqual(
      codes.sort((a, b) => a - b),
      Array.from({ length: 24 }, (_, i) => i + 2),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("real worker death preserves atomic allocation and durable idempotency", () => {
  for (const boundary of ["before-reservation", "before-commit", "committed"])
    temporary((file) => {
      initializeAllocator(file, 1);
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {reservePair} from ${JSON.stringify(moduleUrl)};reservePair(process.argv[1],JSON.parse(process.argv[2]),point=>{if(point===process.argv[3])process.exit(24)});`,
          file,
          JSON.stringify(args("interrupted")),
          boundary,
        ],
        { encoding: "utf8" },
      );
      assert.equal(child.status, 24, child.stderr);
      const result = reservePair(file, args("interrupted"));
      assert.equal(result.candidateVersionCode, 2);
      assert.equal(result.recoveryVersionCode, 3);
      assert.equal(reservePair(file, args("next")).candidateVersionCode, 4);
    });
});
