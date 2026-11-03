/** Real owning configs and SSR resolver, no tests started or workspace modules evaluated. */
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
const root = "/workspace";
const require = createRequire(root + "/node_modules/vitest/vitest.mjs");
const { createVitest } = await import(pathToFileURL(require.resolve("vitest/node")).href);
const definition = JSON.parse(fs.readFileSync("/results/PREFLIGHT-DEFINITION.json", "utf8"));
const records = [];
for (const projectDefinition of definition.projects) {
  let context;
  try {
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
    if (!ssr.config.resolve.conditions.includes("eliza-source") || !ssr.config.resolve.externalConditions.includes("eliza-source") || !ssr.config.resolve.externalConditions.includes("module-sync")) throw new Error("Missing owning source/default external conditions");
    const imports = [];
    for (const name of projectDefinition.imports) {
      const target = definition.targets[name];
      const expected = root + "/" + target.path;
      const importer = root + "/" + projectDefinition.importer;
      const resolved = await ssr.pluginContainer.resolveId(name, importer);
      if (!resolved || resolved.id.split("?")[0] !== expected) throw new Error("Wrong normal source resolution: " + name);
      const fetched = await ssr.fetchModule(name, importer);
      if (fetched.externalize && new URL(fetched.externalize).pathname !== expected) throw new Error("Wrong bare external source resolution: " + name);
      const digest = createHash("sha256").update(fs.readFileSync(expected)).digest("hex");
      if (digest !== target.sha256) throw new Error("Owning entry bytes changed: " + name);
      imports.push({ name, importer, resolved: resolved.id, externalize: fetched.externalize ?? null, sha256: digest });
    }
    records.push({ name: projectDefinition.name, config: server.config.configFile,
      conditions: ssr.config.resolve.conditions, externalConditions: ssr.config.resolve.externalConditions,
      imports, testsStarted: false, closed: false });
  } finally {
    if (context) {
      await context.close();
      if (records.at(-1)?.name === projectDefinition.name) records.at(-1).closed = true;
    }
  }
}
fs.writeFileSync("/results/OWNING-PREFLIGHT.json", JSON.stringify({ records,
  scope: "Actual config load/normal+bare source resolver and context closure only; no test/runtime/provider/voice acceptance" }, null, 2) + "\n");
