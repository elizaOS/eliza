import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Source-level guard for the `/api/cloud/disconnect` orphan-route fix.
 *
 * Background: when the user disconnects from elizacloud, the loopback
 * patch must clear EVERY service that may have been routed at
 * `cloud-proxy → elizacloud`, not just `llmText`. Otherwise tts /
 * media / embeddings / rpc keep silently 401'ing for months until the
 * user notices their voice/image/embedding features stopped working.
 *
 * This test is a compile-free guard: it asserts the literal patch in
 * the cloud-route plugin (`plugin.ts`) lists all five `serviceRouting`
 * keys. The patch object is wired inline in the disconnect handler;
 * we verify the patch SHAPE by reading the source text rather than
 * spinning up the runtime route plugin system. If a future refactor
 * extracts the patch into a named constant + export, replace this test
 * with a direct import + structural assertion.
 *
 * Failure mode this test guards against: someone removes one of the
 * service-routing keys (or adds a new routed service without nulling
 * it on disconnect), reintroducing the original orphan-route bug.
 *
 * Migrated from packages/app-core/src/api/server.cloud-disconnect.test.ts
 * when the cloud route handlers moved into plugin-elizacloud.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_TS = path.resolve(HERE, "..", "plugin.ts");

function readPluginSource(): string {
  return readFileSync(PLUGIN_TS, "utf8");
}

function findDisconnectPatchBlock(source: string): string {
  const startMarker = "const disconnectPatch = {";
  const startIdx = source.indexOf(startMarker);
  expect(
    startIdx,
    "Expected `const disconnectPatch = { ... }` literal in plugin-elizacloud plugin.ts handler for /api/cloud/disconnect"
  ).toBeGreaterThanOrEqual(0);

  // Walk braces forward to find the matching closing brace of the patch
  // object literal. Naïve depth counter is fine: there are no string
  // literals containing `{` or `}` inside this patch.
  let depth = 0;
  let i = startIdx + startMarker.length - 1; // position on the opening `{`
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(startIdx, i + 1);
    }
  }
  throw new Error("Unbalanced braces while extracting disconnectPatch object literal");
}

describe("/api/cloud/disconnect orphan-route patch", () => {
  it("clears llmText, tts, media, embeddings, and rpc service routes", () => {
    const block = findDisconnectPatchBlock(readPluginSource());

    // Each route must be explicitly nulled (not just present, not set
    // to a string, not commented out).
    for (const key of ["llmText", "tts", "media", "embeddings", "rpc"]) {
      expect(
        block,
        `Expected serviceRouting.${key} to be cleared (set to null) in the disconnect patch`
      ).toMatch(new RegExp(`\\b${key}\\s*:\\s*null\\b`));
    }
  });

  it("disables cloud and clears the cached apiKey", () => {
    const block = findDisconnectPatchBlock(readPluginSource());
    expect(block).toMatch(/\benabled\s*:\s*false\b/);
    expect(block).toMatch(/\bapiKey\s*:\s*null\b/);
  });

  it("marks the elizacloud linked-account as unlinked", () => {
    const block = findDisconnectPatchBlock(readPluginSource());
    // Guards against the auto-reconnect-on-restart bug: state.config
    // must explicitly carry status="unlinked" so the next saveElizaConfig
    // does not overwrite the canonical unlinked state.
    expect(block).toMatch(/elizacloud\s*:\s*\{[^}]*status\s*:\s*"unlinked"/);
  });
});
