import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HOST_EXTERNAL_RUNTIME_PARAM,
  HOST_EXTERNAL_SPECIFIERS_PARAM,
} from "./host-external-contract.js";

/**
 * Guards that the dependency-free runtime transform
 * (`packages/agent/src/api/dynamic-view-host-external.mjs`) reads the same URL
 * query-param names this shared contract declares. The `.mjs` can't import
 * `@elizaos/shared` (it is loaded by path with no build), so it mirrors the
 * names as literals; this test asserts the literals still match the contract.
 */
describe("host-external contract param names", () => {
  const mjs = readFileSync(
    fileURLToPath(
      new URL(
        "../../../agent/src/api/dynamic-view-host-external.mjs",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it("the runtime transform reads the contract's runtime param", () => {
    expect(HOST_EXTERNAL_RUNTIME_PARAM).toBe("hostExternalRuntime");
    expect(mjs).toContain(`get("${HOST_EXTERNAL_RUNTIME_PARAM}")`);
  });

  it("the runtime transform reads the contract's specifiers param", () => {
    expect(HOST_EXTERNAL_SPECIFIERS_PARAM).toBe("hostExternalSpecifiers");
    expect(mjs).toContain(`get("${HOST_EXTERNAL_SPECIFIERS_PARAM}")`);
  });
});
