// @vitest-environment jsdom
//
// DynamicViewLoader: the same-origin bundle-URL gate (the RCE guard), that the
// test-only import hook is stripped from minified production builds, and the
// runtime load/cache/error behavior. The origin gate and the production-strip
// check compile the REAL DynamicViewLoader.tsx source with esbuild rather than
// asserting against a mock.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { transform } from "esbuild";
import { type ReactElement, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MODULE_CACHE_TELEMETRY_EVENT,
  type ModuleCacheTelemetryEvent,
} from "../../cache-telemetry";
import { APP_PAUSE_EVENT } from "../../events";
import {
  __resetDynamicViewLoaderCacheForTests,
  DynamicViewLoader,
  hostImport,
  isSameOriginBundleUrl,
} from "./DynamicViewLoader";

describe("isSameOriginBundleUrl (view-bundle origin gate)", () => {
  it("accepts same-origin and root-relative /api/views bundle URLs", () => {
    expect(isSameOriginBundleUrl("/api/views/x/bundle.js")).toBe(true);
    expect(
      isSameOriginBundleUrl(`${window.location.origin}/api/views/x/bundle.js`),
    ).toBe(true);
  });

  it("rejects cross-origin bundle URLs (the RCE vector)", () => {
    expect(
      isSameOriginBundleUrl("https://capability.example.test/assets/x.js"),
    ).toBe(false);
    expect(isSameOriginBundleUrl("http://evil.example/x.js")).toBe(false);
    // A protocol-relative URL resolves to a different origin → rejected.
    expect(isSameOriginBundleUrl("//evil.example/x.js")).toBe(false);
  });

  it("erases the test import hook from production builds before the origin gate", async () => {
    const source = await readFile(
      resolve(process.cwd(), "src/components/views/DynamicViewLoader.tsx"),
      "utf8",
    );
    const output = await transform(source, {
      loader: "tsx",
      format: "esm",
      minify: true,
      treeShaking: true,
      define: {
        "import.meta.env.DEV": "false",
        "import.meta.env.MODE": '"production"',
        "process.env.NODE_ENV": '"production"',
      },
    });

    expect(output.code).not.toContain("__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__");
    expect(output.code).toContain("isSameOriginBundleUrl");
  });
});

