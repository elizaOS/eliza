/**
 * Exercises the real personal-assistant consumer against a generated staged
 * dependency graph in Bun. No loader mocks or live model calls are involved.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

it("loads personal-assistant with its staged agent runtime dependencies", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "pa-staged-consumer-"));
  try {
    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      import { stageColdPluginImportRoot } from "./packages/agent/src/runtime/plugin-resolver.ts";
      const root = path.resolve("plugins/plugin-personal-assistant");
      const staged = await stageColdPluginImportRoot({
        installRoot: root,
        packageRoot: root,
        packageName: "@elizaos/plugin-personal-assistant",
        packageRelativePath: [],
      });
      await import(pathToFileURL(path.join(staged, "src/index.ts")).href);
      process.stdout.write("STAGED_CONSUMER_LOADED\\n");
      process.exit(0);
    `;
    const output = execFileSync(
      "bun",
      ["--no-install", "--conditions=eliza-source", "--eval", script],
      {
        cwd: repositoryRoot,
        env: { ...process.env, ELIZA_STATE_DIR: state },
        encoding: "utf8",
        timeout: 300_000,
      },
    );
    expect(output).toContain("STAGED_CONSUMER_LOADED");
  } finally {
    await fs.rm(state, { recursive: true, force: true });
  }
}, 360_000);
