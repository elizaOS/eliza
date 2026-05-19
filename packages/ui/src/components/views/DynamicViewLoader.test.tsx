// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DynamicViewLoader } from "./DynamicViewLoader";

const { sendWsMessage } = vi.hoisted(() => ({
  sendWsMessage: vi.fn(),
}));

vi.mock("../../api", () => ({
  client: { sendWsMessage },
}));

describe("DynamicViewLoader", () => {
  afterEach(() => {
    delete window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__;
    sendWsMessage.mockClear();
    cleanup();
    vi.restoreAllMocks();
  });

  it("imports absolute remote bundleUrl directly", async () => {
    const bundleUrl = "https://capability.example.test/assets/remote-panel.js";
    const importBundle = vi.fn(async () => ({
      default: function RemotePanel() {
        return <div>Remote capability panel loaded</div>;
      },
    }));
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = importBundle;

    render(<DynamicViewLoader bundleUrl={bundleUrl} viewId="remote.panel" />);

    await screen.findByText("Remote capability panel loaded");
    expect(importBundle).toHaveBeenCalledWith(bundleUrl);
    expect(importBundle).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/views/remote.panel/bundle.js"),
    );
  });

  it("registers remote view interact handlers after the bundle loads", async () => {
    const bundleUrl = "https://capability.example.test/assets/interactive.js";
    const interact = vi.fn(async (capability: string) => ({ capability }));
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function InteractivePanel() {
        return <div>Interactive remote panel</div>;
      },
      interact,
    }));

    render(
      <DynamicViewLoader
        bundleUrl={bundleUrl}
        viewId="remote.interactive"
        viewType="gui"
      />,
    );

    await screen.findByText("Interactive remote panel");

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await dispatchViewInteract(
      "remote.interactive",
      "gui",
      "custom-capability",
      undefined,
      "req-remote",
    );

    await waitFor(() => {
      expect(interact).toHaveBeenCalledWith("custom-capability", undefined);
    });
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-remote",
      success: true,
      result: { capability: "custom-capability" },
    });
  });
});
