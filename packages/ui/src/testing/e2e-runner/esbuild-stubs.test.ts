/**
 * Contract tests for the shared shell-fixture stubs bundle representative core
 * and Node built-in imports through real esbuild, then evaluate the browser
 * output. Any named symbol reached during bundling or module initialization must
 * remain a concrete export; a Proxy fallback cannot satisfy esbuild's named ESM
 * interop and crashes the fixture before the render path runs.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { stubElizaCore, stubNodeBuiltins } from "./esbuild-stubs";

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

async function bundleWithNodeStub(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eliza-node-stub-"));
  const entry = join(root, "entry.mjs");
  await writeFile(entry, source);
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "fixture",
    platform: "browser",
    plugins: [stubNodeBuiltins()],
  });
  const output = result.outputFiles?.[0]?.text;
  if (!output)
    throw new Error("esbuild produced no output for the Node stub bundle");
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

describe("stubNodeBuiltins", () => {
  it("exports the concrete host identity used during route preference initialization", async () => {
    const bundle = await bundleWithNodeStub(`
      import { hostname } from "node:os";
      export const observed = hostname();
    `);

    const evaluated = new Function(
      `${bundle}; return fixture.observed;`,
    )() as string;

    expect(evaluated).toBe("eliza-browser-fixture");
  });

  it("bundles shared loopback trust while keeping browser CIDR checks fail closed", async () => {
    const loopbackTrustPath = fileURLToPath(
      new URL("../../../../shared/src/loopback-trust.ts", import.meta.url),
    );
    const bundle = await bundleWithNodeStub(`
      import { isRemoteAddressInCidrList } from ${JSON.stringify(loopbackTrustPath)};
      export const observed = isRemoteAddressInCidrList(
        "172.17.0.1",
        "172.17.0.0/16",
      );
    `);

    const evaluated = new Function(
      `${bundle}; return fixture.observed;`,
    )() as boolean;

    expect(evaluated).toBe(false);
  });
});