describe("host-external importer resolution (factory hostImport)", () => {
  // The served view-bundle factory receives `hostImport` as its parameter; it
  // resolves a specifier to the host shell's live singleton with no globalThis
  // bridge. Exercise that resolver directly here.
  const resolveHostExternal = (
    specifier: string,
  ): Promise<Record<string, unknown>> => hostImport(specifier);

  it("consults an importer contributed through registerHostExternalImporter", async () => {
    const { registerHostExternalImporter } = await import(
      "../../app-shell-registry"
    );
    const marker = { __registered: true };
    registerHostExternalImporter(
      "@test/plugin-registered-external",
      async () => marker,
    );

    await expect(
      resolveHostExternal("@test/plugin-registered-external"),
    ).resolves.toBe(marker);
  });

  it("still resolves a framework module from the trunk map", async () => {
    const react = await resolveHostExternal("react");
    expect(typeof react.useState).toBe("function");
  });

  it("throws for an unknown specifier that is neither framework nor registered", async () => {
    await expect(
      resolveHostExternal("@test/never-registered-external"),
    ).rejects.toThrow(/unsupported host external/);
  });
});

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
    __resetDynamicViewLoaderCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
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

  it("renders sandboxed iframe views from frameUrl and does not import bundleUrl", () => {
    const importBundle = vi.fn(async () => ({
      default: function ShouldNotLoad() {
        return <div>Host realm bundle loaded</div>;
      },
    }));
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = importBundle;

    render(
      <DynamicViewLoader
        bundleUrl="/api/views/sandboxed.panel/bundle.js"
        frameUrl="/api/views/sandboxed.panel/frame.html"
        viewId="sandboxed.panel"
        surface={{ isolation: "sandboxed-iframe" }}
      />,
    );

    const frame = screen.getByTestId("sandboxed-view-frame-sandboxed.panel");
    expect(frame.getAttribute("src")).toBe(
      "/api/views/sandboxed.panel/frame.html",
    );
    expect(importBundle).not.toHaveBeenCalled();
    expect(screen.queryByText("Host realm bundle loaded")).toBeNull();
  });

  it("fails closed when sandboxed iframe views omit frameUrl", () => {
    const importBundle = vi.fn(async () => ({
      default: function ShouldNotLoad() {
        return <div>Host realm bundle loaded</div>;
      },
    }));
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = importBundle;

    render(
      <DynamicViewLoader
        bundleUrl="/api/views/sandboxed.panel/bundle.js"
        viewId="sandboxed.panel"
        surface={{ isolation: "sandboxed-iframe" }}
      />,
    );

    expect(
      screen.getByText(
        /require a frameUrl HTML document; bundleUrl is a JavaScript module/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("sandboxed-view-frame-sandboxed.panel"),
    ).toBeNull();
    expect(importBundle).not.toHaveBeenCalled();
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

  it("redacts and refuses raw DOM sensitive fields", async () => {
    const bundleUrl = "https://capability.example.test/assets/sensitive.js";
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function SensitivePanel() {
        return (
          <section>
            <input
              data-agent-id="owner-password"
              data-agent-role="text-input"
              data-agent-label="Owner password"
              type="password"
              defaultValue="existing-secret"
            />
          </section>
        );
      },
    }));

    render(<DynamicViewLoader bundleUrl={bundleUrl} viewId="sensitive.view" />);
    await screen.findByDisplayValue("existing-secret");

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await dispatchViewInteract(
      "sensitive.view",
      "gui",
      "list-elements",
      undefined,
      "req-list-sensitive",
    );
    await dispatchViewInteract(
      "sensitive.view",
      "gui",
      "agent-fill",
      { id: "owner-password", value: "changed-secret" },
      "req-fill-sensitive-agent",
    );
    await dispatchViewInteract(
      "sensitive.view",
      "gui",
      "fill-input",
      { selector: "[data-agent-id='owner-password']", value: "changed-secret" },
      "req-fill-sensitive-selector",
    );

    expect(screen.getByDisplayValue("existing-secret")).toBeTruthy();
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-list-sensitive",
      success: true,
      result: [
        expect.objectContaining({
          id: "owner-password",
          sensitive: true,
          valueRedacted: true,
        }),
      ],
    });
    const listCall = vi
      .mocked(sendWsMessage)
      .mock.calls.find(
        ([message]) =>
          message.type === "view:interact:result" &&
          message.requestId === "req-list-sensitive",
      );
    expect(JSON.stringify(listCall?.[0])).not.toContain("existing-secret");
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-fill-sensitive-agent",
      success: true,
      result: expect.objectContaining({
        ok: false,
        id: "owner-password",
      }),
    });
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-fill-sensitive-selector",
      success: true,
      result: expect.objectContaining({
        filled: false,
        selector: "[data-agent-id='owner-password']",
      }),
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

  it("polls bundle HEAD in dev mode and reloads when the ETag changes", async () => {
    vi.useFakeTimers();
    async function flushViewLoader() {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    const bundleUrl = "https://capability.example.test/assets/hmr.js";
    const cleanupVersion1 = vi.fn();
    const interactVersion1 = vi.fn(async () => ({ version: 1 }));
    const interactVersion2 = vi.fn(async () => ({ version: 2 }));
    let importCount = 0;
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => {
      importCount += 1;
      const version = importCount;
      return {
        default: function HmrPanel() {
          return <div>HMR version {version}</div>;
        },
        interact: version === 1 ? interactVersion1 : interactVersion2,
        cleanup: version === 1 ? cleanupVersion1 : undefined,
      };
    });
    const fetchHead = vi
      .fn()
      .mockResolvedValueOnce({
        headers: { get: (name: string) => (name === "etag" ? "v1" : null) },
      })
      .mockResolvedValueOnce({
        headers: { get: (name: string) => (name === "etag" ? "v2" : null) },
      });
    vi.stubGlobal("fetch", fetchHead);

    const rendered = render(
      <DynamicViewLoader bundleUrl={bundleUrl} viewId="hmr.view" />,
    );
    await flushViewLoader();
    expect(screen.getByText("HMR version 1")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchHead).toHaveBeenCalledWith(bundleUrl, { method: "HEAD" });
    expect(screen.getByText("HMR version 1")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushViewLoader();

    expect(screen.getByText("HMR version 2")).toBeTruthy();
    expect(cleanupVersion1).toHaveBeenCalledTimes(1);
    expect(window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__).toHaveBeenCalledTimes(
      2,
    );

    sendWsMessage.mockClear();
    const { dispatchViewInteract } = await import("./view-interact-registry");
    await dispatchViewInteract(
      "hmr.view",
      "gui",
      "custom-capability",
      undefined,
      "req-hmr-interact",
    );
    expect(interactVersion2).toHaveBeenCalledWith(
      "custom-capability",
      undefined,
    );
    expect(interactVersion1).not.toHaveBeenCalled();
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-hmr-interact",
      success: true,
      result: { version: 2 },
    });

    fetchHead.mockClear();
    rendered.unmount();
    await act(async () => {
      vi.advanceTimersByTime(6000);
      await Promise.resolve();
    });
    expect(fetchHead).not.toHaveBeenCalled();
  });

  it("unregisters the previous interact handler when the loaded view is replaced", async () => {
    const cleanupFirst = vi.fn();
    const firstInteract = vi.fn(async () => ({ version: "first" }));
    const secondInteract = vi.fn(async () => ({ version: "second" }));
    const firstUrl = "https://capability.example.test/assets/first.js";
    const secondUrl = "https://capability.example.test/assets/second.js";

    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async (url) => {
      if (url === firstUrl) {
        return {
          default: function FirstPanel() {
            return <div>First dynamic panel</div>;
          },
          interact: firstInteract,
          cleanup: cleanupFirst,
        };
      }
      return {
        default: function SecondPanel() {
          return <div>Second dynamic panel</div>;
        },
        interact: secondInteract,
      };
    });

    const rendered = render(
      <DynamicViewLoader
        bundleUrl={firstUrl}
        viewId="replace.first"
        viewType="gui"
      />,
    );
    await screen.findByText("First dynamic panel");

    rendered.rerender(
      <DynamicViewLoader
        bundleUrl={secondUrl}
        viewId="replace.second"
        viewType="gui"
      />,
    );
    await screen.findByText("Second dynamic panel");

    const { dispatchViewInteract } = await import("./view-interact-registry");
    await dispatchViewInteract(
      "replace.first",
      "gui",
      "custom-capability",
      undefined,
      "req-old-view",
    );
    await dispatchViewInteract(
      "replace.second",
      "gui",
      "custom-capability",
      undefined,
      "req-new-view",
    );

    expect(firstInteract).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(secondInteract).toHaveBeenCalledWith(
        "custom-capability",
        undefined,
      );
    });
    expect(sendWsMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-old-view",
      }),
    );
    expect(sendWsMessage).toHaveBeenCalledWith({
      type: "view:interact:result",
      requestId: "req-new-view",
      success: true,
      result: { version: "second" },
    });
    expect(cleanupFirst).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("memorypressure"));
    await waitFor(() => expect(cleanupFirst).toHaveBeenCalledTimes(1));
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

  it("shows the recoverable card (never a blank screen) when the bundle import rejects, and Retry re-imports", async () => {
    // Mode 1: a rejected dynamic import (bundle 404 / network / fetch error)
    // must land on the SAME "Failed to load view" card with a working Retry —
    // not a blank/white render.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const bundleUrl = "https://capability.example.test/assets/network-fail.js";
    let attempt = 0;
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("Failed to fetch dynamically imported module");
      }
      return {
        default: function RecoveredPanel() {
          return <div>Network recovered v{attempt}</div>;
        },
      };
    });

    const { container } = render(
      <DynamicViewLoader bundleUrl={bundleUrl} viewId="network.view" />,
    );

    const retry = await screen.findByRole("button", { name: /retry/i });
    // The actual card is in the DOM (not an empty container).
    expect(screen.getByText("Failed to load view")).toBeTruthy();
    expect(screen.getByText("View ID: network.view")).toBeTruthy();
    expect(
      screen.getByText("Failed to fetch dynamically imported module"),
    ).toBeTruthy();
    expect(container.textContent).not.toBe("");

    await act(async () => {
      retry.click();
    });

    // Retry actually re-attempts the import — the fixed bundle mounts.
    await screen.findByText("Network recovered v2");
    expect(screen.queryByText("Failed to load view")).toBeNull();
    expect(window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__).toHaveBeenCalledTimes(
      2,
    );
    consoleError.mockRestore();
  });

  it("recovers a view that crashes at render when Retry re-imports a fixed bundle", async () => {
    // A render crash must not latch the ErrorBoundary forever: clicking Retry
    // evicts the cached module, bumps reloadKey (which re-keys the boundary so
    // its caught error clears), and re-imports — so a fixed bundle mounts.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const bundleUrl = "https://capability.example.test/assets/crashy.js";
    let importCount = 0;
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => {
      importCount += 1;
      const crashes = importCount === 1;
      return {
        default: function CrashyPanel() {
          if (crashes) {
            throw new Error("boom on first render");
          }
          return <div>Recovered panel v{importCount}</div>;
        },
      };
    });

    render(<DynamicViewLoader bundleUrl={bundleUrl} viewId="crashy.view" />);

    // First import renders a component that throws → ErrorBoundary fallback.
    const retry = await screen.findByRole("button", { name: /retry/i });
    expect(screen.getByText("Failed to load view")).toBeTruthy();
    expect(screen.getByRole("button", { name: /back to views/i })).toBeTruthy();

    await act(async () => {
      retry.click();
    });

    // Second import returns a component that renders cleanly.
    await screen.findByText("Recovered panel v2");
    expect(screen.queryByText("Failed to load view")).toBeNull();
    consoleError.mockRestore();
  });

  it("retains inactive bundles after unmount and cleans them up under pressure", async () => {
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
    expect(cleanupBundle).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("memorypressure"));
    await waitFor(() => expect(cleanupBundle).toHaveBeenCalledTimes(1));
  });

  it("retains then evicts a bundle that resolves after the loader has unmounted", async () => {
    const bundleUrl = "https://capability.example.test/assets/late.js";
    const cleanupLateBundle = vi.fn();
    let resolveImport:
      | ((module: { default: () => ReactElement; cleanup: () => void }) => void)
      | null = null;
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveImport = resolve;
        }),
    );

    const rendered = render(
      <DynamicViewLoader bundleUrl={bundleUrl} viewId="late.cleanup.view" />,
    );
    expect(screen.getByText("Loading view…")).toBeTruthy();

    rendered.unmount();
    expect(resolveImport).toBeTruthy();
    act(() => {
      resolveImport?.({
        default: function LatePanel() {
          return <div>Late panel</div>;
        },
        cleanup: cleanupLateBundle,
      });
    });

    await waitFor(() => expect(cleanupLateBundle).not.toHaveBeenCalled());
    window.dispatchEvent(new Event("memorypressure"));
    await waitFor(() => expect(cleanupLateBundle).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Late panel")).toBeNull();
  });

  it("cleans up a pending bundle that is evicted before import resolution", async () => {
    const bundleUrl = "https://capability.example.test/assets/late-pressure.js";
    const cleanupLateBundle = vi.fn();
    let resolveImport:
      | ((module: { default: () => ReactElement; cleanup: () => void }) => void)
      | null = null;
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveImport = resolve;
        }),
    );

    const rendered = render(
      <DynamicViewLoader bundleUrl={bundleUrl} viewId="late.pressure.view" />,
    );
    rendered.unmount();
    window.dispatchEvent(new Event("memorypressure"));

    act(() => {
      resolveImport?.({
        default: function LatePressurePanel() {
          return <div>Late pressure panel</div>;
        },
        cleanup: cleanupLateBundle,
      });
    });

    await waitFor(() => expect(cleanupLateBundle).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Late pressure panel")).toBeNull();
  });

  it("evicts inactive bundles on app pause and emits cache telemetry", async () => {
    const bundleUrl = "https://capability.example.test/assets/pause.js";
    const cleanupBundle = vi.fn();
    const events: ModuleCacheTelemetryEvent[] = [];
    const onTelemetry = (event: Event) => {
      events.push((event as CustomEvent<ModuleCacheTelemetryEvent>).detail);
    };
    window.addEventListener(MODULE_CACHE_TELEMETRY_EVENT, onTelemetry);
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function PausePanel() {
        return <div>Pause panel</div>;
      },
      cleanup: cleanupBundle,
    }));

    const rendered = render(
      <DynamicViewLoader bundleUrl={bundleUrl} viewId="pause.view" />,
    );
    await screen.findByText("Pause panel");
    rendered.unmount();

    document.dispatchEvent(new Event(APP_PAUSE_EVENT));
    await waitFor(() => expect(cleanupBundle).toHaveBeenCalledTimes(1));
    window.removeEventListener(MODULE_CACHE_TELEMETRY_EVENT, onTelemetry);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "dynamic-view",
          action: "load",
          key: `${bundleUrl}::default`,
        }),
        expect.objectContaining({
          source: "dynamic-view",
          action: "evict",
          reason: "app-pause",
          key: `${bundleUrl}::default`,
        }),
        expect.objectContaining({
          source: "dynamic-view",
          action: "cleanup",
          reason: "app-pause",
          key: `${bundleUrl}::default`,
        }),
      ]),
    );
  });

  it("removes global lifecycle listeners when the dynamic-view cache is reset", async () => {
    const bundleUrl = "https://capability.example.test/assets/listeners.js";
    const addWindowListener = vi.spyOn(window, "addEventListener");
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const addDocumentListener = vi.spyOn(document, "addEventListener");
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");

    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = vi.fn(async () => ({
      default: function ListenerPanel() {
        return <div>Listener panel</div>;
      },
    }));

    const rendered = render(
      <DynamicViewLoader bundleUrl={bundleUrl} viewId="listener.view" />,
    );
    await screen.findByText("Listener panel");
    rendered.unmount();

    const memoryPressureHandler = addWindowListener.mock.calls.find(
      ([name]) => name === "memorypressure",
    )?.[1];
    const visibilityHandler = addDocumentListener.mock.calls.find(
      ([name]) => name === "visibilitychange",
    )?.[1];
    const appPauseHandler = addDocumentListener.mock.calls.find(
      ([name]) => name === APP_PAUSE_EVENT,
    )?.[1];

    expect(memoryPressureHandler).toEqual(expect.any(Function));
    expect(visibilityHandler).toEqual(expect.any(Function));
    expect(appPauseHandler).toEqual(expect.any(Function));

    __resetDynamicViewLoaderCacheForTests();

    expect(removeWindowListener).toHaveBeenCalledWith(
      "memorypressure",
      memoryPressureHandler,
    );
    expect(removeDocumentListener).toHaveBeenCalledWith(
      "visibilitychange",
      visibilityHandler,
    );
    expect(removeDocumentListener).toHaveBeenCalledWith(
      APP_PAUSE_EVENT,
      appPauseHandler,
    );
  });
});
