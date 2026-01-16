import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadWasmPlugin } from "../wasm-loader";

describe("WASM Loader - limits", () => {
  test("should reject WASM binaries exceeding maxWasmBytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eliza-wasm-"));
    const wasmPath = join(dir, "too-big.wasm");
    writeFileSync(wasmPath, Buffer.from("not a wasm"));

    await expect(
      loadWasmPlugin({
        wasmPath,
        maxWasmBytes: 0,
      }),
    ).rejects.toThrow(/WASM binary too large/);
  });
});
