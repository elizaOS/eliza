// @vitest-environment jsdom
//
// The REAL sandboxed-iframe isolation path (#14180). Mounts the actual
// SandboxedViewFrame, drives its parent-side postMessage broker exactly as a
// framed document would (a `message` event whose `source` is the real iframe
// `contentWindow`), and asserts the boundary holds: an ungranted `navigate`
// changes no shell route, an ungranted `storage` write touches no key, and the
// same requests WITH the grant are serviced. No stub stands in for the iframe or
// the broker — the frame's own listener services the message and posts the reply
// back through the frame window. Deleting the grant check in the broker turns the
// two negative-path assertions red (the ungranted requests would then fire the
// navigate event / write the storage key), so this is a genuine red→green guard.

import type { SurfaceManifest } from "@elizaos/core";
import { NAVIGATE_VIEW_EVENT } from "@elizaos/shared/events";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSandboxHostFacilities,
  SandboxedViewFrame,
  sandboxStorageKey,
} from "./SandboxedViewFrame";
import { SANDBOXED_VIEW_CHANNEL } from "./sandboxed-view-broker";

const VIEW_ID = "probe.view";
const GRANTED: SurfaceManifest = {
  isolation: "sandboxed-iframe",
  capabilities: ["navigate", "storage"],
};
const UNGRANTED: SurfaceManifest = {
  isolation: "sandboxed-iframe",
  capabilities: [],
};

/** Mount the frame and return its live iframe + a spy on the frame's postMessage. */
function mountFrame(surface: SurfaceManifest) {
  render(
    <SandboxedViewFrame
      viewId={VIEW_ID}
      surface={surface}
      srcDoc="<!doctype html><title>probe</title>"
      title="probe"
    />,
  );
  const iframe = screen.getByTestId(
    `sandboxed-view-frame-${VIEW_ID}`,
  ) as HTMLIFrameElement;
  const frameWindow = iframe.contentWindow;
  if (!frameWindow) throw new Error("iframe contentWindow missing in jsdom");
  const postSpy = vi
    .spyOn(frameWindow, "postMessage")
    .mockImplementation(() => {});
  return { iframe, frameWindow, postSpy };
}

/** Post a request into the parent AS the framed view (event.source === the frame). */
function postFromFrame(
  frameWindow: Window,
  capability: string,
  payload: unknown,
  requestId: string,
) {
  const event = new MessageEvent("message", {
    data: {
      channel: SANDBOXED_VIEW_CHANNEL,
      kind: "request",
      requestId,
      capability,
      payload,
    },
  });
  // jsdom does not populate `source` from the MessageEvent init, so bind it to
  // the real frame window — the identity the frame's listener gates on.
  Object.defineProperty(event, "source", { value: frameWindow });
  window.dispatchEvent(event);
}

function lastResponse(postSpy: ReturnType<typeof vi.spyOn>) {
  const calls = postSpy.mock.calls;
  return calls[calls.length - 1]?.[0] as {
    channel: string;
    kind: string;
    requestId: string;
    ok: boolean;
    result?: unknown;
    error?: string;
  };
}

