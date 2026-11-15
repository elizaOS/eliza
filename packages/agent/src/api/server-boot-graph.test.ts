/**
 * Importing the API server must not load the OpenAI tokenizer rank tables,
 * `ethers`, the wallet transaction service or `@elizaos/plugin-todos` (loaded
 * only when a shared Todo import runs, so a host may leave it out of its
 * bundle): the server needs only the
 * OpenAI settings readers (`@elizaos/plugin-openai/config`) and the trade
 * policy (`@elizaos/plugin-wallet/lib/trade-safety`). On a phone those
 * modules cost tens of MB of heap at boot for routes that may never run.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const agentRoot = path.resolve(import.meta.dirname, "../..");

const HEAVY =
  /gpt-tokenizer|js-tiktoken\/dist\/(index|ranks)|\/ethers\/|plugin-wallet\/src\/(transactions|services\/tx-service)\.ts|plugin-openai\/(index\.ts|models\/)|plugin-todos\//;

describe("API server import graph", () => {
  it("loads no tokenizer, ethers, wallet transaction or plugin-todos module", () => {
    const probe = `
      import { registerHooks } from "node:module";
      import { pathToFileURL } from "node:url";
      const seen = [];
      registerHooks({ resolve(spec, ctx, next) { const r = next(spec, ctx); seen.push(r.url); return r; } });
      await import(pathToFileURL(${JSON.stringify(path.join(agentRoot, "src/api/server.ts"))}).href);
      console.log(JSON.stringify({ count: seen.length, heavy: seen.filter((u) => ${HEAVY}.test(u)) }));
    `;
    const stdout = execFileSync(
      "node",
      [
        "--conditions=eliza-source",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        probe,
      ],
      {
        cwd: agentRoot,
        encoding: "utf8",
        timeout: 170_000,
        maxBuffer: 64 * 1024 * 1024,
        // Import only: no runtime boot, provider keys or network calls.
        env: { PATH: process.env.PATH, NODE_ENV: "test" },
      },
    );
    const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
    expect(result.count).toBeGreaterThan(100);
    expect(result.heavy).toEqual([]);
  }, 180_000);
});
