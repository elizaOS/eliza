// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the @elizaos/ui surfaces ModelTesterAppView imports. Lightweight
// passthroughs keep the test self-contained (no full UI bundle) while preserving
// the real semantics we assert: Button forwards click/disabled/aria/ref + agent
// data-* props, and useAgentElement replicates the real data-attribute mapping
// (including data-state from `status`) so the "loaded" asset-control state is
// observable.
// ---------------------------------------------------------------------------
vi.mock("@elizaos/ui", () => ({
  TerminalPluginView: (props: { id: string; commands?: string[] }) =>
    React.createElement("div", {
      "data-testid": "terminal-plugin-view",
      "data-id": props.id,
      "data-commands": JSON.stringify(props.commands ?? null),
    }),
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: <T extends HTMLElement>(descriptor: {
    id: string;
    role?: string;
    label: string;
    status?: string;
  }) => ({
    ref: React.createRef<T>(),
    agentProps: {
      "data-agent-id": descriptor.id,
      "data-agent-role": descriptor.role ?? "region",
      "data-agent-label": descriptor.label,
      ...(descriptor.status ? { "data-state": descriptor.status } : {}),
    },
  }),
}));

vi.mock("@elizaos/ui/components/ui/button", () => ({
  Button: React.forwardRef<HTMLButtonElement, Record<string, unknown>>(
    function MockButton({ children, ...props }, ref) {
      return React.createElement(
        "button",
        { type: "button", ref, ...props },
        children as React.ReactNode,
      );
    },
  ),
}));

vi.mock("@elizaos/ui/components/ui/spinner", () => ({
  Spinner: (props: Record<string, unknown>) =>
    React.createElement("span", { "data-testid": "spinner", ...props }),
}));

import { ModelTesterAppView } from "./ModelTesterAppView.js";

const VISION_PROMPT = "Describe the attached image in one compact sentence.";

const t = (_key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? _key;

function overlayContext(exitToApps = vi.fn()) {
  return { exitToApps, uiTheme: "dark" as const, t };
}

const TEST_ORDER = [
  "text-small",
  "text-large",
  "embedding",
  "text-to-speech",
  "transcription",
  "vad",
  "image-description",
  "image",
];

/** Realistic 8-probe status payload mirroring the real route handler, where
 *  VAD is always `available:true` (pure-JS probe). */
function statusPayload(overrides: Partial<Record<string, boolean>> = {}) {
  const availability: Record<string, boolean> = {
    "text-small": true,
    "text-large": true,
    embedding: true,
    "text-to-speech": false,
    transcription: false,
    vad: true,
    "image-description": true,
    image: false,
    ...overrides,
  };
  const labels: Record<string, string> = {
    "text-small": "TEXT_SMALL",
    "text-large": "TEXT_LARGE",
    embedding: "TEXT_EMBEDDING",
    "text-to-speech": "TEXT_TO_SPEECH",
    transcription: "TRANSCRIPTION",
    vad: "VAD",
    "image-description": "IMAGE_DESCRIPTION",
    image: "IMAGE",
  };
  return {
    tests: TEST_ORDER.map((id) => ({
      id,
      label: id,
      modelType: labels[id],
      available: availability[id],
      providers: availability[id] ? ["test-provider"] : [],
    })),
  };
}

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** Installs a fetch stub. `runResponder` returns the /run output per test id. */
function installFetch(
  runResponder: (test: string, body: Record<string, unknown>) => unknown,
  statusOverrides: Partial<Record<string, boolean>> = {},
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const bodyText = typeof init?.body === "string" ? init.body : undefined;
      const body = bodyText
        ? (JSON.parse(bodyText) as Record<string, unknown>)
        : null;
      calls.push({ url, method: init?.method ?? "GET", body });

      if (url === "/api/model-tester/status") {
        return {
          ok: true,
          json: async () => statusPayload(statusOverrides),
        } as unknown as Response;
      }
      // /run
      const test = String(body?.test);
      const output = runResponder(test, body ?? {});
      return {
        ok: true,
        json: async () => ({ ok: true, test, durationMs: 42, output }),
      } as unknown as Response;
    }),
  );
  return { calls };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function cardFor(id: string): HTMLElement {
  // Cards have no test id; locate via the per-card Run button's agent id.
  const button = document.querySelector(`[data-agent-id="action-run-${id}"]`);
  const section = button?.closest("section");
  if (!section) throw new Error(`card not found for ${id}`);
  return section as HTMLElement;
}

function runCall(calls: FetchCall[]): FetchCall {
  const call = calls.find((c) => c.url === "/api/model-tester/run");
  if (!call) throw new Error("no /run call recorded");
  return call;
}

