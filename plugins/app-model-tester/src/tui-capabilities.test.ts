import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ViewDeclaration } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { interact } from "./ModelTesterAppView.interact.js";
import { modelTesterPlugin } from "./plugin.js";

const here = dirname(fileURLToPath(import.meta.url));

const EXPECTED_CAPABILITY_IDS = [
  "get-status",
  "run-text-small",
  "run-transcription",
  "run-vision",
  "run-vad",
];

// MODEL_TESTER_COMMAND_TO_TEST is module-private in ModelTesterAppView.interact;
// the run-* test ids it must map are the source of truth the capabilities and
// interact() handler all have to agree on.
const RUN_CAPABILITY_TO_TEST: Record<string, string> = {
  "run-text-small": "text-small",
  "run-transcription": "transcription",
  "run-vision": "image-description",
  "run-vad": "vad",
};

function tuiView(): ViewDeclaration {
  const view = modelTesterPlugin.views?.find((v) => v.viewType === "tui");
  if (!view) throw new Error("tui view not registered");
  return view;
}

describe("model-tester TUI capability registration", () => {
  it("registers exactly the expected capability ids", () => {
    const view = tuiView();
    const ids = (view.capabilities ?? []).map((c) => c.id);
    expect(ids).toEqual(EXPECTED_CAPABILITY_IDS);
  });

  it("every registered run-* capability resolves to a real test in interact()", async () => {
    const view = tuiView();
    const runCapabilities = (view.capabilities ?? [])
      .map((c) => c.id)
      .filter((id) => id.startsWith("run-"));

    // Every registered run-* id must have a known test mapping.
    for (const id of runCapabilities) {
      expect(RUN_CAPABILITY_TO_TEST[id]).toBeDefined();
    }

    // And interact() must actually accept each registered id without throwing
    // the "does not support" guard. Stub fetch so the network call is inert.
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ ok: true }),
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    for (const id of view.capabilities ?? []) {
      await expect(interact(id.id)).resolves.toBeDefined();
    }

    // Each run-* call forwarded the mapped test id to the run endpoint.
    for (const id of runCapabilities) {
      const matchingCall = fetchMock.mock.calls.find(([, init]) => {
        const body = (init as RequestInit | undefined)?.body;
        return (
          typeof body === "string" &&
          (JSON.parse(body) as { test?: string }).test ===
            RUN_CAPABILITY_TO_TEST[id]
        );
      });
      expect(matchingCall, `missing run call for ${id}`).toBeDefined();
    }

    vi.unstubAllGlobals();
  });

  it("CAVEAT: ModelTesterTuiView passes commands={[]} so the rendered TUI does NOT surface the real capabilities (known divergence)", () => {
    // The plugin declares 5 capabilities, but ModelTesterTuiView renders
    // TerminalPluginView with `commands={[]}`. The shared TerminalPluginView
    // (out of plugin scope) then shows its built-in fallback buttons instead of
    // the registered capabilities. This tripwire locks the divergence so that
    // wiring the real commands through (or removing the capabilities) fails this
    // test loudly and forces an interaction-coverage update.
    const source = readFileSync(
      resolve(here, "ModelTesterAppView.tsx"),
      "utf8",
    );
    expect(source).toContain("commands={[]}");
  });
});
