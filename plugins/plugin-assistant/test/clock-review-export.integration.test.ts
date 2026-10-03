import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { test } from "vitest";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

test("Clock source and packed exports preserve the host receipt and cancellation contract", async () => {
  const source = fileURLToPath(new URL("..", import.meta.url));
  const manifest = JSON.parse(
    fs.readFileSync(path.join(source, "package.json"), "utf8"),
  );
  const output = testOutputPath("clock-review-export");
  fs.mkdirSync(output, { recursive: true });
  const temp = fs.mkdtempSync(path.join(output, "case-"));
  const proof = `import assert from 'node:assert/strict';import {createClockReviewExecutor} from '@elizaos/plugin-assistant/device-clock-review';
const operation={type:'clock_handoff',action:'dismiss'},identity={scope:'a'.repeat(64),proposalId:'proposal'},result={kind:'clock-handoff',action:'dismiss',status:'opened'};let effects=0,saved=false,cancels=0,failCancel=false;
const executor=createClockReviewExecutor({async reviewClock(input){assert.deepEqual(input.operation,operation);return saved?{result}:{reviewToken:'native-gesture'};},async confirmClock(input){assert.equal(input.reviewToken,'native-gesture');assert.equal(input.operationId,'operation');effects++;saved=true;return {result};},async cancelClock(){cancels++;if(failCancel)throw Error('unconfirmed');}});
assert.deepEqual(await executor.review(operation,'operation',identity,new AbortController().signal,()=>{}),result);assert.equal(effects,1);assert.deepEqual(await executor.review(operation,'operation',identity,new AbortController().signal,()=>{}),result);assert.equal(effects,1);
failCancel=true;await assert.rejects(executor.review(operation,'operation',identity,new AbortController().signal,()=>{}));const before=cancels;await assert.rejects(executor.retire());assert.equal(cancels,before+1);failCancel=false;await executor.retire();const after=cancels;await executor.retire();assert.equal(cancels,after);assert.equal(effects,1);console.log(JSON.stringify({publicExport:true,effects,cancellationLatch:true,duplicateDelegation:true}));`;
  try {
    fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify(manifest));
    fs.symlinkSync(path.join(source, "src"), path.join(temp, "src"), "dir");
    fs.writeFileSync(path.join(temp, "proof.mjs"), proof);
    for (const compiled of [false, true]) {
      if (compiled) {
        await build({
          entry: {
            "device-clock-review": path.join(
              source,
              "src/services/device-actions/clock-review-executor.ts",
            ),
          },
          outDir: path.join(temp, "dist"),
          tsconfig: path.join(source, "tsconfig.build.json"),
          platform: "node",
          target: "node24",
          format: ["esm"],
          splitting: false,
          dts: true,
          clean: true,
          silent: true,
        });
        assert.ok(
          fs.statSync(path.join(temp, "dist/device-clock-review.d.ts")).size >
            0,
        );
      }
      let consumer = temp;
      if (compiled) {
        const packed = JSON.parse(
          execFileSync("npm", ["pack", "--ignore-scripts", "--json"], {
            cwd: temp,
            encoding: "utf8",
          }),
        );
        consumer = path.join(temp, "consumer");
        const installed = path.join(
          consumer,
          "node_modules/@elizaos/plugin-assistant",
        );
        fs.mkdirSync(installed, { recursive: true });
        execFileSync("tar", [
          "-xzf",
          path.join(temp, packed[0].filename),
          "--strip-components=1",
          "-C",
          installed,
        ]);
        fs.writeFileSync(path.join(consumer, "proof.mjs"), proof);
      }
      const run = spawnSync(
        process.execPath,
        [
          ...(compiled ? [] : ["--conditions=eliza-source"]),
          path.join(consumer, "proof.mjs"),
        ],
        { cwd: consumer, encoding: "utf8", timeout: 30000, maxBuffer: 65536 },
      );
      assert.equal(run.error, undefined);
      assert.equal(run.signal, null);
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), {
        publicExport: true,
        effects: 1,
        cancellationLatch: true,
        duplicateDelegation: true,
      });
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}, 120000);
