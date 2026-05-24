// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DynamicViewLoader } from "./DynamicViewLoader";

const { sendWsMessage } = vi.hoisted(() => ({
  sendWsMessage: vi.fn(),
}));

vi.mock("../../api", () => ({
  client: { sendWsMessage },
}));

describe("DynamicViewLoader", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "innerText", {
      configurable: true,
      get() {
        return this.textContent ?? "";
      },
    });
    Object.defineProperty(window, "CSS", {
      configurable: true,
      value: {
        escape: (value: string) => value.replaceAll('"', '\\"'),
      },
    });
  });

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

  it("handles standard get-text and get-state capabilities from the mounted DOM", async () => {
    const bundleUrl = "https://capability.example.test/assets/stateful.js";
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function StatefulPanel() {
        return (
          <section>
            <h1>Window manager state</h1>
            <div data-view-state='{"viewId":"window.manager","open":true}' />
          </section>
        );
      },
    }));

    render(<DynamicViewLoader bundleUrl={bundleUrl} viewId="window.manager" />);
    await screen.findByText("Window manager state");

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await dispatchViewInteract(
      "window.manager",
      "gui",
      "get-text",
      undefined,
      "req-text",
    );
    await dispatchViewInteract(
      "window.manager",
      "gui",
      "get-state",
      undefined,
      "req-state",
    );

    expect(sendWsMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-text",
        success: true,
        result: expect.stringContaining("Window manager state"),
      }),
    );
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-state",
      success: true,
      result: { viewId: "window.manager", open: true },
    });
  });

  it("falls back to empty state for invalid data-view-state JSON", async () => {
    const bundleUrl = "https://capability.example.test/assets/bad-state.js";
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function BadStatePanel() {
        return <div data-view-state="{not-json">Bad state panel</div>;
      },
    }));

    render(<DynamicViewLoader bundleUrl={bundleUrl} viewId="bad.state" />);
    await screen.findByText("Bad state panel");

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await dispatchViewInteract(
      "bad.state",
      "gui",
      "get-state",
      undefined,
      "req-bad-state",
    );

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-bad-state",
      success: true,
      result: {},
    });
  });

  it("focuses elements by selector and by name through standard interact", async () => {
    const bundleUrl = "https://capability.example.test/assets/focus.js";
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function FocusPanel() {
        return (
          <form>
            <button type="button" className="primary-action">
              Create view
            </button>
            <input name="view-title" aria-label="View title" />
          </form>
        );
      },
    }));

    render(<DynamicViewLoader bundleUrl={bundleUrl} viewId="focus.view" />);
    await screen.findByRole("button", { name: "Create view" });

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await dispatchViewInteract(
      "focus.view",
      "gui",
      "focus-element",
      { selector: ".primary-action" },
      "req-focus-selector",
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Create view" }),
    );

    await dispatchViewInteract(
      "focus.view",
      "gui",
      "focus-element",
      { name: "view-title" },
      "req-focus-name",
    );
    expect(document.activeElement).toBe(screen.getByLabelText("View title"));
    expect(sendWsMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-focus-selector",
        success: true,
        result: { focused: true, selector: ".primary-action" },
      }),
    );
    expect(sendWsMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-focus-name",
        success: true,
        result: { focused: true, selector: "view-title" },
      }),
    );
  });

  it("fills inputs and clicks buttons through standard interact against the mounted DOM", async () => {
    const bundleUrl = "https://capability.example.test/assets/form.js";
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function FormPanel() {
        const [draft, setDraft] = useState("");
        const [submitted, setSubmitted] = useState("none");
        return (
          <form>
            <label>
              View title
              <input
                name="view-title"
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
              />
            </label>
            <button
              type="button"
              className="submit-view"
              onClick={() => setSubmitted(draft)}
            >
              Save view
            </button>
            <output data-testid="view-output">{submitted}</output>
            <div
              data-view-state={JSON.stringify({
                draft,
                submitted,
              })}
            />
          </form>
        );
      },
    }));

    render(<DynamicViewLoader bundleUrl={bundleUrl} viewId="form.view" />);
    await screen.findByRole("button", { name: "Save view" });

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await dispatchViewInteract(
      "form.view",
      "gui",
      "fill-input",
      { name: "view-title", value: "Remote Ledger Updated" },
      "req-fill",
    );
    expect(screen.getByDisplayValue("Remote Ledger Updated")).toBeTruthy();

    await dispatchViewInteract(
      "form.view",
      "gui",
      "click-element",
      { selector: ".submit-view" },
      "req-click",
    );
    await waitFor(() =>
      expect(screen.getByTestId("view-output").textContent).toBe(
        "Remote Ledger Updated",
      ),
    );

    await dispatchViewInteract(
      "form.view",
      "gui",
      "get-state",
      undefined,
      "req-form-state",
    );

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-fill",
      success: true,
      result: {
        filled: true,
        selector: "view-title",
        value: "Remote Ledger Updated",
      },
    });
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-click",
      success: true,
      result: { clicked: true, selector: ".submit-view" },
    });
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-form-state",
      success: true,
      result: {
        draft: "Remote Ledger Updated",
        submitted: "Remote Ledger Updated",
      },
    });
  });

  it("reports invalid click and fill requests without mutating the view", async () => {
    const bundleUrl = "https://capability.example.test/assets/form-errors.js";
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function FormErrorsPanel() {
        return (
          <section>
            <div className="not-fillable">Not fillable</div>
            <input name="view-title" defaultValue="Original" />
          </section>
        );
      },
    }));

    render(
      <DynamicViewLoader bundleUrl={bundleUrl} viewId="form.errors.view" />,
    );
    await screen.findByDisplayValue("Original");

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await dispatchViewInteract(
      "form.errors.view",
      "gui",
      "click-element",
      { selector: ".missing" },
      "req-click-missing",
    );
    await dispatchViewInteract(
      "form.errors.view",
      "gui",
      "fill-input",
      { selector: ".not-fillable", value: "Changed" },
      "req-fill-not-fillable",
    );
    await dispatchViewInteract(
      "form.errors.view",
      "gui",
      "fill-input",
      { name: "view-title", value: 12 },
      "req-fill-bad-value",
    );

    expect(screen.getByDisplayValue("Original")).toBeTruthy();
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-click-missing",
      success: true,
      result: { clicked: false, reason: "element not found" },
    });
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-fill-not-fillable",
      success: true,
      result: { filled: false, reason: "element is not fillable" },
    });
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-fill-bad-value",
      success: true,
      result: { filled: false, reason: "value must be a string" },
    });
  });

  it("reports missing focus targets without throwing", async () => {
    const bundleUrl = "https://capability.example.test/assets/missing-focus.js";
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function MissingFocusPanel() {
        return <div>No inputs here</div>;
      },
    }));

    render(<DynamicViewLoader bundleUrl={bundleUrl} viewId="missing.focus" />);
    await screen.findByText("No inputs here");

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await dispatchViewInteract(
      "missing.focus",
      "gui",
      "focus-element",
      { selector: ".does-not-exist" },
      "req-missing-focus",
    );

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-missing-focus",
      success: true,
      result: { focused: false, reason: "element not found" },
    });
  });

  it("standard capabilities take precedence over module interact and refresh re-imports", async () => {
    const bundleUrl = "https://capability.example.test/assets/refresh.js";
    let importCount = 0;
    const interact = vi.fn(async () => ({ delegated: true }));
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => {
      importCount += 1;
      return {
        default: function RefreshPanel() {
          return <div>Refresh version {importCount}</div>;
        },
        interact,
      };
    });

    render(<DynamicViewLoader bundleUrl={bundleUrl} viewId="refresh.view" />);
    await screen.findByText("Refresh version 1");

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await dispatchViewInteract(
      "refresh.view",
      "gui",
      "refresh",
      undefined,
      "req-refresh",
    );

    await screen.findByText("Refresh version 2");
    expect(interact).not.toHaveBeenCalled();
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-refresh",
      success: true,
      result: { refreshed: true },
    });
  });

  it("renders the error state when a bundle does not export a component", async () => {
    const bundleUrl = "https://capability.example.test/assets/no-component.js";
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: "not a component",
    }));

    render(<DynamicViewLoader bundleUrl={bundleUrl} viewId="broken.view" />);

    await screen.findByText("Failed to load view");
    expect(screen.getByText("View ID: broken.view")).toBeTruthy();
  });

  it("runs cleanup on unmount and ignores cleanup failures", async () => {
    const bundleUrl = "https://capability.example.test/assets/cleanup.js";
    const cleanupBundle = vi.fn(() => {
      throw new Error("cleanup failed");
    });
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function CleanupPanel() {
        return <div>Cleanup panel</div>;
      },
      cleanup: cleanupBundle,
    }));

    const rendered = render(
      <DynamicViewLoader bundleUrl={bundleUrl} viewId="cleanup.view" />,
    );
    await screen.findByText("Cleanup panel");

    expect(() => rendered.unmount()).not.toThrow();
    await waitFor(() => expect(cleanupBundle).toHaveBeenCalledTimes(1));
  });
});