describe("SandboxedViewFrame — real isolation path (#14180)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("renders a REAL sandbox: allow-scripts without allow-same-origin", () => {
    render(
      <SandboxedViewFrame
        viewId={VIEW_ID}
        surface={GRANTED}
        srcDoc="<!doctype html><title>x</title>"
        title="x"
      />,
    );
    const iframe = screen.getByTestId(
      `sandboxed-view-frame-${VIEW_ID}`,
    ) as HTMLIFrameElement;
    const sandbox = iframe.getAttribute("sandbox") ?? "";
    expect(sandbox.split(" ")).toContain("allow-scripts");
    expect(sandbox.split(" ")).not.toContain("allow-same-origin");
  });

  it("DENIES navigate without the grant — no shell route change, typed denial to the frame", async () => {
    const navSpy = vi.fn();
    window.addEventListener(NAVIGATE_VIEW_EVENT, navSpy);
    const { frameWindow, postSpy } = mountFrame(UNGRANTED);

    postFromFrame(frameWindow, "navigate", { viewId: "chat" }, "req-nav-deny");

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    const res = lastResponse(postSpy);
    expect(res.requestId).toBe("req-nav-deny");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not granted capability");
    // The route facility never fired — the shell did not navigate.
    expect(navSpy).not.toHaveBeenCalled();
    window.removeEventListener(NAVIGATE_VIEW_EVENT, navSpy);
  });

  it("DENIES storage without the grant — no key is written, typed denial to the frame", async () => {
    const { frameWindow, postSpy } = mountFrame(UNGRANTED);

    postFromFrame(
      frameWindow,
      "storage",
      { op: "set", key: "secret", value: "pwn" },
      "req-store-deny",
    );

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    expect(lastResponse(postSpy).ok).toBe(false);
    // No key — neither namespaced nor a raw shell key — was written.
    expect(window.localStorage.length).toBe(0);
  });

  it("SERVICES navigate with the grant — fires the shell navigate event", async () => {
    const navSpy = vi.fn();
    window.addEventListener(NAVIGATE_VIEW_EVENT, navSpy);
    const { frameWindow, postSpy } = mountFrame(GRANTED);

    postFromFrame(frameWindow, "navigate", { viewId: "chat" }, "req-nav-ok");

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    expect(lastResponse(postSpy).ok).toBe(true);
    await waitFor(() => expect(navSpy).toHaveBeenCalledTimes(1));
    const detail = (navSpy.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toMatchObject({ viewId: "chat" });
    window.removeEventListener(NAVIGATE_VIEW_EVENT, navSpy);
  });

  it("SERVICES storage with the grant — writes ONLY the view-namespaced key", async () => {
    const { frameWindow, postSpy } = mountFrame(GRANTED);

    postFromFrame(
      frameWindow,
      "storage",
      { op: "set", key: "draft", value: "hello" },
      "req-store-ok",
    );

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    expect(lastResponse(postSpy).ok).toBe(true);
    const namespaced = sandboxStorageKey(VIEW_ID, "draft");
    expect(window.localStorage.getItem(namespaced)).toBe("hello");
    // The only key written is the namespaced one — no bare "draft" shell key.
    expect(window.localStorage.getItem("draft")).toBeNull();
    expect(window.localStorage.length).toBe(1);
  });

  it("keeps colon-bearing view IDs and storage keys in distinct namespaces", async () => {
    const firstView = createSandboxHostFacilities("alpha:beta");
    const secondView = createSandboxHostFacilities("alpha");

    await firstView.storage({ op: "set", key: "draft", value: "one" });
    await secondView.storage({ op: "set", key: "beta:draft", value: "two" });

    expect(
      window.localStorage.getItem(sandboxStorageKey("alpha:beta", "draft")),
    ).toBe("one");
    expect(
      window.localStorage.getItem(sandboxStorageKey("alpha", "beta:draft")),
    ).toBe("two");
    expect(window.localStorage.length).toBe(2);
  });

  it("IGNORES a message that is not from this frame's window (identity gate)", async () => {
    const { postSpy } = mountFrame(GRANTED);
    // A message with no/other source must not drive the broker.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          channel: SANDBOXED_VIEW_CHANNEL,
          kind: "request",
          requestId: "spoof",
          capability: "navigate",
          payload: { viewId: "chat" },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("reports a bad payload as a typed failure with the grant (never a fake success)", async () => {
    const navSpy = vi.fn();
    window.addEventListener(NAVIGATE_VIEW_EVENT, navSpy);
    const { frameWindow, postSpy } = mountFrame(GRANTED);

    // Granted, but the payload is missing viewId — the facility throws, and the
    // broker translates it to an observable failure (not a navigate).
    postFromFrame(frameWindow, "navigate", {}, "req-bad");

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    const res = lastResponse(postSpy);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("viewId");
    expect(navSpy).not.toHaveBeenCalled();
    window.removeEventListener(NAVIGATE_VIEW_EVENT, navSpy);
  });
});
