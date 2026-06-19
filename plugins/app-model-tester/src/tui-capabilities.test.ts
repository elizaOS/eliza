// Contract test: the Model Tester TUI surfaces its registered capabilities.
//
// Bug this locks: ModelTesterTuiView passed `commands={[]}` to the shared
// TerminalPluginView, so the 5 registered capabilities (get-status,
// run-text-small, run-transcription, run-vision, run-vad) never rendered as
// terminal commands — the terminal showed only TerminalPluginView's fallback.
// The fix wires `commands={MODEL_TESTER_TUI_CAPABILITIES}`. This test asserts the
// three sources agree (the exported list, plugin.ts `capabilities`, and the
// interact() handler) and that the view no longer ships an empty command list.

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

  it("the TUI view no longer ships an empty command list (regression guard)", () => {
    const viewSrc = readFileSync(
      resolve(HERE, "ModelTesterAppView.tsx"),
      "utf8",
    );
    // The fix wires the real capabilities; re-introducing commands={[]} fails.
    expect(viewSrc).toContain("commands={[...MODEL_TESTER_TUI_CAPABILITIES]}");
    expect(viewSrc).not.toContain("commands={[]}");
  });
});
