/** Packed server loader regression. Native media/providers and personal stores are not used. */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

it("packs the cold trigger API with its real paused-prompt handler and retains optional/platform gates", async () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const source = await readFile(
    path.join(root, "packages/agent/src/api/server.ts"),
    "utf8",
  );
  // Use the actual server loader, not a direct import of the handler under test.
  const part = (start: string, end: string) => {
    const first = source.indexOf(start),
      last = source.indexOf(end, first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThan(first);
    return source.slice(first, last);
  };
  const loader =
    part("function importOptionalPlugin<", "async function getBrowserPlugin") +
    part("const optionalPluginSpecifiers =", "type LocalInferenceServerApi") +
    part(
      "async function getOptionalPluginApi<",
      "type BrowserWorkspaceCommand",
    );
  const scratch = await mkdtemp(path.join(tmpdir(), "eliza-packed-trigger-"));
  const output = testOutputPath("mobile-trigger-route-loader");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(output, { recursive: true });
  const corePort = path.join(output, "core-port.ts"),
    entry = path.join(output, "probe.ts"),
    builder = path.join(output, "build.ts");
  await writeFile(
    corePort,
    [
      `export * from ${JSON.stringify(path.join(root, "packages/core/src/utils/string-to-uuid.ts"))};`,
      `export * from ${JSON.stringify(path.join(root, "packages/core/src/services/trigger-scheduling.ts"))};`,
      `export * from ${JSON.stringify(path.join(root, "packages/core/src/types/trigger.ts"))};`,
      `export const logger={debug(message){if(message.includes('Cannot find package')&&message.includes('@elizaos/plugin-workflow'))globalThis.workflowModuleMissing=true;},warn(message){if(message.includes('Cannot find package')&&message.includes('@elizaos/plugin-workflow'))globalThis.workflowModuleMissing=true;}};`,
    ].join("\n"),
  );
  await writeFile(
    entry,
    `
import assert from 'node:assert/strict';
import {resolveOptionalPluginImportFailure} from ${JSON.stringify(path.join(root, "packages/agent/src/api/optional-plugin-fallback.ts"))};
import {normalizeTriggerDraft,buildTriggerConfig,buildTriggerMetadata,DISABLED_TRIGGER_INTERVAL_MS} from ${JSON.stringify(path.join(root, "packages/agent/src/triggers/scheduling.ts"))};
${loader}
const mode=process.argv[2],api=await getOptionalPluginApi('workflow');
const tasks=new Map();let executions=0,features=true;
const owner='00000000-0000-4000-8000-000000000001',room='00000000-0000-4000-8000-000000000002';
const runtime={agentId:'00000000-0000-4000-8000-000000000003',getService:()=>null,getRoom:async()=>({source:'client_chat'}),createTask:async task=>{const id=crypto.randomUUID();tasks.set(id,{...task,id});return id;},getTask:async id=>tasks.get(id)};
const valid={kind:'prompt',displayName:'Packed paused prompt',instructions:'Synthetic instructions; never execute',triggerType:'once',scheduledAtIso:'2099-01-01T00:00:00.000Z',timezone:'UTC',wakeMode:'inject_now',enabled:false};
async function request(body,options={}){
 let result={status:404,body:{error:'Not found'}};
 const handled=await api.handleTriggerRoutes({req:{},res:{},method:'POST',pathname:'/api/triggers',runtime,ownerEntityId:owner,localOwnerEntityId:owner,readJsonBody:async()=>body,json:(_res,data,status=200)=>{result={status,body:data};},error:(_res,error,status)=>{result={status,body:{error}};},resolvePromptDeliveryRoom:async()=>room,executeTriggerTask:async()=>{executions++;throw Error('Execution forbidden');},getTriggerHealthSnapshot:async()=>({}),getTriggerLimit:()=>100,listTriggerTasks:async()=>[...tasks.values()],readTriggerConfig:task=>task.metadata?.trigger,readTriggerRuns:()=>[],taskToTriggerSummary:task=>({...task.metadata.trigger,id:task.metadata.trigger.triggerId,taskId:task.id}),triggersFeatureEnabled:()=>features,normalizeTriggerDraft,buildTriggerConfig,buildTriggerMetadata,DISABLED_TRIGGER_INTERVAL_MS,TRIGGER_TASK_NAME:'TRIGGER_DISPATCH',TRIGGER_TASK_TAGS:['queue','repeat','trigger'],...options});
 return {...result,handled};
}
// This POST is the first trigger route: no feed read, warmup, or direct-handler import.
const cold=await request(valid);
if(mode==='android'&&cold.status!==201)console.error(JSON.stringify({coldStatus:cold.status,workflowModuleMissing:globalThis.workflowModuleMissing===true}));
if(mode==='android'){
 assert.equal(cold.status,201);assert.equal(cold.body.trigger.enabled,false);assert.equal(tasks.size,1);assert.equal(executions,0);
 const stored=[...tasks.values()][0];assert.equal(stored.entityId,owner);assert.equal(stored.metadata.ownership.ownerId,owner);assert.equal(stored.roomId,room);
 for(const options of [{ownerEntityId:undefined},{localOwnerEntityId:undefined}])assert.equal((await request({...valid,ownerEntityId:'forged'},options)).status,403);
 assert.equal((await request(valid,{runtime:null})).status,503);features=false;assert.equal((await request(valid)).status,503);features=true;
 assert.equal((await request({...valid,instructions:''})).status,400);assert.equal(tasks.size,1);assert.equal(executions,0);
}else{assert.equal(cold.status,404);assert.equal(cold.handled,false);assert.equal(tasks.size,0);assert.equal(globalThis.workflowModuleMissing===true,mode==='absent');}
const absent=await getOptionalPluginApi('mcp');assert.equal(await absent.handleMcpRoutes({}),false);
console.log(JSON.stringify({mode,coldStatus:cold.status,created:tasks.size,executions,ownerGates:true,optionalAbsence:true,workflowModuleMissing:globalThis.workflowModuleMissing===true}));
`,
  );
  await writeFile(
    builder,
    `
const [entry,output,corePort,mode,stub]=process.argv.slice(2);
const result=await Bun.build({entrypoints:[entry],outdir:output,target:'bun',format:'esm',conditions:['eliza-source'],...(mode==='absent'?{external:['@elizaos/plugin-workflow/trigger-routes']}:{}) ,plugins:[{name:'closed-runtime-ports',setup(build){build.onResolve({filter:/^@elizaos\\/core$/},()=>({path:corePort}));if(mode==='ios')build.onResolve({filter:/^@elizaos\\/plugin-workflow(?:\\/|$)/},()=>({path:stub}));}}]});
if(!result.success){console.error(result.logs);process.exit(1);}
`,
  );
  try {
    // The executable package lives outside the checkout and has no dependency tree.
    for (
      let ancestor: string | undefined = scratch;
      ancestor;
      ancestor =
        path.dirname(ancestor) === ancestor ? undefined : path.dirname(ancestor)
    ) {
      const { existsSync } = await import("node:fs");
      expect(existsSync(path.join(ancestor, "node_modules"))).toBe(false);
    }
    for (const mode of ["android", "ios", "absent"]) {
      const packed = path.join(scratch, mode);
      await mkdir(packed);
      const built = spawnSync(
        "bun",
        [
          "--no-install",
          builder,
          entry,
          packed,
          corePort,
          mode,
          path.join(root, "packages/agent/scripts/mobile-stubs/null-plugin.ts"),
        ],
        { cwd: root, encoding: "utf8", timeout: 30_000 },
      );
      await writeFile(
        path.join(output, `${mode}-build.log`),
        built.stdout + built.stderr,
      );
      expect(built.status, built.stderr).toBe(0);
      const executed = spawnSync(
        "bun",
        ["--no-install", path.join(packed, "probe.js"), mode],
        {
          cwd: packed,
          env: { PATH: process.env.PATH, TZ: "UTC" },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      await writeFile(
        path.join(output, `${mode}-runtime.log`),
        executed.stdout + executed.stderr,
      );
      expect(executed.status, executed.stderr).toBe(0);
      expect(JSON.parse(executed.stdout.trim())).toMatchObject({
        mode,
        coldStatus: mode === "android" ? 201 : 404,
        created: mode === "android" ? 1 : 0,
        executions: 0,
      });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 120_000);
