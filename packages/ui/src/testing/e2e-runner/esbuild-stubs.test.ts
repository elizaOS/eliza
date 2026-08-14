/**
 * Contract test for the `@elizaos/core` fixture stub: bundles a module that
 * subclasses `ElizaError` through real esbuild with `stubElizaCore()`, then
 * evaluates the output. The stub replaces core's Node graph, but any symbol a
 * fixture actually *uses at evaluation time* must be a working implementation —
 * a Proxy fallback surfaces `undefined` through esbuild's ESM interop, and
 * `class … extends undefined` crashes the whole bundle at load. `client-cloud.ts`
 * subclasses `ElizaError`, so the stub must export a real one rather than force
 * production code to guard its own base class.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { stubElizaCore } from "./esbuild-stubs";

async function bundleWithCoreStub(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eliza-core-stub-"));
  const entry = join(root, "entry.mjs");
  await writeFile(entry, source);
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "fixture",
    platform: "browser",
    plugins: [stubElizaCore()],
  });
  const output = result.outputFiles?.[0]?.text;
  if (!output)
    throw new Error("esbuild produced no output for the stub bundle");
  return output;
}

describe("stubElizaCore", () => {
  it("exports a real ElizaError a fixture bundle can subclass", async () => {
    const bundle = await bundleWithCoreStub(`
      import { ElizaError } from "@elizaos/core";
      class WakeError extends ElizaError {}
      const thrown = new WakeError("wake failed", {
        code: "CLOUD_AGENT_WAKE_FAILED",
        context: { phase: "resume", agentId: "agent-1" },
        cause: new Error("HTTP 402"),
      });
      export const observed = {
        isElizaError: thrown instanceof ElizaError,
        isWakeError: thrown instanceof WakeError,
        message: thrown.message,
        code: thrown.code,
        context: thrown.context,
        causeMessage: thrown.cause instanceof Error ? thrown.cause.message : null,
      };
    `);

    const evaluated = new Function(`${bundle}; return fixture.observed;`)() as {
      isElizaError: boolean;
      isWakeError: boolean;
      message: string;
      code: string;
      context: Record<string, unknown>;
      causeMessage: string | null;
    };

    expect(evaluated.isElizaError).toBe(true);
    expect(evaluated.isWakeError).toBe(true);
    expect(evaluated.message).toBe("wake failed");
    expect(evaluated.code).toBe("CLOUD_AGENT_WAKE_FAILED");
    expect(evaluated.context).toEqual({ phase: "resume", agentId: "agent-1" });
    expect(evaluated.causeMessage).toBe("HTTP 402");
  });

  it("still proxies unnamed core symbols and never bundles core's Node graph", async () => {
    // Property reads go through the Proxy, so anything a fixture only touches
    // dynamically keeps its no-op answer. A NAMED import cannot: esbuild's
    // interop copies own keys, which is exactly why ElizaError has to be a
    // concrete export above.
    const bundle = await bundleWithCoreStub(`
      import core from "@elizaos/core";
      export const observed = typeof core.someSymbolThatDoesNotExist;
    `);

    const evaluated = new Function(
      `${bundle}; return fixture.observed;`,
    )() as string;

    expect(evaluated).toBe("function");
    expect(bundle).not.toContain("node:crypto");
  });

  it("exports concrete render-path text helpers for named imports", async () => {
    const bundle = await bundleWithCoreStub(`
      import { stripUnclaimedInteractionMarkup } from "@elizaos/core";
      export const observed = stripUnclaimedInteractionMarkup("fixture reply");
    `);

    const evaluated = new Function(
      `${bundle}; return fixture.observed;`,
    )() as string;

    expect(evaluated).toBe("fixture reply");
  });
});
