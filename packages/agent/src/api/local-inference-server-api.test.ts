import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as loader from "./local-inference-server-api.ts";

/**
 * `local-inference-server-api.ts` is the ONE file in packages/agent that knows
 * the plugin's stub/subpath layout: the mobile agent bundle null-stubs the bare
 * `@elizaos/plugin-local-inference` entry but leaves the deep `./local-inference-routes`
 * and `./routes` subpaths real on every platform. server.ts, health-routes.ts
 * and chat-routes.ts must therefore consume THIS loader and never hand-pick a
 * subpath themselves — otherwise the stub knowledge is duplicated and drifts.
 */
function readSibling(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

const SUBPATH_IMPORT =
  /@elizaos\/plugin-local-inference\/(local-inference-routes|routes)\b/;

describe("local-inference-server-api loader (single subpath owner)", () => {
  it("exposes the two memoized subpath loaders", () => {
    expect(typeof loader.loadLocalInferenceRouteApi).toBe("function");
    expect(typeof loader.loadLocalInferenceVoiceRouteApi).toBe("function");
    // Same call → same in-flight promise (memoized), so a warm route dispatch
    // never re-imports the plugin subpath.
    const a = loader.loadLocalInferenceRouteApi();
    const b = loader.loadLocalInferenceRouteApi();
    expect(a).toBe(b);
    // Swallow the (possibly rejecting) import — resolvability is environmental;
    // this test asserts identity + ownership, not the plugin body.
    void a.catch(() => {});
  });

  it("is the only api-route file that names the plugin subpaths", () => {
    expect(
      SUBPATH_IMPORT.test(readSibling("./local-inference-server-api.ts")),
    ).toBe(true);
    for (const consumer of [
      "./server.ts",
      "./health-routes.ts",
      "./chat-routes.ts",
    ]) {
      expect(SUBPATH_IMPORT.test(readSibling(consumer))).toBe(false);
    }
  });

  it("keeps consumers off the null-stubbed bare entry", () => {
    // health + server resolve everything through the loader; chat-routes loads
    // the loader too (its real chat-status fns live on the same subpath).
    for (const consumer of ["./server.ts", "./health-routes.ts"]) {
      expect(readSibling(consumer)).not.toMatch(
        /import\([^)]*"@elizaos\/plugin-local-inference"/,
      );
    }
  });
});
