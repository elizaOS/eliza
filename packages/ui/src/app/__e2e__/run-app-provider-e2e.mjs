import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { installDefaultAppRoutes } from "../../../../app/test/ui-smoke/helpers.ts";
import { writeFixturePage } from "../../testing/e2e-runner/fixture-bundle.ts";
import { stubElizaCore, stubNodeBuiltins } from "../../testing/e2e-runner/esbuild-stubs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here,"../../../../..");
const nativeMode = process.env.NATIVE_PROVIDER_FIXTURE === "1";
const out = resolve(root,"test-results/shared-resident-conductor/" + (nativeMode ? "provider-browser-native" : "provider-browser"));
await mkdir(out,{recursive:true});
await writeFixturePage({entry:join(here,"app-provider-fixture.tsx"),outDir:out,htmlName:"provider.html",title:"Common provider",plugins:[stubElizaCore(),stubNodeBuiltins()],define:{"import.meta.env":JSON.stringify({DEV:false,PROD:true,VITE_ELIZA_ANDROID_RUNTIME_MODE:"local"}),"import.meta.url":"location.href"},processShim:true,tailwind:"none"});
const html = await readFile(join(out,"provider.html"));
const server=createServer((_req,res)=>{res.writeHead(200,{"content-type":"text/html"});res.end(html);});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:900,height:700}});
const requests=[],errors=[];
page.on("request",request=>{if(new URL(request.url()).pathname.startsWith("/api/"))requests.push({method:request.method(),path:new URL(request.url()).pathname});});
page.on("pageerror",error=>errors.push(error.message));
try{
  await installDefaultAppRoutes(page);
  await page.addInitScript((nativeMode)=>{
    localStorage.setItem("eliza:first-run-complete","1");
    if (!nativeMode) return;
    localStorage.setItem("eliza:mobile-runtime-mode","local");
    const realFetch = window.fetch.bind(window);
    window.androidBridge = {};
    window.nativeProviderCalls = [];
    window.Capacitor = {
      PluginHeaders:[{name:"Agent",methods:["start","getStatus","getLocalAgentBootState","request"].map(name=>({name,rtype:"promise"}))},{name:"ElizaSecureStore",methods:["get","set","remove"].map(name=>({name,rtype:"promise"}))}],
      nativePromise: async (plugin,method,input) => {
        window.nativeProviderCalls.push({plugin,method,...(input?.path?{path:input.path}:{} )});
        if(plugin==="ElizaSecureStore") return {ok:false,error:"not_found"};
        if(method==="start") return {state:"ready"};
        if(method==="getStatus") return {state:"running"};
        if(method==="getLocalAgentBootState") return {state:"listening"};
        if(method==="request") {
          const response=await realFetch(new URL(input.path,location.origin),{method:input.method,headers:input.headers,...(input.body?{body:input.body}:{})});
          return {status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()};
        }
        throw Error("Unexpected native fixture method: "+plugin+"."+method);
      },
    };
  }, nativeMode);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(()=>window.providerProbe?.phase==="ready"&&window.providerProbe?.auth==="authenticated",undefined,{timeout:30000});
  if(nativeMode)await page.waitForFunction(()=>window.providerProbe?.runtime==="verified",undefined,{timeout:30000});
  await page.waitForLoadState("networkidle");
  const before=requests.length;
  await page.getByRole("button",{name:"Unrelated render 0"}).click();
  await page.getByRole("button",{name:"Unrelated render 1"}).waitFor();
  await page.waitForFunction(()=>window.providerProbe?.commandQuery==="1");
  await page.waitForLoadState("networkidle");
  const after=requests.length;
  if(before!==after)throw Error("An unrelated render restarted provider requests");
  await page.screenshot({path:join(out,"ready.png")});
  await writeFile(join(out,"result.json"),JSON.stringify({probe:await page.evaluate(()=>window.providerProbe),requests,errors,nativeCalls:await page.evaluate(()=>window.nativeProviderCalls??null),unrelatedRenderRequests:after-before},null,2));
  if(errors.length)throw Error(errors.join("\n"));
  console.log("PASS common AppProvider + canonical API fixture reaches ready/authenticated and ignores unrelated reflow");
}finally{await writeFile(join(out,"all-requests.json"),JSON.stringify({requests,errors},null,2));await page.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
