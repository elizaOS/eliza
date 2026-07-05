// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetDynamicViewLoaderCacheForTests,
  DynamicViewLoader,
} from "./DynamicViewLoader";

describe("DynamicViewLoader sandboxed iframe document contract", () => {
  afterEach(() => {
    delete window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__;
    cleanup();
    __resetDynamicViewLoaderCacheForTests();
    vi.restoreAllMocks();
  });

  it("renders sandboxed-iframe views from frameUrl, never from the JavaScript bundleUrl", () => {
    const importBundle = vi.fn();
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = importBundle;

    render(
      <DynamicViewLoader
        bundleUrl="/api/views/sandboxed.view/bundle.js"
        frameUrl="/api/views/sandboxed.view/frame.html"
        viewId="sandboxed.view"
        surface={{
          isolation: "sandboxed-iframe",
          capabilities: ["navigate", "storage"],
        }}
      />,
    );

    const frame = screen.getByTestId(
      "sandboxed-view-frame-sandboxed.view",
    ) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(
      "/api/views/sandboxed.view/frame.html",
    );
    expect(frame.getAttribute("src")).not.toBe(
      "/api/views/sandboxed.view/bundle.js",
    );
    expect(frame.getAttribute("sandbox")?.split(" ")).toContain(
      "allow-scripts",
    );
    expect(importBundle).not.toHaveBeenCalled();
  });

  it("fails closed when a sandboxed-iframe view only has a JavaScript bundleUrl", () => {
    const importBundle = vi.fn();
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = importBundle;

    render(
      <DynamicViewLoader
        bundleUrl="/api/views/broken.sandbox/bundle.js"
        viewId="broken.sandbox"
        surface={{ isolation: "sandboxed-iframe" }}
      />,
    );

    expect(screen.getByText("Failed to load view")).toBeTruthy();
    expect(screen.getByText(/require a frameUrl HTML document/)).toBeTruthy();
    expect(
      screen.queryByTestId("sandboxed-view-frame-broken.sandbox"),
    ).toBeNull();
    expect(importBundle).not.toHaveBeenCalled();
  });
});