describe("ModelTesterAppView populated render", () => {
  it("renders the shell, heading, ready count, presets, and per-card modelType", async () => {
    installFetch(() => ({ text: "ok" }));
    render(<ModelTesterAppView {...overlayContext()} />);

    // Wait for the on-mount status fetch to populate.
    await waitFor(() => expect(screen.getByText("TEXT_SMALL")).toBeTruthy());

    expect(screen.getByTestId("model-tester-shell")).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 1, name: "Model Tester" }),
    ).toBeTruthy();

    // readyCount: text-small, text-large, embedding, image-description = 4
    // available, PLUS vad always counts ready = 5/8.
    expect(screen.getByText("5/8")).toBeTruthy();

    // Each card surfaces its status.modelType text (not the static subtitle).
    for (const modelType of [
      "TEXT_SMALL",
      "TEXT_LARGE",
      "TEXT_EMBEDDING",
      "TEXT_TO_SPEECH",
      "TRANSCRIPTION",
      "VAD",
      "IMAGE_DESCRIPTION",
      "IMAGE",
    ]) {
      expect(screen.getByText(modelType)).toBeTruthy();
    }

    // Smoke preset is selected initially.
    const smoke = screen.getByRole("button", { name: "Smoke" });
    expect(smoke.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Vision" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("counts VAD ready via the `?? id === 'vad'` default when it is absent from status", async () => {
    // Status omits the vad entry entirely; only text-small is available.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (String(input) === "/api/model-tester/status") {
          return {
            ok: true,
            json: async () => ({
              tests: [
                {
                  id: "text-small",
                  label: "text-small",
                  modelType: "TEXT_SMALL",
                  available: true,
                  providers: ["p"],
                },
              ],
            }),
          } as unknown as Response;
        }
        return {
          ok: true,
          json: async () => ({ ok: true }),
        } as unknown as Response;
      }),
    );
    render(<ModelTesterAppView {...overlayContext()} />);
    await waitFor(() => expect(screen.getByText("TEXT_SMALL")).toBeTruthy());

    // text-small available (1) + vad default-ready (1) = 2/8.
    expect(screen.getByText("2/8")).toBeTruthy();
  });
});

