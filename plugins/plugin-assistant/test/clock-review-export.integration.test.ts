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
  const proof = `import assert from 'node:assert/strict';import {createClockReviewExecutor,validateClockOperation,validateClockResult,validateClockAlarmContext,CLOCK_CAPABILITY,CLOCK_REPEAT_CAPABILITY,CLOCK_ALARMS_CAPABILITY} from '@elizaos/plugin-assistant/device-clock-review';
assert.equal(CLOCK_CAPABILITY,'clock.handoff.v1');assert.equal(CLOCK_REPEAT_CAPABILITY,'clock.handoff.v2');
const operation={type:'clock_handoff',action:'dismiss'},identity={scope:'a'.repeat(64),proposalId:'proposal'},result={kind:'clock-handoff',action:'dismiss',status:'opened'};let effects=0,saved=false,cancels=0,failCancel=false;
const executor=createClockReviewExecutor({async reviewClock(input){assert.deepEqual(input.operation,operation);return saved?{result}:{reviewToken:'native-gesture'};},async confirmClock(input){assert.equal(input.reviewToken,'native-gesture');assert.equal(input.operationId,'operation');effects++;saved=true;return {result};},async cancelClock(){cancels++;if(failCancel)throw Error('unconfirmed');}});
assert.deepEqual(await executor.review(operation,'operation',identity,new AbortController().signal,()=>{}),result);assert.equal(effects,1);assert.deepEqual(await executor.review(operation,'operation',identity,new AbortController().signal,()=>{}),result);assert.equal(effects,1);
failCancel=true;await assert.rejects(executor.review(operation,'operation',identity,new AbortController().signal,()=>{}));const before=cancels;await assert.rejects(executor.retire());assert.equal(cancels,before+1);failCancel=false;await executor.retire();const after=cancels;await executor.retire();assert.equal(cancels,after);assert.equal(effects,1);
let reviewed=0;const setResult={kind:'clock-handoff',action:'set',status:'opened'};let expected;
const repeatExecutor=createClockReviewExecutor({async reviewClock(input){reviewed++;assert.deepEqual(input.operation,expected);assert.notEqual(input.operation.days,expected.days);return {reviewToken:'repeat-consent'};},async confirmClock(){return {result:setResult};},async cancelClock(){}});
for(const days of [[],[1,2,3,4,5,6,7],[2,3,4,5,6],[7,1]]){expected={type:'clock_handoff',action:'set',hour:9,minute:0,label:'Repeat fixture',timeZone:'UTC',days};assert.deepEqual(validateClockOperation(expected),expected);assert.deepEqual(validateClockResult(expected,setResult,'applied'),setResult);assert.deepEqual(await repeatExecutor.review(expected,'repeat',identity,new AbortController().signal,()=>{}),setResult);}
for(const days of [undefined,null,'weekdays',['2'],[0],[8],[2,2],Array(1)]){await assert.rejects(repeatExecutor.review({...expected,days},'repeat',identity,new AbortController().signal,()=>{}));}assert.equal(reviewed,4);await repeatExecutor.retire();
assert.equal(CLOCK_ALARMS_CAPABILITY,'clock.alarms.v1');const alarmId='12345678-1234-1234-1234-123456789abc',owned={type:'clock_alarm',action:'set',hour:9,minute:0,label:'Eliza owned',timeZone:'UTC',days:[2,3,4,5,6]},ownedResult={kind:'clock-alarm',action:'set',status:'scheduled',alarmId,nextAt:1791378000000};const ownedExecutor=createClockReviewExecutor({async reviewClock(input){assert.deepEqual(input.operation,owned);return {reviewToken:'owned-consent'};},async confirmClock(){return {result:ownedResult};},async cancelClock(){}});assert.deepEqual(await ownedExecutor.review(owned,alarmId,identity,new AbortController().signal,()=>{}),ownedResult);await ownedExecutor.retire();assert.throws(()=>validateClockResult(owned,{...ownedResult,alarmId:'87654321-1234-1234-1234-123456789abc'},'applied',alarmId));assert.throws(()=>validateClockResult(owned,{...ownedResult,nextAt:null},'applied',alarmId));assert.throws(()=>validateClockOperation({...owned,days:undefined}));assert.deepEqual(validateClockResult({...owned,action:'update',alarmId},{...ownedResult,action:'update',status:'updated',nextAt:null},'applied',alarmId),{...ownedResult,action:'update',status:'updated',nextAt:null});const snapshot={revision:2,sensitive:false,timeZone:'UTC',alarmsStatus:'available',alarmsObservedAt:1791377990000,alarmsRevision:1,alarms:[{id:alarmId,hour:9,minute:0,label:'Eliza owned',timeZone:'UTC',days:[2,3,4,5,6],enabled:true,nextAt:1791378000000,scheduleState:'scheduled',generation:1,lastOutcome:''}]};assert.deepEqual(validateClockAlarmContext(snapshot),snapshot);assert.throws(()=>validateClockAlarmContext({...snapshot,alarms:[snapshot.alarms[0],snapshot.alarms[0]]}));console.log(JSON.stringify({publicExport:true,effects,cancellationLatch:true,duplicateDelegation:true,repeatDays:true,malformedDaysRejected:true,ownedAlarm:true}));`;
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
        const declarations = fs.readFileSync(
          path.join(temp, "dist/device-clock-review.d.ts"),
          "utf8",
        );
        for (const name of [
          "ClockOperation",
          "ClockResult",
          "ClockAlarmOperation",
          "ClockAlarmResult",
          "ClockAlarmRecord",
          "ClockAlarmContext",
        ])
          assert.match(
            declarations,
            new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`),
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
        repeatDays: true,
        malformedDaysRejected: true,
        ownedAlarm: true,
      });
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}, 120000);
