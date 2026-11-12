/** Checks real encoder bytes, reuse and idle release alongside the cache model. */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const output = testOutputPath("cloud-formal", "conformance", "tokenizer-cache");
mkdirSync(output, { recursive: true });
function check(name: string, args: string[]): void {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=eliza-source",
      path.join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      ...args,
    ],
    {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(path.join(output, `${name}.log`), log);
  process.stdout.write(log);
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Conformance failed for ${name}: ${result.status ?? result.signal}`,
    );
}
for (const name of ["plugin-elizacloud", "plugin-openai"]) {
  const config = path.join(output, `${name}.config.mjs`);
  const configSource = [
    `import base from ${JSON.stringify(path.join(root, "plugins", name, "vitest.config.ts"))};`,
    `import { buildWorkspaceSourceAliases } from ${JSON.stringify(path.join(root, "packages/scripts/vitest/source-aliases.ts"))};`,
    `export default {...base, root: ${JSON.stringify(path.join(root, "plugins", name))}, resolve: {...base.resolve, alias:[...buildWorkspaceSourceAliases(${JSON.stringify(root)}), ...(base.resolve?.alias ?? [])]}};`,
  ].join("\n");
  writeFileSync(config, `${configSource}\n`);
  check(name, ["--config", config, "__tests__/lazy-tokenizer.test.ts"]);
}
check("api-server-imports", [
  "--config",
  path.join(root, "packages/agent/vitest.config.ts"),
  "packages/agent/src/api/server-boot-graph.test.ts",
]);
