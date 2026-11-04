/** Actual owning configs and SSR/__vitest__ targets. Allowlisted workspace values and static dependencies initialize via public project.import; no test callbacks started. */
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
const root = "/workspace";
const require = createRequire(root + "/node_modules/vitest/vitest.mjs");
const { createVitest } = await import(pathToFileURL(require.resolve("vitest/node")).href);
const definition = JSON.parse(fs.readFileSync("/results/PREFLIGHT-DEFINITION.json", "utf8"));
const outputReceipt=JSON.parse(fs.readFileSync("/results/OUTPUTS-after.json","utf8"));
const freshOutputs=new Map(outputReceipt.records.map(x=>[x.path,x]));
if(outputReceipt.sourceCommit!=="ff04a558747ed426d9d871a319f7b3946f7660e6"||outputReceipt.mode!=="after")throw new Error("Wrong fresh output subject");
const records = [];
const originalCacheEnv=process.env.VITEST_FS_MODULE_CACHE_PATH;
for (const projectDefinition of definition.projects) {
  let context;
  try {
    process.env.VITEST_FS_MODULE_CACHE_PATH="/results/preflight-cache-"+projectDefinition.name;
    context = await createVitest("test", {
      root: root + "/" + projectDefinition.root,
      config: root + "/" + projectDefinition.root + "/vitest.config.ts",
      configLoader: "runner", watch: false, pool: "forks", maxWorkers: 1,
      maxConcurrency: 1, fileParallelism: false, cache: false,
      fsModuleCachePath: "/results/preflight-cache-" + projectDefinition.name,
    });
    const project = context.getRootProject();
    const server = project.vite;
    const ssr = server?.environments?.ssr;
    if (!ssr) throw new Error("Missing real owning SSR environment");
    if (server.config.configFile !== root + "/" + projectDefinition.root + "/vitest.config.ts") throw new Error("Wrong owning config file");
    if (!Array.isArray(ssr.config.resolve.conditions) || !Array.isArray(ssr.config.resolve.externalConditions)) throw new Error("Missing effective owning resolver conditions");
    const testEnvironment=server.environments.__vitest__;
    if(!testEnvironment)throw new Error("Actual Vitest transform environment absent");
    const imports = [];
    for (const edge of projectDefinition.edges) {
      const name = edge.specifier;
      const target = definition.targets[edge.target];
      const expected = root + "/" + target.path;
      const importer = root + "/" + edge.importer;
      const importerDigest = createHash("sha256").update(fs.readFileSync(importer)).digest("hex");
      if (importerDigest !== edge.importerSHA256) throw new Error("Declaring importer bytes changed: " + edge.importer);
      const resolved = await ssr.pluginContainer.resolveId(name, importer);
      if (!resolved || resolved.id.split("?")[0] !== expected) throw new Error("Wrong normal selected-target resolution: " + name);
      // Match the normal Vitest ServerModuleRunner's resolved-file URL path.
      // Raw fetchModule(bareName, importer) directly uses Node package entries,
      // bypassing the alias resolution that already selected this pinned file.
      const relative = name.startsWith(".");
      const resolutionRoot=ssr.config.root.replace(/\/$/, "");
      const fetchId=resolved.id.startsWith(resolutionRoot+"/")
        ? resolved.id.slice(resolutionRoot.length) : "/@fs"+resolved.id;
      const fetched = await ssr.fetchModule(fetchId);
      if (fetched.externalize) {
        if (new URL(fetched.externalize).protocol !== "file:" || new URL(fetched.externalize).pathname !== expected) throw new Error("Wrong normal external selected-target resolution: " + name);
      } else {
        if (fetched.file !== expected || fetched.id?.split("?")[0] !== expected) throw new Error("Wrong normal selected-target transform: " + name);
      }
      const runtimeResolved=await testEnvironment.pluginContainer.resolveId(name,importer);
      if(!runtimeResolved||runtimeResolved.id.split("?")[0]!==expected)throw new Error("Actual __vitest__ source target differs from normal SSR target: "+name);
      // Exercise the same public bare package entry spelling used by tests;
      // importing the resolved file alone would bypass bare externalization.
      const actualImportId=relative?runtimeResolved.id:name;
      const actualValues=await project.import(actualImportId);
      const canonicalValues=await project.import(expected);
      for(const value of target.requiredExports??[]){
        if(typeof actualValues[value]!=="function"||actualValues[value]!==canonicalValues[value])throw new Error("Bare/resolved canonical runtime value identity differs: "+name+"/"+value);
      }
      if(target.allPublicExportIdentity){
        const keys=Object.keys(actualValues).sort(),canonicalKeys=Object.keys(canonicalValues).sort();
        if(!keys.length||JSON.stringify(keys)!==JSON.stringify(canonicalKeys)||keys.some(key=>actualValues[key]!==canonicalValues[key]))throw new Error("Normal selected-target namespace identity differs: "+name);
      }
      const digest = createHash("sha256").update(fs.readFileSync(expected)).digest("hex");
      if (digest !== (target.provenance==="FRESH_NORMAL_PRODUCER_OUTPUT" ? freshOutputs.get(target.path)?.sha256 : target.sha256)) throw new Error("Owning entry bytes changed: " + name);
      imports.push({ name, importer, importerSHA256: importerDigest, scope: edge.scope, target: edge.target, targetProvenance:target.provenance, allPublicExportIdentity:target.allPublicExportIdentity??false, fetchId, actualValueEnvironment:"__vitest__ via public project.import", runtimeResolved:runtimeResolved.id, actualImportId, canonicalAbsoluteImport:expected, requiredValueIdentityChecked:true, requiredValueExports:target.requiredExports??[], fetchedFile: fetched.file ?? null, fetchedId: fetched.id ?? null, resolved: resolved.id, externalize: fetched.externalize ?? null, sha256: digest });
    }
    records.push({ name: projectDefinition.name, config: server.config.configFile,
      conditions: ssr.config.resolve.conditions, externalConditions: ssr.config.resolve.externalConditions,
      testEnvironmentConditions:testEnvironment.config.resolve.conditions, testEnvironmentExternalConditions:testEnvironment.config.resolve.externalConditions, imports, testsStarted: false, closed: false });
  } finally {
    if(originalCacheEnv===undefined)delete process.env.VITEST_FS_MODULE_CACHE_PATH;else process.env.VITEST_FS_MODULE_CACHE_PATH=originalCacheEnv;
    if (context) {
      await context.close();
      if (records.at(-1)?.name === projectDefinition.name) records.at(-1).closed = true;
    }
  }
}
fs.writeFileSync("/results/OWNING-PREFLIGHT.json", JSON.stringify({ records, workspaceValueModulesImported: true, staticDependencyInitializationPossible: true, testsStarted: false,
  scope: "Actual config/SSR/__vitest__ public workspace-value imports and possible static dependency initialization, then context closure. No test callback/provider/model/native/voice acceptance" }, null, 2) + "\n");
