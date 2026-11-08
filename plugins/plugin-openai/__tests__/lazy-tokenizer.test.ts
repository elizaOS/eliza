/**
 * The tokenizer rank tables are large (six BPE encoders, tens of MB of heap
 * once built), so the plugin root must not load them at import time; a
 * tokenizer call loads only the encoding it needs. (The agent's
 * server-boot-graph test covers the `./config` subpath.)
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import o200k from "gpt-tokenizer/encoding/o200k_base";
import { describe, expect, it } from "vitest";
import { handleTokenizerDecode, handleTokenizerEncode } from "../models/tokenizer";
import {
  loadEncoder,
  loadedEncodingNames,
  resolveTokenizerEncodingName,
} from "../utils/tokenization";

const pluginRoot = path.resolve(import.meta.dirname, "..");

/** Imports `specifier` from the plugin root in a fresh Node and lists every module it resolved. */
function resolvedModules(specifier: string): string[] {
  const probe = `
    import { registerHooks } from "node:module";
    const seen = [];
    registerHooks({ resolve(spec, ctx, next) { const r = next(spec, ctx); seen.push(r.url); return r; } });
    const imported = await import(${JSON.stringify(specifier)});
    console.log(JSON.stringify({ exports: Object.keys(imported).length, seen }));
  `;
  const stdout = execFileSync(
    "node",
    ["--conditions=eliza-source", "--import", "tsx", "--input-type=module", "--eval", probe],
    {
      cwd: pluginRoot,
      encoding: "utf8",
      timeout: 60_000,
      env: { PATH: process.env.PATH, NODE_ENV: "test" },
    }
  );
  const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
  expect(result.exports).toBeGreaterThan(0);
  return result.seen;
}

const RANK_TABLES = /gpt-tokenizer\/.*encoding|js-tiktoken\/dist\/(index|ranks)/;

function runtimeWith(settings: Record<string, string>): IAgentRuntime {
  return { getSetting: (key: string) => settings[key] } as unknown as IAgentRuntime;
}

describe("tokenizer loading", () => {
  it("the plugin root loads no rank table until a tokenizer handler runs", () => {
    const seen = resolvedModules("@elizaos/plugin-openai");
    expect(seen.filter((url) => RANK_TABLES.test(url))).toEqual([]);
  }, 65_000);

  it("a tokenizer call loads only the encoding its model uses and caches it", async () => {
    expect(loadedEncodingNames()).toEqual([]);
    const runtime = runtimeWith({ OPENAI_LARGE_MODEL: "gpt-4o" });
    const text = "Grace keeps the agent heap small.";

    const tokens = await handleTokenizerEncode(runtime, {
      prompt: text,
      modelType: ModelType.TEXT_LARGE,
    });
    expect(tokens).toEqual(o200k.encode(text));
    expect(loadedEncodingNames()).toEqual(["o200k_base"]);
    await expect(
      handleTokenizerDecode(runtime, { tokens, modelType: ModelType.TEXT_LARGE })
    ).resolves.toBe(text);

    const [first, second] = await Promise.all([
      loadEncoder("o200k_base"),
      loadEncoder("o200k_base"),
    ]);
    expect(first).toBe(second);
    expect(loadedEncodingNames()).toEqual(["o200k_base"]);
  });

  it("shares a pending import and retries its rejection without evicting another encoding", () => {
    // Fail one resolution at the dynamic-import boundary. Both successful
    // encoders still come from the real rank modules in a fresh process.
    const probe = `
      import assert from "node:assert/strict";
      import { registerHooks } from "node:module";
      const { loadEncoder, loadedEncodingNames } = await import("./utils/tokenization.ts");
      const failedImport = new Error("one rank import is unavailable");
      let attempts = 0;
      const hooks = registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === "gpt-tokenizer/encoding/cl100k_base" && ++attempts === 1) {
            throw failedImport;
          }
          return nextResolve(specifier, context);
        },
      });
      try {
        const retained = loadEncoder("o200k_base");
        const first = loadEncoder("cl100k_base");
        const shared = loadEncoder("cl100k_base");
        assert.equal(shared, first);
        assert.notEqual(first, retained);
        assert.deepEqual(loadedEncodingNames(), ["o200k_base", "cl100k_base"]);
        const rejected = await Promise.allSettled([first, shared]);
        for (const result of rejected) {
          assert.equal(result.status, "rejected");
          assert.equal(result.reason, failedImport);
        }
        assert.deepEqual(loadedEncodingNames(), ["o200k_base"]);
        assert.equal(loadEncoder("o200k_base"), retained);
        const retry = loadEncoder("cl100k_base");
        assert.notEqual(retry, first);
        assert.equal(loadEncoder("cl100k_base"), retry);
        const [retryEncoder, retainedEncoder] = await Promise.all([retry, retained]);
        assert.notEqual(retryEncoder, retainedEncoder);
        const text = "First failure, then the original encoding.";
        assert.equal(retryEncoder.decode(retryEncoder.encode(text)), text);
        assert.equal(retainedEncoder.decode(retainedEncoder.encode(text)), text);
        assert.deepEqual(loadedEncodingNames(), ["o200k_base", "cl100k_base"]);
        assert.equal(attempts, 2);
        console.log(JSON.stringify({ attempts, sharedRejections: rejected.length }));
      } finally {
        hooks.deregister();
      }
    `;
    const stdout = execFileSync(
      "node",
      ["--conditions=eliza-source", "--import", "tsx", "--input-type=module", "--eval", probe],
      {
        cwd: pluginRoot,
        encoding: "utf8",
        timeout: 60_000,
        env: { PATH: process.env.PATH, NODE_ENV: "test" },
      }
    );
    expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")).toEqual({
      attempts: 2,
      sharedRejections: 2,
    });
  }, 65_000);

  it("keeps the fallback encodings for model names outside the registry", () => {
    expect(resolveTokenizerEncodingName("custom-4o-mini-next")).toBe("o200k_base");
    expect(resolveTokenizerEncodingName("custom-model")).toBe("cl100k_base");
    expect(resolveTokenizerEncodingName("gpt-3.5-turbo")).toBe("cl100k_base");
  });
});
