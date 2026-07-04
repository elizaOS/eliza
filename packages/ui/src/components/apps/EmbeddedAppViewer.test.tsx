// @vitest-environment jsdom

/**
 * Covers `EmbeddedAppViewer`'s `*_READY` → auth postMessage handshake and its
 * origin-pinning: runs in jsdom with hand-dispatched `MessageEvent`s standing in
 * for the iframe, asserting the auth payload only posts to a verified origin.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddedAppViewer } from "./EmbeddedAppViewer";

const AUTH = {
  type: "FEED_AUTH" as const,
  authToken: "tok",
  sessionToken: "tok",
  agentId: "agent-1",
  characterId: "agent-1",
};

/**
 * jsdom drops a non-Window `source` passed to the MessageEvent constructor, so
 * set it explicitly to the stub iframe window the handshake checks against.
 */
function dispatchViewerMessage(
  source: Window,
  data: { type: string },
  origin: string,
): void {
  const event = new MessageEvent("message", { data, origin });
  Object.defineProperty(event, "source", { value: source, configurable: true });
  // Wrapped in act() so the handshake's setStatus is flushed to the DOM.
  act(() => {
    window.dispatchEvent(event);
  });
}

afterEach(cleanup);

describe("EmbeddedAppViewer", () => {
  it("renders the viewer iframe with the resolved src + sandbox", () => {
    render(
      <EmbeddedAppViewer
        viewerUrl="https://app.example/feed"
        sandbox="allow-scripts"
        title="Feed"
      />,
    );
    const iframe = screen.getByTestId("embedded-app-viewer-iframe");
    expect(iframe.getAttribute("src")).toBe("https://app.example/feed");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("title")).toBe("Feed");
  });

  it("posts the auth payload back only after the matching READY event from the viewer origin", () => {
    render(
      <EmbeddedAppViewer
        viewerUrl="https://app.example/feed"
        authMessage={AUTH}
        title="Feed"
      />,
    );
    const iframe = screen.getByTestId(
      "embedded-app-viewer-iframe",
    ) as HTMLIFrameElement;
    const post = vi.fn();
    // Stand in for the embedded app's window so the handshake can target it.
    Object.defineProperty(iframe, "contentWindow", {
      value: { postMessage: post } as unknown as Window,
      configurable: true,
    });

    // READY event from the correct origin, sourced from the iframe window.
    dispatchViewerMessage(
      iframe.contentWindow as Window,
      { type: "FEED_READY" },
      "https://app.example",
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(AUTH, "https://app.example");
    expect(iframe.getAttribute("data-viewer-status")).toBe("authenticated");
  });

  it("fails closed: never posts auth when the READY event origin does not match the viewer", () => {
    render(
      <EmbeddedAppViewer
        viewerUrl="https://app.example/feed"
        authMessage={AUTH}
        title="Feed"
      />,
    );
    const iframe = screen.getByTestId(
      "embedded-app-viewer-iframe",
    ) as HTMLIFrameElement;
    const post = vi.fn();
    Object.defineProperty(iframe, "contentWindow", {
      value: { postMessage: post } as unknown as Window,
      configurable: true,
    });

    dispatchViewerMessage(
      iframe.contentWindow as Window,
      { type: "FEED_READY" },
      "https://evil.example",
    );

    expect(post).not.toHaveBeenCalled();
    expect(iframe.getAttribute("data-viewer-status")).not.toBe("authenticated");
  });

  it("does not run the handshake when no auth payload is supplied", () => {
    render(
      <EmbeddedAppViewer viewerUrl="https://app.example/feed" title="X" />,
    );
    const iframe = screen.getByTestId(
      "embedded-app-viewer-iframe",
    ) as HTMLIFrameElement;
    const post = vi.fn();
    Object.defineProperty(iframe, "contentWindow", {
      value: { postMessage: post } as unknown as Window,
      configurable: true,
    });
    dispatchViewerMessage(
      iframe.contentWindow as Window,
      { type: "FEED_READY" },
      "https://app.example",
    );
    expect(post).not.toHaveBeenCalled();
  });
});
