import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = path.dirname(fileURLToPath(import.meta.url));

test("CLI source-bound cache rebuilds stale pairs and never admits a failed pair", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shim-cache-contract-"));
  try {
    const recipe = path.join(root, "recipe"),
      bin = path.join(root, "bin"),
      cache = path.join(root, "cache");
    fs.mkdirSync(recipe);
    fs.mkdirSync(bin);
    for (const name of [
      "compile-shim.ts",
      "zig-toolchain.ts",
      "compile-libllama-paths.ts",
      "seccomp-shim",
    ])
      fs.cpSync(path.join(source, name), path.join(recipe, name), {
        recursive: true,
      });
    const log = path.join(root, "compiles.jsonl");
    // Run the real compiler CLI and generated Zig driver through a controlled
    // compiler process. No native execution claim: actual ELF qualification is separate.
    fs.writeFileSync(
      path.join(bin, "zig"),
      `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const a=process.argv.slice(2);
if(a[0]==='version'){console.log('0.13.0');process.exit(0);}
const out=a[a.indexOf('-o')+1];
if(process.env.SHIM_FAIL_WRAP==='1'&&path.basename(out).startsWith('ld-musl'))process.exit(7);
fs.appendFileSync(process.env.SHIM_COMPILE_LOG,JSON.stringify(a)+'\\n');
fs.writeFileSync(out,'compiled '+fs.readFileSync(a[a.length-1],'utf8'));fs.chmodSync(out,0o755);
`,
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SHIM_COMPILE_LOG: log,
    };
    const args = [
      path.join(recipe, "compile-shim.ts"),
      "--abi",
      "x86_64",
      "--cache-dir",
      cache,
      "--skip-if-present",
    ];
    const run = () =>
      execFileSync(process.execPath, args, { env, stdio: "pipe" });
    const count = () => fs.readFileSync(log, "utf8").trim().split("\n").length;
    const directory = path.join(cache, "x86_64"),
      receiptPath = path.join(directory, "build-receipt.json");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "libsigsys-handler.so"), "old shim");
    fs.writeFileSync(
      path.join(directory, "ld-musl-x86_64.so.1"),
      "old wrapper",
    );
    run();
    assert.equal(count(), 2, "legacy files without a receipt must rebuild");
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.identity.abi, "x86_64");
    assert.equal(receipt.identity.target, "x86_64-linux-musl");
    assert.equal(receipt.identity.zigVersion, "0.13.0");
    run();
    assert.equal(count(), 2, "unchanged inputs reuse the pair");
    for (const [i, name] of [
      "seccomp-shim/preserve-sigsys.h",
      "seccomp-shim/sigsys-handler.c",
      "seccomp-shim/loader-wrap.c",
      "compile-shim.ts",
      "zig-toolchain.ts",
      "compile-libllama-paths.ts",
    ].entries()) {
      fs.appendFileSync(path.join(recipe, name), "\n// changed input\n");
      run();
      assert.equal(count(), 4 + i * 2, `${name} invalidates the pair`);
    }
    for (const [i, name] of [
      "libsigsys-handler.so",
      "ld-musl-x86_64.so.1",
    ].entries()) {
      fs.appendFileSync(path.join(directory, name), "tampered");
      run();
      assert.equal(count(), 16 + i * 2);
    }
    const wrong = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    wrong.identity.abi = "arm64-v8a";
    fs.writeFileSync(receiptPath, JSON.stringify(wrong));
    run();
    assert.equal(count(), 20);
    fs.appendFileSync(
      path.join(recipe, "seccomp-shim/preserve-sigsys.h"),
      "\n// changed again\n",
    );
    const failed = spawnSync(process.execPath, args, {
      env: { ...env, SHIM_FAIL_WRAP: "1" },
      encoding: "utf8",
    });
    assert.notEqual(failed.status, 0);
    assert.equal(
      fs.existsSync(receiptPath),
      false,
      "failed second compile publishes no receipt",
    );
    run();
    assert.equal(count(), 23, "failure cannot make the following build skip");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
