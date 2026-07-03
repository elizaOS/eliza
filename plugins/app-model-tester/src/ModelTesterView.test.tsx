// @vitest-environment jsdom

// Drives the unified ModelTesterView (the single GUI/XR/TUI data wrapper) through
// the rendered DOM: the same component the bundle exports for the "gui", "xr",
// and "tui" modalities. Asserts the on-mount status fetch, the prompt-preset
// switch, run-all sequencing, refresh, per-probe run dispatch, and the Back
// navigation — functional parity with the legacy ModelTesterAppView surface,
// expressed through the spatial action contract.

import { NAVIGATE_VIEW_EVENT } from "@elizaos/shared/events";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelTesterView } from "./ModelTesterView";

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

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

function statusPayload() {
  return {
    tests: TEST_ORDER.map((id) => ({
      id,
      modelType: id.toUpperCase(),
      available: id !== "image" && id !== "text-to-speech",
    })),
  };
}

function installFetch(): { calls: FetchCall[] } {
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
        return { json: async () => statusPayload() } as unknown as Response;
      }
      return {
        json: async () => ({
          ok: true,
          test: body?.test,
          durationMs: 7,
          output: "ok",
        }),
      } as unknown as Response;
    }),
  );
  return { calls };
}

function button(agentId: string): HTMLButtonElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ModelTesterView — unified GUI/XR/TUI wrapper", () => {
  beforeEach(() => {
    installFetch();
  });

  it("renders inside a spatial surface and shows the probe rows after the status fetch", async () => {
    render(React.createElement(ModelTesterView));
    await screen.findByText("6 ready");
    // Each probe row renders its label.
    expect(screen.getByText("Text")).toBeTruthy();
    expect(screen.getByText("Activity")).toBeTruthy();
    expect(screen.getByText("Run all")).toBeTruthy();
  });

  it("fetches status once on mount and again on refresh-status", async () => {
    const { calls } = installFetch();
    render(React.createElement(ModelTesterView));
    await screen.findByText("6 ready");

    const statusCalls = () =>
      calls.filter((c) => c.url === "/api/model-tester/status").length;
    await waitFor(() => expect(statusCalls()).toBe(1));

    fireEvent.click(button("refresh-status"));
    await waitFor(() => expect(statusCalls()).toBe(2));
  });

  it("run-all posts every probe in order with the active prompt", async () => {
    const { calls } = installFetch();
    render(React.createElement(ModelTesterView));
    await screen.findByText("6 ready");

    fireEvent.click(button("run-all"));
    await waitFor(() => {
      const runTests = calls
        .filter((c) => c.url === "/api/model-tester/run")
        .map((c) => c.body?.test);
      expect(runTests).toEqual(TEST_ORDER);
    });
  });

  it("selecting the Vision preset sends that prompt on the next run", async () => {
    const { calls } = installFetch();
    render(React.createElement(ModelTesterView));
    await screen.findByText("6 ready");

    fireEvent.click(button("preset-vision"));
    fireEvent.click(button("run-text-small"));
    await waitFor(() =>
      expect(calls.find((c) => c.url === "/api/model-tester/run")).toBeTruthy(),
    );
    const run = calls.find((c) => c.url === "/api/model-tester/run");
    expect(run?.body?.prompt).toBe(
      "Describe the attached image in one compact sentence.",
    );
  });

  it("Back invokes the provided exitToApps callback", async () => {
    installFetch();
    const exitToApps = vi.fn();
    render(<ModelTesterView exitToApps={exitToApps} />);
    await screen.findByText("6 ready");

    fireEvent.click(button("back"));
    expect(exitToApps).toHaveBeenCalledTimes(1);
  });

  it("Back without exitToApps dispatches the eliza:navigate:view bus", async () => {
    installFetch();
    render(React.createElement(ModelTesterView));
    await screen.findByText("6 ready");

    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener(NAVIGATE_VIEW_EVENT, listener);
    try {
      fireEvent.click(button("back"));
    } finally {
      window.removeEventListener(NAVIGATE_VIEW_EVENT, listener);
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatchObject({ viewId: "apps" });
  });
});
