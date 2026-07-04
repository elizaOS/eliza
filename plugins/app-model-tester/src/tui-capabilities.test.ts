/**
 * Contract tests for Model Tester TUI capability wiring.
 * They keep the exported capability list, plugin view declaration, and bundle `interact` handler aligned so terminal dispatch cannot drift silently.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  interact,
  MODEL_TESTER_TUI_CAPABILITIES,
} from "./ModelTesterAppView.interact";

const HERE = import.meta.dirname;

function okFetch(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("Model Tester TUI capability wiring", () => {
  it("exports the exact registered capability id set", () => {
    expect([...MODEL_TESTER_TUI_CAPABILITIES]).toEqual([
      "get-status",
      "run-text-small",
      "run-transcription",
      "run-vision",
      "run-vad",
    ]);
  });

  it("plugin.ts declares the same capabilities the view surfaces", () => {
    const pluginSrc = readFileSync(resolve(HERE, "plugin.ts"), "utf8");
    for (const id of MODEL_TESTER_TUI_CAPABILITIES) {
      expect(pluginSrc).toContain(`id: "${id}"`);
    }
  });

  it("interact() handles every surfaced capability (none are 'unsupported')", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = okFetch({
      ok: true,
      probes: [],
      result: "ok",
      segments: [],
    });
    try {
      for (const id of MODEL_TESTER_TUI_CAPABILITIES) {
        // A handled capability resolves (or fails on data shape); only an
        // unregistered one throws the "does not support" error.
        await expect(
          (async () => {
            try {
              await interact(id, {});
            } catch (err) {
              if (
                err instanceof Error &&
                err.message.includes("does not support")
              ) {
                throw err;
              }
            }
          })(),
        ).resolves.toBeUndefined();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
