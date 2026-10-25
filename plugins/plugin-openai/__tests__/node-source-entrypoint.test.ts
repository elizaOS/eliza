/** Exercise the Node+tsx loader used by the local dev host, outside Vite/Bun resolution. */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pluginRoot = path.resolve(import.meta.dirname, "..");

const importProbe = `
  import { readFileSync } from "node:fs";
  import { pathToFileURL } from "node:url";
  import { resolve } from "node:path";
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const entry = manifest.elizaos.plugin.workspaceSource["."];
  const imported = await import(pathToFileURL(resolve(entry)).href);
  console.log(JSON.stringify({
    name: imported.default.name,
    init: typeof imported.default.init,
    text: typeof imported.default.models.TEXT_LARGE,
    namedExportMatchesDefault: imported.openaiPlugin === imported.default,
  }));
`;

describe("Node dev source entrypoint", () => {
  it("loads the declared workspace plugin using Node with eliza-source and tsx", () => {
    const stdout = execFileSync(
      "node",
      [
        "--conditions=eliza-source",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        importProbe,
      ],
      {
        cwd: pluginRoot,
        encoding: "utf8",
        timeout: 60_000,
        // Import and inspect only: no provider keys, runtime boot, or network calls.
        env: { PATH: process.env.PATH, NODE_ENV: "test" },
      }
    );
    expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")).toEqual({
      name: "openai",
      init: "function",
      text: "function",
      namedExportMatchesDefault: true,
    });
  }, 65_000);
});
