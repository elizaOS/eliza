import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const [packageJson, inputPath] = process.argv.slice(2);
if (!packageJson || !inputPath)
  throw new Error(
    "Native image bridge requires an OpenClaw package and turn payload",
  );
const require = createRequire(packageJson);
const { agentCommand } = await import(
  pathToFileURL(require.resolve("openclaw/plugin-sdk/agent-runtime")).href
);
if (typeof agentCommand !== "function")
  throw new Error("Installed OpenClaw lacks native agentCommand API");
const options = JSON.parse(await readFile(inputPath, "utf8"));
await agentCommand({ ...options, deliver: false, json: true });