describe("ModelTesterAppView interactions", () => {
  it("Refresh fires a second status GET", async () => {
    const { calls } = installFetch(() => ({}));
    render(<ModelTesterAppView {...overlayContext()} />);
    await waitFor(() => expect(screen.getByText("TEXT_SMALL")).toBeTruthy());

    const statusCalls = () =>
      calls.filter((c) => c.url === "/api/model-tester/status").length;
    expect(statusCalls()).toBe(1);

    fireEvent.click(screen.getByLabelText("Refresh model status"));
    await waitFor(() => expect(statusCalls()).toBe(2));
  });

  it("Back button invokes exitToApps", async () => {
    installFetch(() => ({}));
    const exitToApps = vi.fn();
    render(<ModelTesterAppView {...overlayContext(exitToApps)} />);
    await waitFor(() => expect(screen.getByText("TEXT_SMALL")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Back"));
    expect(exitToApps).toHaveBeenCalledTimes(1);
  });

  it("selecting the Vision preset flips aria-pressed and sends that prompt in /run", async () => {
    const { calls } = installFetch((test) => ({ test }));
    render(<ModelTesterAppView {...overlayContext()} />);
    await waitFor(() => expect(screen.getByText("TEXT_SMALL")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Vision" }));
    expect(
      screen
        .getByRole("button", { name: "Vision" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Smoke" })
        .getAttribute("aria-pressed"),
    ).toBe("false");

    // Run a probe; the body must carry the Vision prompt.
    const runButton = within(cardFor("text-small")).getByLabelText("Run Text");
    fireEvent.click(runButton);
    await waitFor(() =>
      expect(calls.find((c) => c.url === "/api/model-tester/run")).toBeTruthy(),
    );
    const call = runCall(calls);
    expect(call.body?.prompt).toBe(VISION_PROMPT);
    expect(call.body?.test).toBe("text-small");
  });

  it("embedding Run posts {test:'embedding'} and renders dimensions + preview", async () => {
    const preview = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const { calls } = installFetch((test) =>
      test === "embedding" ? { dimensions: 768, preview } : { text: "x" },
    );
    render(<ModelTesterAppView {...overlayContext()} />);
    await waitFor(() =>
      expect(screen.getByText("TEXT_EMBEDDING")).toBeTruthy(),
    );

    const card = cardFor("embedding");
    fireEvent.click(within(card).getByLabelText("Run Embedding"));

    await waitFor(() =>
      expect(within(card).getByText(/"dimensions": 768/)).toBeTruthy(),
    );
    // The 8-element preview is serialized into the <pre>.
    expect(within(card).getByText(/0\.8/)).toBeTruthy();
    // Success badge shows the duration in ms.
    expect(within(card).getByText("42ms")).toBeTruthy();

    expect(runCall(calls).body?.test).toBe("embedding");
  });

  it("TTS Run renders an <audio> element with a base64 data-url source", async () => {
    installFetch((test) =>
      test === "text-to-speech"
        ? { contentType: "audio/wav", base64: "UklGRgAAAAA=" }
        : {},
    );
    render(<ModelTesterAppView {...overlayContext()} />);
    await waitFor(() =>
      expect(screen.getByText("TEXT_TO_SPEECH")).toBeTruthy(),
    );

    const card = cardFor("text-to-speech");
    fireEvent.click(within(card).getByLabelText("Run Voice"));

    await waitFor(() => {
      const audio = card.querySelector("audio");
      expect(audio).toBeTruthy();
      expect(audio?.getAttribute("src")).toBe(
        "data:audio/wav;base64,UklGRgAAAAA=",
      );
    });
  });

  it("image Run renders one <img> per generated url", async () => {
    const url = "data:image/png;base64,iVBORw0KGgoAAAd=";
    installFetch((test) => (test === "image" ? { images: [{ url }] } : {}));
    render(<ModelTesterAppView {...overlayContext()} />);
    await waitFor(() => expect(screen.getByText("IMAGE")).toBeTruthy());

    const card = cardFor("image");
    fireEvent.click(within(card).getByLabelText("Run Image"));

    await waitFor(() => {
      const generated = Array.from(card.querySelectorAll("img")).find(
        (img) => img.getAttribute("src") === url,
      );
      expect(generated).toBeTruthy();
    });
  });

  it("Run all sequentially posts every probe in TEST_ORDER", async () => {
    const { calls } = installFetch((test) => ({ test }));
    render(<ModelTesterAppView {...overlayContext()} />);
    await waitFor(() => expect(screen.getByText("TEXT_SMALL")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Run all/ }));

    await waitFor(() => {
      const runTests = calls
        .filter((c) => c.url === "/api/model-tester/run")
        .map((c) => c.body?.test);
      expect(runTests).toEqual(TEST_ORDER);
    });
  });

  it("a failing /run renders the Failed badge + the error text", async () => {
    // Override fetch entirely so /run returns ok:false for one probe.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url === "/api/model-tester/status") {
          return {
            ok: true,
            json: async () => statusPayload(),
          } as unknown as Response;
        }
        return {
          ok: true,
          json: async () => ({
            ok: false,
            test: "embedding",
            error: "boom: embedding provider down",
          }),
        } as unknown as Response;
      }),
    );
    render(<ModelTesterAppView {...overlayContext()} />);
    await waitFor(() =>
      expect(screen.getByText("TEXT_EMBEDDING")).toBeTruthy(),
    );

    const card = cardFor("embedding");
    fireEvent.click(within(card).getByLabelText("Run Embedding"));

    await waitFor(() => expect(within(card).getByText("Failed")).toBeTruthy());
    expect(
      within(card).getByText(/boom: embedding provider down/),
    ).toBeTruthy();
  });
});

describe("ModelTesterAppView asset pickers", () => {
  it("choosing an image shows the preview <img> and marks the control loaded", async () => {
    installFetch(() => ({}));
    render(<ModelTesterAppView {...overlayContext()} />);
    await waitFor(() => expect(screen.getByText("TEXT_SMALL")).toBeTruthy());

    const imageInput = document.querySelector(
      '[data-agent-id="input-image-asset"]',
    ) as HTMLInputElement;
    expect(imageInput).toBeTruthy();
    // Initially not loaded.
    expect(imageInput.getAttribute("data-state")).toBeNull();

    const file = new File(["fake-bytes"], "pic.png", { type: "image/png" });
    fireEvent.change(imageInput, { target: { files: [file] } });

    // Preview image appears in the asset section once fileToDataUrl resolves.
    await waitFor(() => {
      const preview = document
        .querySelector("section")
        ?.querySelector('img[alt=""]');
      expect(preview).toBeTruthy();
      expect(preview?.getAttribute("src")).toMatch(/^data:image\/png/);
    });

    // The agent control re-renders with status "loaded".
    const reloaded = document.querySelector(
      '[data-agent-id="input-image-asset"]',
    );
    expect(reloaded?.getAttribute("data-state")).toBe("loaded");
  });

  it("an audio decode failure surfaces the error in the danger div", async () => {
    installFetch(() => ({}));
    // No AudioContext in jsdom -> audioFileToPayload throws -> assetError shown.
    render(<ModelTesterAppView {...overlayContext()} />);
    await waitFor(() => expect(screen.getByText("TEXT_SMALL")).toBeTruthy());

    const audioInput = document.querySelector(
      '[data-agent-id="input-audio-asset"]',
    ) as HTMLInputElement;
    const file = new File(["bytes"], "clip.wav", { type: "audio/wav" });
    fireEvent.change(audioInput, { target: { files: [file] } });

    await waitFor(() =>
      expect(
        screen.getByText("This browser cannot decode audio files."),
      ).toBeTruthy(),
    );
  });
});
