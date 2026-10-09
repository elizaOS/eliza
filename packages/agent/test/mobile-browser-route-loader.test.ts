/** Exercises the packed server's native-client decoder with real mobile browser code and closed transport ports. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

it("decodes the first authenticated native-client receipt without node_modules and retains native socket preference", async () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const source = await readFile(
    path.join(root, "packages/agent/src/api/server.ts"),
    "utf8",
  );
  const first = source.indexOf("function importOptionalPlugin<");
  const last = source.indexOf("// On mobile the agent bundle aliases", first);
  expect(first).toBeGreaterThanOrEqual(0);
  expect(last).toBeGreaterThan(first);
  // Exactly the actual server loader + authenticated native transport binder.
  const loader = source.slice(first, last);
  const output = testOutputPath("mobile-browser-route-loader");
  await mkdir(output, { recursive: true });
  const scratch = await mkdtemp(path.join(tmpdir(), "eliza-packed-browser-"));
  const file = (name: string) => path.join(output, name);
  const sourcePath = (name: string) => JSON.stringify(path.join(root, name));
  await writeFile(
    file("core-port.ts"),
    [
      `export {ElizaError} from ${sourcePath("packages/core/src/errors.ts")};`,
      `export {Service} from ${sourcePath("packages/core/src/types/service.ts")};`,
      `export {promoteSubactionsToActions} from ${sourcePath("packages/core/src/actions/promote-subactions.ts")};`,
      `export {createShellNavigateViewWsFrame} from ${sourcePath("packages/core/src/events.ts")};`,
      "export const logger={info(){},warn(){},debug(){}};",
    ].join("\n"),
  );
  await writeFile(
    file("protocol-port.ts"),
    [
      `export {asObjectRecord} from ${sourcePath("packages/core/src/utils/type-guards.ts")};`,
      `export {readViewInteractionClientId} from ${sourcePath("packages/core/src/views/view-interact-protocol.ts")};`,
      `export {resolveEnvAlias} from ${sourcePath("packages/core/src/utils/env.ts")};`,
      `export {ElizaError} from ${sourcePath("packages/core/src/errors.ts")};`,
      `export {canonicalJsonString} from ${sourcePath("packages/core/src/canonical-json.ts")};`,
    ].join("\n"),
  );
  await writeFile(
    file("host-port.ts"),
    `export {resolveAliasedEnvValue as resolveAppAliasedEnvValue} from ${sourcePath("packages/host/src/config/boot-config-store.ts")};`,
  );
  await writeFile(
    file("views-port.ts"),
    `
export const getViewsBroadcastWsToClientId=host=>host===globalThis.ownedHost?()=>1:undefined;
export const dispatchViewInteract=async(entry,view,action,params,options)=>{
 globalThis.dispatches++;if(options.hostKey!==globalThis.ownedHost||options.clientId!=='owned-client')throw Error('Foreign client');
 return {success:true,result:globalThis.nativeReceipt};
};
export const getView=()=>globalThis.viewAvailable?{}:null;
`,
  );
  await writeFile(
    file("probe.ts"),
    `
import assert from 'node:assert/strict';
import {ElizaError} from './core-port.ts';
import {runWithViewClient,getViewClientScope} from ${sourcePath("packages/agent/src/runtime/view-client-context.ts")};
let browserPluginModule, browserPluginModulePromise;
const EventType={SERVICE_STARTED:'service-started'};
${loader}
globalThis.ownedHost={};globalThis.viewAvailable=true;globalThis.dispatches=0;
globalThis.nativeReceipt={ok:true,data:{representation:'android-accessibility',packageName:'org.chromium.chrome',snapshotId:'synthetic-snapshot',complete:true,elements:[]}};
let transport;
const runtime={getService:()=>({setNativeClientTransport:value=>{transport=value;}}),registerEvent(){}};
wireNativeBrowserPageReader(runtime);
const command={subaction:'snapshot'};
const owned=fn=>runWithViewClient({clientId:'owned-client',hostKey:globalThis.ownedHost},fn);
await assert.rejects(()=>transport.executeCommand('owned-client',command),e=>e.code==='VIEW_CLIENT_REQUIRED');
await assert.rejects(()=>runWithViewClient({clientId:'other-client',hostKey:globalThis.ownedHost},()=>transport.executeCommand('owned-client',command)),e=>e.code==='VIEW_CLIENT_REQUIRED');
await assert.rejects(()=>runWithViewClient({clientId:'owned-client',hostKey:{}},()=>transport.executeCommand('owned-client',command)),/transport is unavailable/);
assert.equal(globalThis.dispatches,0);
// Cold real server helper, before any direct plugin import or warm-up.
const receipt=await owned(()=>transport.executeCommand('owned-client',command));
assert.equal(receipt.targetId,'native-client');assert.equal(receipt.value.snapshotId,'synthetic-snapshot');assert.equal(globalThis.dispatches,1);
globalThis.nativeReceipt={ok:true,data:{representation:'android-accessibility',packageName:'org.chromium.chrome',snapshotId:'incomplete',complete:false,elements:[]}};
await assert.rejects(()=>owned(()=>transport.executeCommand('owned-client',command)),/Incomplete Chromium accessibility snapshot/);
globalThis.nativeReceipt={ok:false,code:'STALE_REF',message:'Refresh the same snapshot.'};
await assert.rejects(()=>owned(()=>transport.executeCommand('owned-client',{subaction:'click',selector:'ref:synthetic'})),e=>e.kind==='STALE_REF'&&e.targetId==='native-client');
globalThis.viewAvailable=false;const before=globalThis.dispatches;
await assert.rejects(()=>owned(()=>transport.executeCommand('owned-client',command)),/transport is unavailable/);assert.equal(globalThis.dispatches,before);
// The same packed public mobile module keeps its preferred socket path. No socket is opened.
const plugin=await getBrowserPlugin(),service=new plugin.BrowserService(runtime);let socketCalls=0;
service.nativeTarget={available:async()=>true,execute:async()=>{socketCalls++;return {targetId:'chromium-device',value:'socket-result'};}};
service.setNativeClientTransport({executeCommand:async()=>{throw Error('Fallback must not run');}});
assert.equal((await service.execute(command)).value,'socket-result');assert.equal(socketCalls,1);
console.log(JSON.stringify({coldReceipt:true,ownerRefusals:3,incompleteRefused:true,staleReceiptRefused:true,missingViewRefused:true,nativeSocketPreferred:true,realBrowserFactory:true}));
`,
  );
  await writeFile(
    file("build.ts"),
    `
const [entry,outdir,root,ports]=process.argv.slice(2);
const result=await Bun.build({entrypoints:[entry],outdir,target:'bun',format:'esm',conditions:['eliza-source'],plugins:[{name:'mobile-browser-and-closed-host-ports',setup(build){
 build.onResolve({filter:/^@elizaos\\/plugin-browser$/},()=>({path:root+'/plugins/plugin-browser/src/mobile.ts'}));
 build.onResolve({filter:/^@elizaos\\/core$/},()=>({path:ports+'/core-port.ts'}));
 build.onResolve({filter:/^@elizaos\\/core\\/protocol$/},()=>({path:ports+'/protocol-port.ts'}));
 build.onResolve({filter:/^@elizaos\\/host\\/protocol$/},()=>({path:ports+'/host-port.ts'}));
 build.onResolve({filter:/^@elizaos\\/contracts$/},()=>({path:root+'/packages/contracts/src/contracts/remote-control.ts'}));
 build.onResolve({filter:/^\\.\\/views-(?:routes|registry)\\.ts$/},()=>({path:ports+'/views-port.ts'}));
}}]});if(!result.success){console.error(result.logs);process.exit(1);}
`,
  );
  try {
    for (
      let ancestor: string | undefined = scratch;
      ancestor;
      ancestor =
        path.dirname(ancestor) === ancestor ? undefined : path.dirname(ancestor)
    ) {
      expect(existsSync(path.join(ancestor, "node_modules"))).toBe(false);
    }
    const built = spawnSync(
      "bun",
      [
        "--no-install",
        file("build.ts"),
        file("probe.ts"),
        scratch,
        root,
        output,
      ],
      { cwd: root, encoding: "utf8", timeout: 30_000 },
    );
    await writeFile(file("build.log"), built.stdout + built.stderr);
    expect(built.status, built.stderr).toBe(0);
    const executed = spawnSync(
      "bun",
      ["--no-install", path.join(scratch, "probe.js")],
      {
        cwd: scratch,
        env: { PATH: process.env.PATH, TZ: "UTC" },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    await writeFile(file("runtime.log"), executed.stdout + executed.stderr);
    expect(executed.status, executed.stderr).toBe(0);
    expect(JSON.parse(executed.stdout.trim())).toMatchObject({
      coldReceipt: true,
      ownerRefusals: 3,
      nativeSocketPreferred: true,
      realBrowserFactory: true,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 60_000);
